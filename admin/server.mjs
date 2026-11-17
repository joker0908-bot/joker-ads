import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import multer from 'multer'
import { ensureDirs, LIVE_DIR, DRAFT_DIR, UPLOAD_DIR, PUBLIC_DIR, REPO_ROOT } from './lib/paths.mjs'
import {
  readDraft,
  writeDraft,
  writeLive,
  publishAll,
  syncDraftFromLive,
  readJson,
  readLive,
} from './lib/jsonStore.mjs'
import { publicApiSession, normalizeApiSession } from './lib/apiSession.mjs'
import { addAppPlacement, updateAppPlacements } from './lib/appPlacements.mjs'
import { getDb, id, now, hashPassword, writeLog } from './lib/db.mjs'
import { claimCustomer, readCustomerByToken, listCustomers, cardCookie, CARD_COOKIE } from './lib/customers.mjs'
import {
  publicCatalog,
  reserveOrder,
  attachPayOrder,
  failPayOrder,
  creditPaidOrder,
  listCustomerOrders,
  redeemVipDays,
  REDEEM_RULE,
} from './lib/wallet.mjs'
import {
  requireAuth,
  requireRead,
  requireWrite,
  handleLogin,
  handleLogout,
  handleChangePassword,
  sessionUser,
  clientIp,
  cookies,
  sessionCookie,
  loadTotp,
} from './lib/auth.mjs'
import {
  getVideo,
  isHuangguoId,
  listCategories,
  listVideos,
  mediaFileFor,
  mimeFor,
  verifyPlayToken,
  writeCover,
  writePlaylist,
  writeSegment,
} from './lib/siteVideos.mjs'
import * as dewuApi from './lib/dewuApi.mjs'
import * as dewuVideos from './lib/dewuVideos.mjs'
import { createDramaApiKey, deleteDramaApiKey, dramaKeyAllows, listDramaApiKeys, setDramaApiKeyPaused, touchKeyUsed } from './lib/dramaApiKey.mjs'

const HOST = process.env.ADMIN_HOST || '127.0.0.1'
const PORT = Number(process.env.ADMIN_PORT || 8790)
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif'])

ensureDirs()
getDb()

const app = express()
app.set('trust proxy', true)
app.use(express.json({ limit: '4mb' }))

const storage = multer.diskStorage({
  destination(req, _file, cb) {
    const kind = String(req.query.kind || 'popup')
    const dir = path.join(UPLOAD_DIR, kind === 'icon' ? 'icons' : kind === 'promo' ? 'promo' : 'popups')
    fs.mkdirSync(dir, { recursive: true })
    cb(null, dir)
  },
  filename(_req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase()
    cb(null, `${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`)
  },
})

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase()
    if (!IMAGE_EXTS.has(ext)) return cb(new Error('仅支持图片上传'))
    cb(null, true)
  },
})

function seedFromRepoIfEmpty() {
  const liveConfig = path.join(LIVE_DIR, 'config.json')
  if (fs.existsSync(liveConfig)) return
  const srcData = path.join(REPO_ROOT, 'src', 'data')
  for (const name of ['config.json', 'popups.json', 'tabs.json', 'api-session.json']) {
    const src = path.join(srcData, name)
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(LIVE_DIR, name))
      fs.copyFileSync(src, path.join(DRAFT_DIR, name))
    }
  }
  writeDraft('meta.json', { version: 1, publishedAt: now() })
  syncDraftFromLive()
}

seedFromRepoIfEmpty()
if (!readDraft('meta.json')) writeDraft('meta.json', readLive('meta.json') || { version: 1 })

function sameJson(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

function draftChanges() {
  const draft = {
    config: readDraft('config.json') || {},
    popups: readDraft('popups.json') || {},
    tabs: readDraft('tabs.json') || {},
  }
  const live = {
    config: readLive('config.json') || {},
    popups: readLive('popups.json') || {},
    tabs: readLive('tabs.json') || {},
  }
  const slices = [
    ['进站弹窗', draft.popups.afterEnterApp, live.popups.afterEnterApp],
    ['网格弹窗', draft.popups.gridPopAds, live.popups.gridPopAds],
    ['顶部促销', draft.config.promo, live.config.promo],
    ['悬浮条', draft.config.floatBanner, live.config.floatBanner],
    ['应用列表', draft.config.apps, live.config.apps],
    ['分类', { categories: draft.config.categories, categoryApps: draft.config.categoryApps }, { categories: live.config.categories, categoryApps: live.config.categoryApps }],
    ['精选广告', draft.tabs.featured?.ad, live.tabs.featured?.ad],
    ['我的页应用', draft.tabs.mine?.quickApps, live.tabs.mine?.quickApps],
  ]
  const changes = slices.filter(([, left, right]) => !sameJson(left, right)).map(([label]) => label)
  const fileDirty = ['config.json', 'popups.json', 'tabs.json'].some((name) => !sameJson(readDraft(name), readLive(name)))
  if (fileDirty && !changes.length) changes.push('其他站点设置')
  return { dirty: changes.length > 0, changes }
}

function getBundle() {
  return {
    config: readDraft('config.json') || {},
    popups: readDraft('popups.json') || {},
    tabs: readDraft('tabs.json') || {},
    meta: readDraft('meta.json') || { version: 1 },
    publish: draftChanges(),
  }
}

function saveBundle(part, value) {
  if (part === 'config') writeDraft('config.json', value)
  else if (part === 'popups') writeDraft('popups.json', value)
  else if (part === 'tabs') writeDraft('tabs.json', value)
  else throw new Error('unknown part')
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'ads-king-admin' })
})

app.use('/data', express.static(LIVE_DIR, { etag: true, maxAge: 0, setHeaders(res) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
}}))

app.use('/uploads', express.static(UPLOAD_DIR, { etag: true, maxAge: '30d' }))

app.post('/api/public/customers/claim', (req, res) => {
  try {
    const cookieToken = cookies(req)[CARD_COOKIE] || ''
    const result = claimCustomer({
      deviceFp: req.body?.deviceFp,
      inviteCode: req.body?.inviteCode,
      cardToken: String(req.body?.cardToken || cookieToken || ''),
    })
    res.setHeader('Set-Cookie', cardCookie(result.token, req))
    res.json({
      ok: true,
      customerId: result.customerId,
      cardNo: result.cardNo,
      inviteCode: result.inviteCode,
      invitedBy: result.invitedBy,
      inviteCount: result.inviteCount || 0,
      isNew: result.isNew,
      token: result.token,
    })
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message || '签发失败' })
  }
})

app.get('/api/public/customers/me', (req, res) => {
  const token = String(req.query.token || cookies(req)[CARD_COOKIE] || '')
  const row = readCustomerByToken(token)
  if (!row) return res.status(404).json({ error: '未找到身份卡' })
  res.json({ ok: true, ...row })
})

function payInternalOk(req) {
  const expected = String(process.env.PAY_INTERNAL_TOKEN || '')
  const got = String(req.get('x-pay-internal') || '')
  if (!expected || expected.length < 16 || got.length !== expected.length) return false
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))
}

function customerFromPayBody(req) {
  const token = String(req.body?.cardToken || cookies(req)[CARD_COOKIE] || '')
  return readCustomerByToken(token)
}

function videoError(res, e) {
  const status = Number(e?.status) || 500
  res.status(status).json({
    ok: false,
    error: e?.message || '加载失败',
    code: e?.code || 'upstream',
  })
}

function dewuError(res, e) {
  const status = Number(e?.status) || 500
  res.status(status).json({
    code: status,
    message: e?.message || '加载失败',
    error: e?.code || 'upstream',
  })
}

function dewuCors(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type, X-Api-Key, Authorization')
  if (req.method === 'OPTIONS') return res.status(204).end()
  next()
}

function requireSuper(req, res, next) {
  if (req.admin?.role !== 'super') return res.status(403).json({ error: '仅超管可操作' })
  next()
}

function readRequestKey(req) {
  const header = String(req.headers['x-api-key'] || '').trim()
  if (header) return header
  const auth = String(req.headers.authorization || '').trim()
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim()
  return String(req.query.key || '').trim()
}

const dewuRateLimit = new Map()
const DEWU_RATE_PER_MIN = Math.max(30, Number(process.env.DEWU_API_RATE_PER_MIN || 300))

function dewuRateOk(key) {
  const now = Date.now()
  let row = dewuRateLimit.get(key)
  if (!row || now - row.windowStart > 60_000) {
    row = { windowStart: now, count: 0 }
    dewuRateLimit.set(key, row)
  }
  row.count += 1
  if (dewuRateLimit.size > 5000) {
    for (const [k, v] of dewuRateLimit) {
      if (now - v.windowStart > 120_000) dewuRateLimit.delete(k)
    }
  }
  return row.count <= DEWU_RATE_PER_MIN
}

function dewuRequireKey(req, res, next) {
  if (req.method === 'OPTIONS') return next()
  if (req.path === '/api/seg' || req.path === '/api/vseg') return next()
  const key = readRequestKey(req)
  if (!dramaKeyAllows(key, 'dewu')) {
    return res.status(401).json({ code: 401, message: '需要 API Key', error: 'unauthorized' })
  }
  touchKeyUsed(key)
  if (!dewuRateOk(key)) {
    return res.status(429).json({ code: 429, message: '请求过于频繁', error: 'rate_limited' })
  }
  next()
}

app.use('/dewu-api', dewuCors)
app.use('/dewu-api', dewuRequireKey)

app.get('/dewu-api/api/shows', async (req, res) => {
  try {
    res.json({ code: 200, data: await dewuApi.listShows({ size: req.query.size }) })
  } catch (e) {
    dewuError(res, e)
  }
})

app.get('/dewu-api/api/show/:id', async (req, res) => {
  try {
    res.json({ code: 200, data: await dewuApi.getShow(req.params.id) })
  } catch (e) {
    dewuError(res, e)
  }
})

app.get('/dewu-api/api/cover/:id', async (req, res) => {
  try {
    const ok = await dewuApi.writeShowCover(req.params.id, res)
    if (!ok) return res.status(404).json({ code: 404, message: '该视频暂不可用', error: 'not_found' })
  } catch (e) {
    dewuError(res, e)
  }
})

app.get('/dewu-api/api/seg', async (req, res) => {
  try {
    const ok = await dewuApi.writeShowSegment(req.query.id, req.query.p, req.query.exp, req.query.sig, res)
    if (!ok) return res.status(404).json({ code: 404, message: '该视频暂不可用', error: 'unavailable' })
  } catch (e) {
    dewuError(res, e)
  }
})

app.get('/dewu-api/api/video/:id/:epId', async (req, res) => {
  try {
    await dewuApi.writePlaylist(req.params.id, req.params.epId, res)
  } catch (e) {
    dewuError(res, e)
  }
})

app.get('/dewu-api/api/videos', async (req, res) => {
  try {
    const out = await dewuVideos.listVideos(req.query)
    res.json({
      code: 200,
      data: out.items,
      total: out.total,
      page: out.page,
      pageSize: out.pageSize,
      enriched: out.enriched,
      complete: out.complete,
      updatedAt: out.updatedAt,
    })
  } catch (e) {
    dewuError(res, e)
  }
})

app.get('/dewu-api/api/videos/tags', async (req, res) => {
  try {
    res.json({ code: 200, data: await dewuVideos.listVideoTags() })
  } catch (e) {
    dewuError(res, e)
  }
})

app.get('/dewu-api/api/videos/categories', async (req, res) => {
  try {
    res.json({ code: 200, data: await dewuVideos.listVideoCategories() })
  } catch (e) {
    dewuError(res, e)
  }
})

app.get('/dewu-api/api/shorts', async (req, res) => {
  try {
    const out = await dewuVideos.listShorts(req.query)
    res.json({ code: 200, data: out.items, page: out.page, pageSize: out.pageSize })
  } catch (e) {
    dewuError(res, e)
  }
})

app.get('/dewu-api/api/skits', async (req, res) => {
  try {
    const out = await dewuVideos.listSkits(req.query)
    res.json({
      code: 200,
      data: out.items,
      total: out.total,
      page: out.page,
      pageSize: out.pageSize,
      complete: out.complete,
      updatedAt: out.updatedAt,
    })
  } catch (e) {
    dewuError(res, e)
  }
})

app.get('/dewu-api/api/skits/tags', async (req, res) => {
  try {
    res.json({ code: 200, data: await dewuVideos.listSkitTags() })
  } catch (e) {
    dewuError(res, e)
  }
})

app.get('/dewu-api/api/skits/categories', async (req, res) => {
  try {
    res.json({ code: 200, data: await dewuVideos.listSkitCategories() })
  } catch (e) {
    dewuError(res, e)
  }
})

app.get('/dewu-api/api/skits/:id/play', async (req, res) => {
  try {
    await dewuVideos.writeSkitPlaylist(req.params.id, req.query.ep, req.query.mode, res)
  } catch (e) {
    dewuError(res, e)
  }
})

app.get('/dewu-api/api/skits/:id/cover', async (req, res) => {
  try {
    const ok = await dewuVideos.writeSkitCover(req.params.id, res)
    if (!ok) return res.status(404).json({ code: 404, message: '该视频暂不可用', error: 'not_found' })
  } catch (e) {
    dewuError(res, e)
  }
})

app.get('/dewu-api/api/skits/:id', async (req, res) => {
  try {
    res.json({ code: 200, data: await dewuVideos.getSkit(req.params.id) })
  } catch (e) {
    dewuError(res, e)
  }
})

app.get('/dewu-api/api/videos/:id/play', async (req, res) => {
  try {
    await dewuVideos.writePlaylist(req.params.id, req.query.mode, res)
  } catch (e) {
    dewuError(res, e)
  }
})

app.get('/dewu-api/api/videos/:id/cover', async (req, res) => {
  try {
    const ok = await dewuVideos.writeCover(req.params.id, res)
    if (!ok) return res.status(404).json({ code: 404, message: '该视频暂不可用', error: 'not_found' })
  } catch (e) {
    dewuError(res, e)
  }
})

app.get('/dewu-api/api/vseg', async (req, res) => {
  try {
    dewuVideos.verifySeg(req.query.u, req.query.exp, req.query.sig)
    await dewuVideos.proxyMedia(req.query.u, res)
  } catch (e) {
    dewuError(res, e)
  }
})

app.get('/dewu-api/api/videos/:id', async (req, res) => {
  try {
    const detail = await dewuVideos.getVideo(req.params.id)
    const { _playUrl, _previewUrl, _coverPath, ...pub } = detail
    res.json({ code: 200, data: pub })
  } catch (e) {
    dewuError(res, e)
  }
})

app.get('/api/public/videos/categories', async (_req, res) => {
  try {
    res.json({ ok: true, categories: await listCategories() })
  } catch (e) {
    videoError(res, e)
  }
})

app.get('/api/public/videos', async (req, res) => {
  try {
    res.json(await listVideos({
      category: req.query.category,
      q: req.query.q,
      page: req.query.page,
      pageSize: req.query.pageSize,
    }))
  } catch (e) {
    videoError(res, e)
  }
})

app.get('/api/public/videos/:id/media', async (req, res) => {
  try {
    verifyPlayToken(req.params.id, req.query.exp, req.query.sig)
    if (isHuangguoId(req.params.id)) {
      await writePlaylist(req.params.id, req.query.ep, req.query.exp, req.query.sig, res)
      return
    }
    const file = mediaFileFor(req.params.id)
    if (!file) return res.status(404).json({ ok: false, error: '该视频暂不可用', code: 'unavailable' })
    res.setHeader('Cache-Control', 'private, no-store')
    res.sendFile(file, { headers: { 'Content-Type': mimeFor(file) } })
  } catch (e) {
    videoError(res, e)
  }
})

app.get('/api/public/videos/:id/seg', async (req, res) => {
  try {
    verifyPlayToken(req.params.id, req.query.exp, req.query.sig)
    const ok = await writeSegment(req.params.id, req.query.p, res)
    if (!ok) return res.status(404).json({ ok: false, error: '该视频暂不可用', code: 'unavailable' })
  } catch (e) {
    videoError(res, e)
  }
})

app.get('/api/public/videos/:id/cover', async (req, res) => {
  try {
    const ok = await writeCover(req.params.id, res)
    if (!ok) return res.status(404).json({ ok: false, error: '该视频暂不可用', code: 'not_found' })
  } catch (e) {
    videoError(res, e)
  }
})

app.get('/api/public/videos/:id', async (req, res) => {
  try {
    res.json(await getVideo(req.params.id, { episode: req.query.ep }))
  } catch (e) {
    videoError(res, e)
  }
})

app.get('/api/public/pay/catalog', (_req, res) => {
  res.json({ ok: true, packages: publicCatalog(), redeem: REDEEM_RULE })
})

app.post('/api/public/pay/redeem', (req, res) => {
  try {
    const customer = customerFromPayBody(req)
    if (!customer) return res.status(401).json({ ok: false, message: '请先领取身份卡' })
    res.json(redeemVipDays({
      customerId: customer.customerId,
      days: req.body?.days,
      requestId: req.body?.requestId,
    }))
  } catch (e) {
    res.status(e.status || 400).json({ ok: false, message: e.message || '兑换失败' })
  }
})

app.get('/api/public/pay/orders', (req, res) => {
  const token = String(req.query.token || cookies(req)[CARD_COOKIE] || '')
  const row = readCustomerByToken(token)
  if (!row) return res.status(401).json({ ok: false, message: '请先领取身份卡' })
  res.json({ ok: true, orders: listCustomerOrders(row.customerId) })
})

app.post('/api/internal/pay/reserve', (req, res) => {
  if (!payInternalOk(req)) return res.status(403).json({ ok: false, message: 'forbidden' })
  try {
    const customer = customerFromPayBody(req)
    if (!customer) return res.status(401).json({ ok: false, message: '请先领取身份卡' })
    res.json({ ok: true, customerId: customer.customerId, ...reserveOrder({
      customerId: customer.customerId,
      packageId: req.body?.packageId,
      productId: req.body?.productId,
    }) })
  } catch (e) {
    res.status(e.status || 400).json({ ok: false, message: e.message || '下单失败' })
  }
})

app.post('/api/internal/pay/attach', (req, res) => {
  if (!payInternalOk(req)) return res.status(403).json({ ok: false, message: 'forbidden' })
  try {
    res.json(attachPayOrder({ mchOrderNo: req.body?.mchOrderNo, payOrderId: req.body?.payOrderId }))
  } catch (e) {
    res.status(e.status || 400).json({ ok: false, message: e.message || '记录失败' })
  }
})

app.post('/api/internal/pay/fail', (req, res) => {
  if (!payInternalOk(req)) return res.status(403).json({ ok: false, message: 'forbidden' })
  res.json(failPayOrder({ mchOrderNo: req.body?.mchOrderNo, reason: req.body?.reason }))
})

app.post('/api/internal/pay/credit', (req, res) => {
  if (!payInternalOk(req)) return res.status(403).json({ ok: false, message: 'forbidden' })
  try {
    res.json(creditPaidOrder({
      mchOrderNo: req.body?.mchOrderNo,
      payOrderId: req.body?.payOrderId,
      amountFen: req.body?.amountFen,
    }))
  } catch (e) {
    res.status(e.status || 400).json({ ok: false, message: e.message || '入账失败' })
  }
})

app.get('/api/admin/customers', requireAuth, requireRead('customers'), (req, res) => {
  const limit = Math.min(200, Math.max(10, Number(req.query.limit || 50)))
  const offset = Math.max(0, Number(req.query.offset || 0))
  res.json(listCustomers({ limit, offset }))
})

app.post('/api/public/ad-click', (req, res) => {
  const db = getDb()
  db.prepare(`
    INSERT INTO ad_events (id, slot, item_name, event_type, url, ip, user_agent, created_at)
    VALUES (?, ?, ?, 'click', ?, ?, ?, ?)
  `).run(
    id('evt'),
    String(req.body?.slot || '').slice(0, 80),
    String(req.body?.name || '').slice(0, 120),
    String(req.body?.url || '').slice(0, 500),
    clientIp(req),
    String(req.headers['user-agent'] || '').slice(0, 500),
    now(),
  )
  res.json({ ok: true })
})

app.post('/api/admin/login', handleLogin)
app.get('/api/admin/me', (req, res) => {
  const user = sessionUser(req)
  if (!user) return res.status(401).json({ error: '未登录' })
  res.json({ user })
})
app.post('/api/admin/logout', requireAuth, handleLogout)
app.post('/api/admin/change-password', requireAuth, handleChangePassword)

app.get('/api/admin/dashboard', requireAuth, requireRead('dashboard'), (req, res) => {
  const db = getDb()
  const clicksToday = db.prepare(`SELECT COUNT(*) AS c FROM ad_events WHERE event_type = 'click' AND created_at >= date('now')`).get().c
  const clicksTotal = db.prepare(`SELECT COUNT(*) AS c FROM ad_events WHERE event_type = 'click'`).get().c
  const customersTotal = db.prepare('SELECT COUNT(*) AS c FROM customers').get().c
  const logs = db.prepare('SELECT * FROM operation_logs ORDER BY created_at DESC LIMIT 10').all()
  const bundle = getBundle()
  res.json({
    stats: {
      apps: (bundle.config.apps || []).length,
      popups: (bundle.popups.afterEnterApp || []).length,
      gridPopups: (bundle.popups.gridPopAds || []).length,
      clicksToday,
      clicksTotal,
      customersTotal,
      version: bundle.meta?.version || 1,
    },
    logs,
  })
})

app.get('/api/admin/site-config', requireAuth, requireRead('popups'), (_req, res) => {
  res.json(getBundle())
})

app.get('/api/admin/drama-api-keys', requireAuth, requireRead('settings'), requireSuper, (req, res) => {
  writeLog({ admin: req.admin, action: '查看短剧 API Key', targetType: 'drama-api-key', ip: clientIp(req) })
  res.json({ ok: true, keys: listDramaApiKeys() })
})

app.post('/api/admin/drama-api-keys', requireAuth, requireWrite('settings'), requireSuper, (req, res) => {
  try {
    const row = createDramaApiKey({ remark: req.body?.remark, scopes: req.body?.scopes })
    writeLog({
      admin: req.admin,
      action: '新建短剧 API Key',
      targetType: 'drama-api-key',
      targetId: row.id,
      detail: `${row.remark} ${row.scopes.join('+')}`,
      ip: clientIp(req),
    })
    res.json({ ok: true, key: row })
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : '创建失败' })
  }
})

app.post('/api/admin/drama-api-keys/:id', requireAuth, requireWrite('settings'), requireSuper, (req, res) => {
  const row = setDramaApiKeyPaused(req.params.id, req.body?.paused)
  if (!row) return res.status(404).json({ error: '钥匙不存在' })
  writeLog({
    admin: req.admin,
    action: row.paused ? '暂停短剧 API Key' : '恢复短剧 API Key',
    targetType: 'drama-api-key',
    targetId: row.id,
    detail: row.remark,
    ip: clientIp(req),
  })
  res.json({ ok: true })
})

app.delete('/api/admin/drama-api-keys/:id', requireAuth, requireWrite('settings'), requireSuper, (req, res) => {
  const row = deleteDramaApiKey(req.params.id)
  if (!row) return res.status(404).json({ error: '钥匙不存在' })
  writeLog({
    admin: req.admin,
    action: '删除短剧 API Key',
    targetType: 'drama-api-key',
    targetId: row.id,
    detail: row.remark,
    ip: clientIp(req),
  })
  res.json({ ok: true })
})

app.get('/api/admin/api-session', requireAuth, requireRead('settings'), (_req, res) => {
  const draft = readDraft('api-session.json') || {}
  const live = readLive('api-session.json') || {}
  res.json({
    draft: publicApiSession(draft),
    live: publicApiSession(live),
  })
})

app.put('/api/admin/api-session', requireAuth, requireWrite('settings'), (req, res) => {
  try {
    const previous = readDraft('api-session.json') || readLive('api-session.json') || {}
    const next = normalizeApiSession(req.body || {}, previous)
    writeDraft('api-session.json', next)
    writeLive('api-session.json', next)
    const meta = readDraft('meta.json') || readLive('meta.json') || { version: 0 }
    meta.version = Number(meta.version || 0) + 1
    meta.publishedAt = now()
    writeLive('meta.json', meta)
    writeDraft('meta.json', meta)
    writeLog({
      admin: req.admin,
      action: '轮换原站 token',
      targetType: 'api-session',
      detail: `uid=${next.uid} len=${next.token.length}`,
      ip: clientIp(req),
    })
    res.json({ ok: true, session: publicApiSession(next), meta })
  } catch (err) {
    res.status(400).json({ error: err.message || 'token 无效' })
  }
})

app.put('/api/admin/site-config/:part', requireAuth, requireWrite('popups'), (req, res) => {
  const part = req.params.part
  if (!['config', 'popups', 'tabs'].includes(part)) return res.status(400).json({ error: 'invalid part' })
  saveBundle(part, req.body || {})
  writeLog({ admin: req.admin, action: `更新草稿 ${part}`, targetType: part, ip: clientIp(req) })
  res.json({ ok: true })
})

app.put('/api/admin/slots/:slotKey', requireAuth, requireWrite('popups'), (req, res) => {
  const { slotKey } = req.params
  const items = req.body?.items
  const bundle = getBundle()

  if (slotKey === 'afterEnterApp' || slotKey === 'gridPopAds' || slotKey === 'actPopAds') {
    bundle.popups[slotKey] = items || []
    saveBundle('popups', bundle.popups)
  } else if (slotKey === 'configPopups') {
    bundle.config.popups = items || []
    saveBundle('config', bundle.config)
  } else if (slotKey === 'promo') {
    bundle.config.promo = { ...(bundle.config.promo || {}), ...(req.body || {}) }
    saveBundle('config', bundle.config)
  } else if (slotKey === 'floatBanner') {
    bundle.config.floatBanner = { ...(bundle.config.floatBanner || {}), ...(req.body || {}) }
    saveBundle('config', bundle.config)
  } else if (slotKey === 'featuredAd') {
    bundle.tabs.featured = bundle.tabs.featured || {}
    bundle.tabs.featured.ad = { ...(bundle.tabs.featured.ad || {}), ...(req.body || {}) }
    saveBundle('tabs', bundle.tabs)
  } else if (slotKey === 'mineQuickApps') {
    bundle.tabs.mine = bundle.tabs.mine || {}
    bundle.tabs.mine.quickApps = items || []
    saveBundle('tabs', bundle.tabs)
  } else {
    return res.status(400).json({ error: 'unknown slot' })
  }

  writeLog({ admin: req.admin, action: `编辑广告位 ${slotKey}`, targetType: 'slot', targetId: slotKey, ip: clientIp(req) })
  res.json({ ok: true })
})

app.get('/api/admin/apps', requireAuth, requireRead('apps'), (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase()
  const page = Math.max(1, Number(req.query.page || 1))
  const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize || 30)))
  let apps = getBundle().config.apps || []
  if (q) apps = apps.filter((a) => String(a.name || '').toLowerCase().includes(q) || String(a.url || '').toLowerCase().includes(q))
  const total = apps.length
  const start = (page - 1) * pageSize
  res.json({ apps: apps.slice(start, start + pageSize), total, page, pageSize })
})

app.post('/api/admin/apps', requireAuth, requireWrite('apps'), (req, res) => {
  const appItem = req.body || {}
  const name = String(appItem.name || '').trim()
  if (!name) return res.status(400).json({ error: '请填写应用名称' })
  const bundle = getBundle()
  bundle.config.apps = bundle.config.apps || []
  if (bundle.config.apps.some((a) => a.name === name)) return res.status(409).json({ error: '应用名称已存在' })
  bundle.config.apps.unshift({
    name,
    url: String(appItem.url || ''),
    signUrl: String(appItem.signUrl || ''),
    icon: String(appItem.icon || '/icons/placeholder.png'),
  })
  addAppPlacement(bundle.config, name)
  saveBundle('config', bundle.config)
  writeLog({ admin: req.admin, action: `新增应用 ${name}`, targetType: 'apps', targetId: name, ip: clientIp(req) })
  res.json({ ok: true })
})

app.put('/api/admin/apps/:name', requireAuth, requireWrite('apps'), (req, res) => {
  const oldName = decodeURIComponent(req.params.name)
  const body = req.body || {}
  const bundle = getBundle()
  const idx = (bundle.config.apps || []).findIndex((a) => a.name === oldName)
  if (idx === -1) return res.status(404).json({ error: '应用不存在' })
  const nextName = String(body.name || oldName).trim()
  if (!nextName) return res.status(400).json({ error: '请填写应用名称' })
  if (nextName !== oldName && bundle.config.apps.some((a) => a.name === nextName)) {
    return res.status(409).json({ error: '应用名称已存在' })
  }
  bundle.config.apps[idx] = {
    ...bundle.config.apps[idx],
    ...body,
    name: nextName,
  }
  if (nextName !== oldName) updateAppPlacements(bundle.config, oldName, nextName)
  saveBundle('config', bundle.config)
  writeLog({ admin: req.admin, action: `编辑应用 ${nextName}`, targetType: 'apps', targetId: nextName, ip: clientIp(req) })
  res.json({ ok: true })
})

app.delete('/api/admin/apps/:name', requireAuth, requireWrite('apps'), (req, res) => {
  const name = decodeURIComponent(req.params.name)
  const bundle = getBundle()
  bundle.config.apps = (bundle.config.apps || []).filter((a) => a.name !== name)
  updateAppPlacements(bundle.config, name)
  saveBundle('config', bundle.config)
  writeLog({ admin: req.admin, action: `删除应用 ${name}`, targetType: 'apps', targetId: name, ip: clientIp(req) })
  res.json({ ok: true })
})

app.get('/api/admin/category-apps', requireAuth, requireRead('categories'), (_req, res) => {
  res.json({ categoryApps: getBundle().config.categoryApps || {}, categories: getBundle().config.categories || [] })
})

app.put('/api/admin/category-apps', requireAuth, requireWrite('categories'), (req, res) => {
  const bundle = getBundle()
  bundle.config.categoryApps = req.body?.categoryApps || bundle.config.categoryApps || {}
  if (Array.isArray(req.body?.categories)) bundle.config.categories = req.body.categories
  saveBundle('config', bundle.config)
  writeLog({ admin: req.admin, action: '更新分类应用映射', targetType: 'categoryApps', ip: clientIp(req) })
  res.json({ ok: true })
})

app.post('/api/admin/publish', requireAuth, requireWrite('publish'), (req, res) => {
  const meta = publishAll()
  writeLog({ admin: req.admin, action: '发布站点配置', targetType: 'publish', detail: `v${meta.version}`, ip: clientIp(req) })
  res.json({ ok: true, meta })
})

app.post('/api/admin/discard-draft', requireAuth, requireWrite('publish'), (_req, res) => {
  syncDraftFromLive()
  res.json({ ok: true, bundle: getBundle() })
})

app.post('/api/admin/upload', requireAuth, requireWrite('upload'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未收到文件' })
  const kind = String(req.query.kind || 'popup')
  const sub = kind === 'icon' ? 'icons' : kind === 'promo' ? 'promo' : 'popups'
  const url = `/uploads/${sub}/${req.file.filename}`
  writeLog({ admin: req.admin, action: `上传素材 ${url}`, targetType: 'upload', targetId: url, ip: clientIp(req) })
  res.json({ ok: true, url })
})

app.get('/api/admin/logs', requireAuth, requireRead('logs'), (req, res) => {
  const limit = Math.min(500, Math.max(10, Number(req.query.limit || 100)))
  const logs = getDb().prepare('SELECT * FROM operation_logs ORDER BY created_at DESC LIMIT ?').all(limit)
  res.json({ logs })
})

app.get('/api/admin/logs/export', requireAuth, requireRead('logs'), (_req, res) => {
  const logs = getDb().prepare('SELECT * FROM operation_logs ORDER BY created_at DESC LIMIT 2000').all()
  const header = 'time,admin,action,target_type,target_id,detail,ip\n'
  const rows = logs.map((r) =>
    [r.created_at, r.admin_name, r.action, r.target_type, r.target_id, JSON.stringify(r.detail || ''), r.ip]
      .map((v) => `"${String(v || '').replace(/"/g, '""')}"`)
      .join(','),
  )
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', 'attachment; filename="operation-logs.csv"')
  res.send('\ufeff' + header + rows.join('\n'))
})

app.get('/api/admin/stats', requireAuth, requireRead('stats'), (_req, res) => {
  const db = getDb()
  const bySlot = db.prepare(`
    SELECT slot, COUNT(*) AS clicks
    FROM ad_events WHERE event_type = 'click'
    GROUP BY slot ORDER BY clicks DESC LIMIT 20
  `).all()
  const daily = db.prepare(`
    SELECT date(created_at) AS day, COUNT(*) AS clicks
    FROM ad_events WHERE event_type = 'click'
    GROUP BY day ORDER BY day DESC LIMIT 14
  `).all()
  res.json({ bySlot, daily })
})

app.post('/api/admin/totp/setup', requireAuth, requireWrite('settings'), async (req, res) => {
  const totp = await loadTotp()
  const secret = totp.generateSecret()
  getDb().prepare('UPDATE admins SET totp_secret = ?, totp_enabled = 0, updated_at = ? WHERE id = ?').run(secret, now(), req.admin.id)
  res.json({
    secret,
    otpauth: totp.otpauthUrl({ secret, issuer: '得污后台', account: req.admin.username }),
  })
})

app.post('/api/admin/totp/enable', requireAuth, requireWrite('settings'), async (req, res) => {
  const code = String(req.body?.code || '').trim()
  const row = getDb().prepare('SELECT * FROM admins WHERE id = ?').get(req.admin.id)
  const totp = await loadTotp()
  if (!row?.totp_secret || !totp.verifyTotp(row.totp_secret, code)) {
    return res.status(400).json({ error: '验证码错误' })
  }
  getDb().prepare('UPDATE admins SET totp_enabled = 1, updated_at = ? WHERE id = ?').run(now(), req.admin.id)
  writeLog({ admin: req.admin, action: '启用 2FA', targetType: 'settings', ip: clientIp(req) })
  res.json({ ok: true })
})

app.post('/api/admin/totp/disable', requireAuth, requireWrite('settings'), async (req, res) => {
  const code = String(req.body?.code || '').trim()
  const row = getDb().prepare('SELECT * FROM admins WHERE id = ?').get(req.admin.id)
  const totp = await loadTotp()
  if (row?.totp_enabled && !totp.verifyTotp(row.totp_secret, code)) {
    return res.status(400).json({ error: '验证码错误' })
  }
  getDb().prepare('UPDATE admins SET totp_enabled = 0, totp_secret = NULL, updated_at = ? WHERE id = ?').run(now(), req.admin.id)
  writeLog({ admin: req.admin, action: '关闭 2FA', targetType: 'settings', ip: clientIp(req) })
  res.json({ ok: true })
})

app.use(express.static(PUBLIC_DIR))

app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err?.message || 'server error' })
})

app.listen(PORT, HOST, () => {
  console.log(`[ads-king-admin] http://${HOST}:${PORT}`)
})

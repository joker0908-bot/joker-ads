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
  savePublishedPart,
  syncDraftFromLive,
  readJson,
  readLive,
  readPublished,
  publishApiSession,
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
import * as boluoApi from './lib/boluoApi.mjs'
import * as boluoVideos from './lib/boluoVideos.mjs'
import { createDramaApiKey, deleteDramaApiKey, dramaKeyAllows, listDramaApiKeys, setDramaApiKeyPaused, touchKeyUsed } from './lib/dramaApiKey.mjs'

const HOST = process.env.ADMIN_HOST || '127.0.0.1'
const PORT = Number(process.env.ADMIN_PORT || 8790)
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif'])

ensureDirs()
getDb()

const app = express()
app.set('trust proxy', 'loopback')
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
    if (!IMAGE_EXTS.has(ext)) {
      // 类型不符属于客户端错误，标记 400 避免落入兜底 500
      const err = new Error('仅支持图片上传')
      err.status = 400
      return cb(err)
    }
    cb(null, true)
  },
})

// 上传后按 magic bytes 复核真实图片类型：扩展名与 MIME 都由客户端控制，不可信。
// 返回识别出的格式名；识别失败返回 null，由调用方删除落盘文件并拒绝。
function sniffImageExt(filePath) {
  const head = Buffer.alloc(12)
  let len = 0
  try {
    const fd = fs.openSync(filePath, 'r')
    try {
      len = fs.readSync(fd, head, 0, head.length, 0)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
  const ascii = (start, n) => head.subarray(start, start + n).toString('latin1')
  if (len >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg'
  if (len >= 4 && head.readUInt32BE(0) === 0x89504e47) return 'png'
  if (len >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'gif'
  if (len >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'webp'
  // AVIF 是 ISOBMFF 容器：offset 4 为 'ftyp'，major brand 为 avif（avis 为图像序列）
  if (len >= 12 && ascii(4, 4) === 'ftyp' && (ascii(8, 4) === 'avif' || ascii(8, 4) === 'avis')) return 'avif'
  return null
}

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

function getBundle() {
  const published = readPublished()
  return {
    config: published.config,
    popups: published.popups,
    tabs: published.tabs,
    meta: published.meta,
    autoPublish: true,
  }
}

function saveBundle(part, value) {
  return savePublishedPart(part, value)
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'ads-king-admin' })
})

readPublished()
app.get('/data/:file', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  if (req.params.file === 'site-bundle.json') return res.json(readPublished())
  // 安全基线：api-session.json 含上游 API token，绝不能通过公开路由暴露
  if (!/^(config|popups|tabs|meta)\.json$/.test(req.params.file)) return res.sendStatus(404)
  res.json(readLive(req.params.file))
})
app.use('/data', (_req, res) => res.sendStatus(404))

app.use('/uploads', express.static(UPLOAD_DIR, {
  etag: true,
  maxAge: '30d',
  // 上传目录一律 nosniff：阻止浏览器按内容嗅探把伪装文件当脚本/样式执行
  setHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff')
  },
}))

// 客户身份卡 token：只认 X-Card-Token / Authorization: Bearer 头或 dw_card HttpOnly cookie。
// query 里的 ?token= 一律忽略——出现在 URL 的 token 会落访问日志和 Referer，等同泄漏。
function readCardToken(req) {
  const header = String(req.get('x-card-token') || '').trim()
  if (header) return header
  const auth = String(req.get('authorization') || '').trim()
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim()
  return String(cookies(req)[CARD_COOKIE] || '')
}

app.post('/api/public/customers/claim', (req, res) => {
  try {
    const result = claimCustomer({
      deviceFp: req.body?.deviceFp,
      inviteCode: req.body?.inviteCode,
      // body.cardToken 保留；其余渠道只走头/cookie，不认 query
      cardToken: String(req.body?.cardToken || readCardToken(req) || ''),
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
  // GET 端点不再接受 ?token=：身份卡 token 走 URL 会进日志/Referer 泄漏
  const token = readCardToken(req)
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
  // POST 端点保留 body.cardToken；其余照旧走头/cookie，query token 不认
  const token = String(req.body?.cardToken || readCardToken(req) || '')
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

function boluoError(res, e) {
  const status = Number(e?.status) || 500
  res.status(status).json({
    code: status,
    message: e?.message || '加载失败',
    error: e?.code || 'upstream',
  })
}

function boluoCors(req, res, next) {
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

// juhe 聚合后端遗留挂载仅存在于 /dewu-api 前缀，只有经该前缀到达的请求才放行 ?key=。
// 注意：生产 nginx 目前把 /dewu-api 重写为 /boluo-api 再转发，Express 端 originalUrl
// 看不到原前缀；如需真正放行遗留 query key，转发层须透传原始 URI（X-Original-URI 等）。
// 伪造该头最坏只是让客户端用自己的 key 走 query，不构成提权。
function dewuLegacyPath(req) {
  const candidates = [req.baseUrl, req.originalUrl, req.get('x-original-uri'), req.get('x-forwarded-uri')]
  return candidates.some((u) => String(u || '').startsWith('/dewu-api'))
}

function readRequestKey(req) {
  const header = String(req.headers['x-api-key'] || '').trim()
  if (header) return header
  const auth = String(req.headers.authorization || '').trim()
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim()
  // ?key= 只在 /dewu-api 遗留挂载放行；/boluo-api 必须走头，防 key 落 URL 日志
  if (!dewuLegacyPath(req)) return ''
  return String(req.query.key || '').trim()
}

const boluoRateLimit = new Map()
const BOLUO_RATE_PER_MIN = Math.max(30, Number(process.env.BOLUO_API_RATE_PER_MIN || 300))

function boluoRateOk(key) {
  const now = Date.now()
  let row = boluoRateLimit.get(key)
  if (!row || now - row.windowStart > 60_000) {
    row = { windowStart: now, count: 0 }
    boluoRateLimit.set(key, row)
  }
  row.count += 1
  if (boluoRateLimit.size > 5000) {
    for (const [k, v] of boluoRateLimit) {
      if (now - v.windowStart > 120_000) boluoRateLimit.delete(k)
    }
  }
  return row.count <= BOLUO_RATE_PER_MIN
}

// 公开端点的进程内固定窗口限流（按客户端 IP）。Map 超上限先清过期窗口、
// 再淘汰最老条目（Map 按插入序遍历），防海量 IP 把内存打爆；进程重启计数清零，属软防护。
const publicRateBuckets = new Map()
const PUBLIC_RATE_MAX_KEYS = 10_000

function publicRateOk(name, req, perMin) {
  const now = Date.now()
  const key = `${name}:${clientIp(req) || 'unknown'}`
  let row = publicRateBuckets.get(key)
  if (!row || now - row.windowStart > 60_000) {
    row = { windowStart: now, count: 0 }
    publicRateBuckets.set(key, row)
  }
  row.count += 1
  if (publicRateBuckets.size > PUBLIC_RATE_MAX_KEYS) {
    for (const [k, v] of publicRateBuckets) {
      if (now - v.windowStart > 120_000) publicRateBuckets.delete(k)
    }
    while (publicRateBuckets.size > PUBLIC_RATE_MAX_KEYS) {
      const oldest = publicRateBuckets.keys().next().value
      if (oldest === undefined) break
      publicRateBuckets.delete(oldest)
    }
  }
  return row.count <= perMin
}

function boluoRequireKey(req, res, next) {
  if (req.method === 'OPTIONS') return next()
  if (req.path === '/api/seg' || req.path === '/api/vseg') return next()
  const key = readRequestKey(req)
  if (!dramaKeyAllows(key, 'boluo')) {
    return res.status(401).json({ code: 401, message: '需要 API Key', error: 'unauthorized' })
  }
  touchKeyUsed(key)
  if (!boluoRateOk(key)) {
    return res.status(429).json({ code: 429, message: '请求过于频繁', error: 'rate_limited' })
  }
  next()
}

app.use('/boluo-api', boluoCors)
app.use('/boluo-api', boluoRequireKey)

app.get('/boluo-api/api/shows', async (req, res) => {
  try {
    res.json({ code: 200, data: await boluoApi.listShows({ size: req.query.size }) })
  } catch (e) {
    boluoError(res, e)
  }
})

app.get('/boluo-api/api/show/:id', async (req, res) => {
  try {
    res.json({ code: 200, data: await boluoApi.getShow(req.params.id) })
  } catch (e) {
    boluoError(res, e)
  }
})

app.get('/boluo-api/api/cover/:id', async (req, res) => {
  try {
    const ok = await boluoApi.writeShowCover(req.params.id, res)
    if (!ok) return res.status(404).json({ code: 404, message: '该视频暂不可用', error: 'not_found' })
  } catch (e) {
    boluoError(res, e)
  }
})

app.get('/boluo-api/api/seg', async (req, res) => {
  try {
    const ok = await boluoApi.writeShowSegment(req.query.id, req.query.p, req.query.exp, req.query.sig, res)
    if (!ok) return res.status(404).json({ code: 404, message: '该视频暂不可用', error: 'unavailable' })
  } catch (e) {
    boluoError(res, e)
  }
})

app.get('/boluo-api/api/video/:id/:epId', async (req, res) => {
  try {
    await boluoApi.writePlaylist(req.params.id, req.params.epId, res)
  } catch (e) {
    boluoError(res, e)
  }
})

app.get('/boluo-api/api/videos', async (req, res) => {
  try {
    const out = await boluoVideos.listVideos(req.query)
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
    boluoError(res, e)
  }
})

app.get('/boluo-api/api/videos/tags', async (req, res) => {
  try {
    res.json({ code: 200, data: await boluoVideos.listVideoTags() })
  } catch (e) {
    boluoError(res, e)
  }
})

app.get('/boluo-api/api/videos/categories', async (req, res) => {
  try {
    res.json({ code: 200, data: await boluoVideos.listVideoCategories() })
  } catch (e) {
    boluoError(res, e)
  }
})

app.get('/boluo-api/api/shorts', async (req, res) => {
  try {
    const out = await boluoVideos.listShorts(req.query)
    res.json({ code: 200, data: out.items, page: out.page, pageSize: out.pageSize })
  } catch (e) {
    boluoError(res, e)
  }
})

app.get('/boluo-api/api/skits', async (req, res) => {
  try {
    const out = await boluoVideos.listSkits(req.query)
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
    boluoError(res, e)
  }
})

app.get('/boluo-api/api/skits/tags', async (req, res) => {
  try {
    res.json({ code: 200, data: await boluoVideos.listSkitTags() })
  } catch (e) {
    boluoError(res, e)
  }
})

app.get('/boluo-api/api/skits/categories', async (req, res) => {
  try {
    res.json({ code: 200, data: await boluoVideos.listSkitCategories() })
  } catch (e) {
    boluoError(res, e)
  }
})

app.get('/boluo-api/api/skits/:id/play', async (req, res) => {
  try {
    await boluoVideos.writeSkitPlaylist(req.params.id, req.query.ep, req.query.mode, res)
  } catch (e) {
    boluoError(res, e)
  }
})

app.get('/boluo-api/api/skits/:id/cover', async (req, res) => {
  try {
    const ok = await boluoVideos.writeSkitCover(req.params.id, res)
    if (!ok) return res.status(404).json({ code: 404, message: '该视频暂不可用', error: 'not_found' })
  } catch (e) {
    boluoError(res, e)
  }
})

app.get('/boluo-api/api/skits/:id', async (req, res) => {
  try {
    res.json({ code: 200, data: await boluoVideos.getSkit(req.params.id) })
  } catch (e) {
    boluoError(res, e)
  }
})

app.get('/boluo-api/api/videos/:id/play', async (req, res) => {
  try {
    await boluoVideos.writePlaylist(req.params.id, req.query.mode, res)
  } catch (e) {
    boluoError(res, e)
  }
})

app.get('/boluo-api/api/videos/:id/cover', async (req, res) => {
  try {
    const ok = await boluoVideos.writeCover(req.params.id, res)
    if (!ok) return res.status(404).json({ code: 404, message: '该视频暂不可用', error: 'not_found' })
  } catch (e) {
    boluoError(res, e)
  }
})

app.get('/boluo-api/api/vseg', async (req, res) => {
  try {
    boluoVideos.verifySeg(req.query.u, req.query.exp, req.query.sig)
    await boluoVideos.proxyMedia(req.query.u, res)
  } catch (e) {
    boluoError(res, e)
  }
})

app.get('/boluo-api/api/videos/:id', async (req, res) => {
  try {
    const detail = await boluoVideos.getVideo(req.params.id)
    const { _playUrl, _previewUrl, _coverPath, ...pub } = detail
    res.json({ code: 200, data: pub })
  } catch (e) {
    boluoError(res, e)
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
  // 同 customers/me：GET 端点不认 ?token=，防身份卡 token 经 URL 泄漏
  const token = readCardToken(req)
  const row = readCustomerByToken(token)
  if (!row) return res.status(401).json({ ok: false, message: '请先领取身份卡' })
  res.json({ ok: true, orders: listCustomerOrders(row.customerId) })
})

app.post('/api/internal/pay/reserve', (req, res) => {
  // 下单限流：每 IP 每分钟 20 次，先限流再验内部 token，防暴力探测与刷接口
  if (!publicRateOk('pay-reserve', req, 20)) {
    return res.status(429).json({ ok: false, message: '请求过于频繁' })
  }
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
  // 点击上报限流：每 IP 每分钟 60 次，防刷量打爆 ad_events 表
  if (!publicRateOk('ad-click', req, 60)) {
    return res.status(429).json({ ok: false, error: '请求过于频繁' })
  }
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
    const meta = publishApiSession(next)
    let auditWarning = false
    try { writeLog({
      admin: req.admin,
      action: '轮换原站 token',
      targetType: 'api-session',
      detail: `uid=${next.uid} len=${next.token.length}`,
      ip: clientIp(req),
    }) } catch { auditWarning = true; console.warn('[config] session committed; audit log unavailable') }
    res.json({ ok: true, session: publicApiSession(next), meta, auditWarning })
  } catch (err) {
    res.status(400).json({ error: err.message || 'token 无效' })
  }
})

function logCommittedChange(entry) {
  try { writeLog(entry); return false }
  catch { console.warn('[admin] state committed; audit log unavailable'); return true }
}

app.put('/api/admin/site-config/:part', requireAuth, requireWrite('popups'), (req, res) => {
  const part = req.params.part
  if (!['config', 'popups', 'tabs'].includes(part)) return res.status(400).json({ error: 'invalid part' })
  const saved = saveBundle(part, req.body || {})
  const auditWarning = logCommittedChange({ admin: req.admin, action: `更新并发布 ${part}`, targetType: part, ip: clientIp(req) })
  res.json({ ok: true, ...saved, auditWarning })
})

app.put('/api/admin/slots/:slotKey', requireAuth, requireWrite('popups'), (req, res) => {
  const { slotKey } = req.params
  const items = req.body?.items
  const bundle = getBundle()
  let saved

  if (slotKey === 'afterEnterApp' || slotKey === 'gridPopAds' || slotKey === 'actPopAds') {
    bundle.popups[slotKey] = items || []
    saved = saveBundle('popups', bundle.popups)
  } else if (slotKey === 'configPopups') {
    bundle.config.popups = items || []
    saved = saveBundle('config', bundle.config)
  } else if (slotKey === 'promo') {
    bundle.config.promo = { ...(bundle.config.promo || {}), ...(req.body || {}) }
    saved = saveBundle('config', bundle.config)
  } else if (slotKey === 'floatBanner') {
    bundle.config.floatBanner = { ...(bundle.config.floatBanner || {}), ...(req.body || {}) }
    saved = saveBundle('config', bundle.config)
  } else if (slotKey === 'featuredAd') {
    bundle.tabs.featured = bundle.tabs.featured || {}
    bundle.tabs.featured.ad = { ...(bundle.tabs.featured.ad || {}), ...(req.body || {}) }
    saved = saveBundle('tabs', bundle.tabs)
  } else if (slotKey === 'mineQuickApps') {
    bundle.tabs.mine = bundle.tabs.mine || {}
    bundle.tabs.mine.quickApps = items || []
    saved = saveBundle('tabs', bundle.tabs)
  } else {
    return res.status(400).json({ error: 'unknown slot' })
  }

  const auditWarning = logCommittedChange({ admin: req.admin, action: `编辑广告位 ${slotKey}`, targetType: 'slot', targetId: slotKey, ip: clientIp(req) })
  res.json({ ok: true, ...saved, auditWarning })
})

app.get('/api/admin/apps', requireAuth, requireRead('apps'), (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase()
  const page = Math.max(1, Number(req.query.page || 1))
  const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize || 30)))
  const all = getBundle().config.apps || []
  const counts = new Map()
  const canonical = new Map()
  for (const item of all) {
    counts.set(item.name, (counts.get(item.name) || 0) + 1)
    canonical.set(item.name, item)
  }
  let apps = [...canonical.values()].map(item => ({ ...item, duplicateCount: counts.get(item.name) }))
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
  const saved = saveBundle('config', bundle.config)
  const auditWarning = logCommittedChange({ admin: req.admin, action: `新增应用 ${name}`, targetType: 'apps', targetId: name, ip: clientIp(req) })
  res.json({ ok: true, ...saved, auditWarning })
})

app.put('/api/admin/apps/:name', requireAuth, requireWrite('apps'), (req, res) => {
  const oldName = req.params.name
  const body = req.body || {}
  const bundle = getBundle()
  const idx = (bundle.config.apps || []).findIndex((a) => a.name === oldName)
  if (idx === -1) return res.status(404).json({ error: '应用不存在' })
  const nextName = String(body.name || oldName).trim()
  if (!nextName) return res.status(400).json({ error: '请填写应用名称' })
  if (nextName !== oldName && bundle.config.apps.some((a) => a.name === nextName)) {
    return res.status(409).json({ error: '应用名称已存在' })
  }
  const canonical = bundle.config.apps.findLast(item => item.name === oldName)
  const fields = Object.fromEntries(['url', 'signUrl', 'icon'].map(k => [k, body[k] !== undefined ? body[k] : canonical[k] || '']))
  bundle.config.apps = bundle.config.apps.map(item => item.name === oldName ? { ...item, ...fields, name: nextName } : item)
  if (nextName !== oldName) updateAppPlacements(bundle.config, oldName, nextName)
  const saved = saveBundle('config', bundle.config)
  const auditWarning = logCommittedChange({ admin: req.admin, action: `编辑应用 ${nextName}`, targetType: 'apps', targetId: nextName, ip: clientIp(req) })
  res.json({ ok: true, ...saved, auditWarning })
})

app.delete('/api/admin/apps/:name', requireAuth, requireWrite('apps'), (req, res) => {
  const name = req.params.name
  const bundle = getBundle()
  bundle.config.apps = (bundle.config.apps || []).filter((a) => a.name !== name)
  updateAppPlacements(bundle.config, name)
  const saved = saveBundle('config', bundle.config)
  const auditWarning = logCommittedChange({ admin: req.admin, action: `删除应用 ${name}`, targetType: 'apps', targetId: name, ip: clientIp(req) })
  res.json({ ok: true, ...saved, auditWarning })
})

app.get('/api/admin/category-apps', requireAuth, requireRead('categories'), (_req, res) => {
  res.json({ categoryApps: getBundle().config.categoryApps || {}, categories: getBundle().config.categories || [] })
})

app.put('/api/admin/category-apps', requireAuth, requireWrite('categories'), (req, res) => {
  const bundle = getBundle()
  bundle.config.categoryApps = req.body?.categoryApps || bundle.config.categoryApps || {}
  if (Array.isArray(req.body?.categories)) bundle.config.categories = req.body.categories
  const saved = saveBundle('config', bundle.config)
  const auditWarning = logCommittedChange({ admin: req.admin, action: '更新分类应用映射', targetType: 'categoryApps', ip: clientIp(req) })
  res.json({ ok: true, ...saved, auditWarning })
})

app.post('/api/admin/publish', requireAuth, requireWrite('publish'), (req, res) => {
  // Older admin tabs still call this endpoint. Saves are already live; never
  // re-import an old draft and resurrect a deleted advertisement.
  const meta = readPublished().meta
  let auditWarning = false
  try { writeLog({ admin: req.admin, action: '核对已自动发布的配置', targetType: 'publish', detail: `v${meta.version}`, ip: clientIp(req) }) }
  catch { auditWarning = true; console.warn('[config] published; audit log unavailable') }
  res.json({ ok: true, published: true, meta, auditWarning })
})

app.post('/api/admin/discard-draft', requireAuth, requireWrite('publish'), (_req, res) => {
  syncDraftFromLive()
  res.json({ ok: true, bundle: getBundle() })
})

app.post('/api/admin/upload', requireAuth, requireWrite('upload'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未收到文件' })
  // magic bytes 复核不过即删除落盘文件并 400，防伪装脚本/马进入 /uploads
  if (!sniffImageExt(req.file.path)) {
    fs.rmSync(req.file.path, { force: true })
    return res.status(400).json({ error: '文件内容不是有效图片' })
  }
  const kind = String(req.query.kind || 'popup')
  const sub = kind === 'icon' ? 'icons' : kind === 'promo' ? 'promo' : 'popups'
  const url = `/uploads/${sub}/${req.file.filename}`
  const auditWarning = logCommittedChange({ admin: req.admin, action: `上传素材 ${url}`, targetType: 'upload', targetId: url, ip: clientIp(req) })
  res.json({ ok: true, url, auditWarning })
})

app.get('/api/admin/logs', requireAuth, requireRead('logs'), (req, res) => {
  const limit = Math.min(500, Math.max(10, Number(req.query.limit || 100)))
  const logs = getDb().prepare('SELECT * FROM operation_logs ORDER BY created_at DESC LIMIT ?').all(limit)
  res.json({ logs })
})

app.get('/api/admin/logs/export', requireAuth, requireRead('logs'), (_req, res) => {
  const logs = getDb().prepare('SELECT * FROM operation_logs ORDER BY created_at DESC LIMIT 2000').all()
  const header = 'time,admin,action,target_type,target_id,detail,ip\n'
  // 防 Excel 公式注入：以 = + - @ 开头的单元格内容前置单引号；
  // detail 在 JSON.stringify 前先处理，保证引号包住的值本身已被中和
  const csvSafe = (v) => {
    const s = String(v || '')
    return /^[=+\-@]/.test(s.trimStart()) ? `'${s}` : s
  }
  const rows = logs.map((r) =>
    [r.created_at, r.admin_name, r.action, r.target_type, r.target_id, JSON.stringify(csvSafe(r.detail || '')), r.ip]
      .map((v) => `"${csvSafe(v).replace(/"/g, '""')}"`)
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
  const current = getDb().prepare('SELECT totp_enabled FROM admins WHERE id = ?').get(req.admin.id)
  if (current?.totp_enabled) return res.status(409).json({ error: '请先使用当前验证码关闭二次验证，再重新设置' })
  const totp = await loadTotp()
  const secret = totp.generateSecret()
  getDb().prepare('UPDATE admins SET totp_secret = ?, totp_enabled = 0, updated_at = ? WHERE id = ?').run(secret, now(), req.admin.id)
  res.json({
    secret,
    otpauth: totp.otpauthUrl({ secret, issuer: '菠萝视频后台', account: req.admin.username }),
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
  // MulterError 不带 HTTP status：LIMIT_*/INVALID_FIELD_NAME 由客户端请求触发按 400 返回，
  // STREAM_DESTROYED 属存储侧故障仍按 500。
  const clientUploadError = err instanceof multer.MulterError && err.code !== 'STREAM_DESTROYED'
  const status = clientUploadError || err.status === 400 ? 400 : 500
  res.status(status).json({
    error: err?.message || 'server error',
    ...(err.field ? { field: err.field } : {}),
    ...(clientUploadError ? { code: err.code } : {}),
  })
})

app.listen(PORT, HOST, () => {
  console.log(`[ads-king-admin] http://${HOST}:${PORT}`)
})

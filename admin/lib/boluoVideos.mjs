import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import zlib from 'node:zlib'
import { LIVE_DIR } from './paths.mjs'
import * as catalog from './boluoCatalog.mjs'

const PID = 'FBI'
const DATA_KEY = String(process.env.BOLUO_DATA_KEY || '')
const IMG_KEY = String(process.env.BOLUO_IMG_KEY || '')
const DEFAULT_RES_BASE = 'https://d17e80montytxe.cloudfront.net'
// Upstream origins come from BOLUO_ORIGIN_BASES (comma-separated); none are hardcoded.
const DEFAULT_BASES = []

const FETCH_MS = Math.max(2000, Number(process.env.BOLUO_FETCH_MS || 8000))
const PLAY_TTL_SEC = Math.max(30, Number(process.env.VIDEO_PLAY_TTL_SEC || 300))
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

let sid = ''
let activeBase = null
const coverPathCache = new Map()

function httpError(status, code, message) {
  const err = new Error(message)
  err.status = status
  err.code = code
  return err
}

function bases() {
  const raw = String(process.env.BOLUO_ORIGIN_BASES || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean)
  const list = raw.length ? raw : DEFAULT_BASES
  const isIp = (b) => {
    try { return /^\d{1,3}(\.\d{1,3}){3}$/.test(new URL(b).hostname) } catch { return false }
  }
  return [...list.filter((b) => !isIp(b)), ...list.filter(isIp)]
}

function session() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(LIVE_DIR, 'api-session.json'), 'utf8'))
    return {
      token: String(raw?.token || '').trim(),
      resBase: String(raw?.resBase || DEFAULT_RES_BASE).trim().replace(/\/$/, '') || DEFAULT_RES_BASE,
    }
  } catch {
    return { token: '', resBase: DEFAULT_RES_BASE }
  }
}

export function configured() {
  return Boolean(session().token)
}

function isIpUrl(u) {
  try { return /^\d{1,3}(\.\d{1,3}){3}$/.test(new URL(u).hostname) } catch { return false }
}

function httpGet(url, { headers = {}, timeout = FETCH_MS, stream = false } = {}) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(url) } catch { return reject(httpError(502, 'upstream', '加载失败，请检查网络后重试')) }
    const mod = u.protocol === 'http:' ? http : https
    const req = mod.request(u, {
      method: 'GET',
      rejectUnauthorized: !isIpUrl(u),
      headers: { 'User-Agent': UA, ...headers },
    }, (res) => {
      if (stream) return resolve(res)
      const chunks = []
      res.on('data', (d) => chunks.push(d))
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }))
    })
    req.setTimeout(timeout, () => req.destroy(new Error('upstream timeout')))
    req.on('error', () => reject(httpError(502, 'upstream', '加载失败，请检查网络后重试')))
    req.end()
  })
}

function decryptCipher(cipher) {
  const dec = crypto.createDecipheriv('aes-256-ecb', Buffer.from(DATA_KEY, 'utf8'), null)
  const b64 = Buffer.concat([dec.update(String(cipher), 'base64'), dec.final()]).toString('utf8')
  const raw = Buffer.from(b64, 'base64')
  const un = raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : zlib.inflateSync(raw)
  return JSON.parse(un.toString('utf8'))
}

function unwrap(json) {
  if (!json || json.errorCode !== 0) return null
  if (json.data && typeof json.data === 'object') return json.data
  if (typeof json.data === 'string') return decryptCipher(json.data)
  return json.data ?? null
}

async function handshake(base) {
  const url = `${base}/api/v1/speedtest?pid=${PID}`
  const got = await httpGet(url, { headers: { t: '3', k: '3' } })
  if (got.status !== 200) throw httpError(502, 'upstream', '加载失败，请检查网络后重试')
  let json
  try { json = JSON.parse(got.body.toString('utf8')) } catch { json = null }
  if (json?.sid) sid = String(json.sid)
  return got.status === 200
}

async function pickBase() {
  for (const base of bases()) {
    try {
      if (await handshake(base)) {
        activeBase = base
        return base
      }
    } catch {}
  }
  throw httpError(502, 'upstream', '加载失败，请检查网络后重试')
}

async function api(pathName, { retry = true } = {}) {
  const { token } = session()
  if (!token) throw httpError(502, 'upstream', '加载失败，请检查网络后重试')
  const base = activeBase || (await pickBase())
  const sep = pathName.includes('?') ? '&' : '?'
  const url = `${base}/api/v1${pathName}${pathName.includes('pid=') ? '' : `${sep}pid=${PID}`}`
  const got = await httpGet(url, {
    headers: { Accept: 'application/json', t: '3', k: '3', sid, token },
  })
  if (got.status !== 200) {
    if (activeBase) { activeBase = null }
    throw httpError(502, 'upstream', '加载失败，请检查网络后重试')
  }
  let json
  try { json = JSON.parse(got.body.toString('utf8')) } catch {
    throw httpError(502, 'upstream', '加载失败，请检查网络后重试')
  }
  if (json.sid) sid = String(json.sid)
  if (json.errorCode && json.errorCode !== 0) {
    if (retry && /^fail\/sid:/i.test(String(json.message || ''))) {
      sid = ''
      activeBase = null
      await pickBase()
      return api(pathName, { retry: false })
    }
    const msg = String(json.message || '')
    if (/不存在|已下架|下架/.test(msg)) throw httpError(404, 'not_found', '该视频暂不可用')
    throw httpError(502, 'upstream', msg && msg.length < 60 ? msg : '加载失败，请检查网络后重试')
  }
  const data = unwrap(json)
  if (typeof json.data === 'string' && data == null) {
    throw httpError(502, 'upstream', '加载失败，请检查网络后重试')
  }
  return data
}

export { api as callApi }

function normalizeTags(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .map((t) => (typeof t === 'string' ? t : t?.name || t?.tag || ''))
    .filter(Boolean)
}

export function formatDuration(sec) {
  const s = Number(sec)
  if (!Number.isFinite(s) || s <= 0) return ''
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = Math.floor(s % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
  return `${m}:${String(ss).padStart(2, '0')}`
}

export function mapVideo(v) {
  const id = String(v?.id || '')
  return {
    id,
    title: String(v?.name || v?.title || ''),
    cover: id ? `/boluo-api/api/videos/${encodeURIComponent(id)}/cover` : '',
    duration: Math.round(Number(v?.time)) || 0,
    durationText: formatDuration(v?.time),
    views: Number(v?.playCnt) || 0,
    hot: Number(v?.hot) || 0,
    likes: Number(v?.likedCnt) || 0,
    comments: Number(v?.commentCnt) || 0,
    collects: Number(v?.collectedCnt) || 0,
    tags: normalizeTags(v?.videoTags || v?.tags).length
      ? normalizeTags(v?.videoTags || v?.tags)
      : catalog.rowTags(id),
    source: 'boluo',
    type: 'video',
    play: id ? `/boluo-api/api/videos/${encodeURIComponent(id)}/play` : '',
  }
}

export async function listVideos({ page, pageSize, size, sort, q, tag } = {}) {
  await catalog.ensureCatalog(api)
  const res = catalog.queryVideos({ page, pageSize: pageSize || size, sort, q, tag })
  for (const v of res.rows) {
    if (v.id && v.coverURL) coverPathCache.set(String(v.id), String(v.coverURL))
  }
  return {
    items: res.rows.filter((v) => v && v.id && v.name).map(mapVideo),
    total: res.total,
    page: res.page,
    pageSize: res.pageSize,
    enriched: res.enriched,
    complete: res.complete,
    updatedAt: res.updatedAt,
  }
}

export async function getVideo(id) {
  const vid = String(id || '').trim()
  if (!vid) throw httpError(404, 'not_found', '该视频暂不可用')
  const data = await api(`/videos/${encodeURIComponent(vid)}`)
  const v = data?.video || {}
  if (!v.id) throw httpError(404, 'not_found', '该视频暂不可用')
  if (v.coverURL) coverPathCache.set(vid, String(v.coverURL))
  const playUrl = String(data?.url || '')
  const previewUrl = String(data?.previewUrl || '')
  const related = Array.isArray(data?.otherVideos)
    ? data.otherVideos.filter((x) => x && x.id && (x.name || x.title)).map(mapVideo)
    : []
  return {
    ...mapVideo(v),
    intro: String(v?.introduction || ''),
    user: v?.user?.username ? String(v.user.username) : '',
    needBuy: Boolean(data?.buyVideo),
    trialSeconds: Number(data?.trialPreviewSeconds) || 0,
    hasPlay: Boolean(playUrl || previewUrl),
    preview: !playUrl && Boolean(previewUrl),
    play: `/boluo-api/api/videos/${encodeURIComponent(vid)}/play`,
    related,
    _playUrl: playUrl,
    _previewUrl: previewUrl,
    _coverPath: v.coverURL ? String(v.coverURL) : '',
  }
}

function videoSecret() {
  return String(process.env.VIDEO_URL_SECRET || '')
}

function signSeg(url, exp) {
  const key = videoSecret() || 'dev-only-unsigned'
  return crypto.createHmac('sha256', key).update(`vseg.${url}.${exp}`).digest('hex')
}

export function segUrl(target, exp) {
  return `/boluo-api/api/vseg?u=${encodeURIComponent(target)}&exp=${exp}&sig=${signSeg(target, exp)}`
}

export function verifySeg(target, exp, sig) {
  const expN = Number(exp)
  const now = Math.floor(Date.now() / 1000)
  if (!Number.isFinite(expN) || expN < now) {
    throw httpError(410, 'expired', '播放地址已失效，请返回重试')
  }
  const expected = signSeg(String(target || ''), expN)
  const a = Buffer.from(expected)
  const b = Buffer.from(String(sig || ''))
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw httpError(410, 'expired', '播放地址已失效，请返回重试')
  }
}

function rewritePlaylist(text, baseUrl, exp) {
  const base = baseUrl || ''
  return String(text || '').split(/\r?\n/).map((line) => {
    const trimmed = line.trim()
    if (!trimmed) return line
    if (trimmed.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (_m, uri) => {
        try { return `URI="${segUrl(new URL(uri, base).href, exp)}"` } catch { return _m }
      })
    }
    try {
      return segUrl(new URL(trimmed, base).href, exp)
    } catch {
      return line
    }
  }).join('\n')
}

export async function writePlaylist(id, mode, res) {
  const detail = await getVideo(id)
  const target = detail._playUrl || detail._previewUrl
  if (!target) throw httpError(404, 'not_found', '该视频暂不可用')
  const { token } = session()
  const got = await httpGet(target, {
    headers: { Accept: 'application/vnd.apple.mpegurl,*/*', t: '3', k: '3', sid, token },
  })
  const text = got.body.toString('utf8')
  if (got.status !== 200 || !text.includes('#EXTM3U')) {
    throw httpError(502, 'unavailable', '该视频暂不可用')
  }
  const exp = Math.floor(Date.now() / 1000) + PLAY_TTL_SEC
  const out = mode === 'direct'
    ? text.split(/\r?\n/).map((line) => {
      const trimmed = line.trim()
      if (!trimmed) return line
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_m, uri) => {
          try { return `URI="${new URL(uri, target).href}"` } catch { return _m }
        })
      }
      try { return new URL(trimmed, target).href } catch { return line }
    }).join('\n')
    : rewritePlaylist(text, target, exp)
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
  res.send(out)
}

function allowedProxyUrl(raw) {
  let u
  try { u = new URL(String(raw || '')) } catch { return null }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  const host = u.hostname
  if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1') return null
  if (/^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^169\.254\./.test(host)) return null
  return u
}

export async function proxyMedia(target, res) {
  const u = allowedProxyUrl(target)
  if (!u) throw httpError(403, 'forbidden', '该视频暂不可用')
  const upstream = await httpGet(u.href)
  const text = upstream.body.toString('utf8')
  const isM3u8 = /m3u8|mpegurl/i.test(String(upstream.headers['content-type'] || ''))
    || text.startsWith('#EXTM3U')
  if (isM3u8 && upstream.status === 200) {
    const exp = Math.floor(Date.now() / 1000) + PLAY_TTL_SEC
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
    res.send(rewritePlaylist(text, u.href, exp))
    return true
  }
  if (upstream.status !== 200) throw httpError(upstream.status === 404 ? 404 : 502, 'upstream', '该视频暂不可用')
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('Content-Type', upstream.headers['content-type'] || 'application/octet-stream')
  res.send(upstream.body)
  return true
}

function mediaUrl(raw) {
  const clean = String(raw || '').split('@')[0].trim()
  if (!clean) return ''
  if (/^https?:\/\//i.test(clean)) return clean
  return `${session().resBase}/${clean.replace(/^\/+/, '')}`
}

function sniffImageType(buf) {
  if (!buf || buf.length < 4) return ''
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif'
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return 'image/webp'
  return ''
}

function decryptCeb(buf) {
  try {
    const dec = crypto.createDecipheriv('aes-256-ecb', Buffer.from(IMG_KEY, 'utf8'), null)
    const text = Buffer.concat([dec.update(buf), dec.final()]).toString('utf8')
    const m = text.match(/^data:(image\/[A-Za-z0-9.+-]+);base64,([\s\S]+)$/)
    if (!m) return null
    const body = Buffer.from(m[2], 'base64')
    return { contentType: sniffImageType(body) || m[1], body }
  } catch {
    return null
  }
}

export async function writeCover(id, res) {
  const vid = String(id || '').trim()
  let coverPath = coverPathCache.get(vid) || ''
  if (!coverPath) {
    const detail = await getVideo(vid)
    coverPath = detail._coverPath
  }
  const url = mediaUrl(coverPath)
  if (!url) return false
  const upstream = await httpGet(url)
  if (upstream.status !== 200 || !upstream.body.length) return false
  let body = upstream.body
  let contentType = String(upstream.headers['content-type'] || 'image/jpeg')
  if (/\.ceb(\?|$)/i.test(url)) {
    const dec = decryptCeb(upstream.body)
    if (!dec) return false
    body = dec.body
    contentType = dec.contentType
  }
  res.setHeader('Cache-Control', 'public, max-age=3600')
  res.setHeader('Content-Type', contentType)
  res.send(body)
  return true
}

export async function listShorts({ page, pageSize } = {}) {
  const q = new URLSearchParams({
    page: String(Math.max(1, Number(page) || 1)),
    pageSize: String(Math.min(50, Math.max(1, Number(pageSize) || 10))),
  })
  const data = await api(`/videos/short?${q}`)
  const rows = Array.isArray(data?.videoInfo) ? data.videoInfo : []
  const items = []
  for (const row of rows) {
    const v = row?.video || row
    if (!v?.id || !(v.name || v.title)) continue
    if (v.coverURL) coverPathCache.set(String(v.id), String(v.coverURL))
    items.push(mapVideo(v))
  }
  return { items, page: Math.max(1, Number(page) || 1), pageSize: items.length }
}

export async function listVideoTags() {
  const data = await api('/tags/all/info')
  const rows = Array.isArray(data) ? data : []
  return rows
    .map((t) => (typeof t === 'string' ? { id: '', name: t } : { id: String(t?.id || ''), name: String(t?.name || '') }))
    .filter((t) => t.name)
}

export async function listVideoCategories() {
  const data = await api('/categories/all/getCates')
  const rows = Array.isArray(data) ? data : []
  return rows
    .map((c) => ({ id: String(c?.id || ''), name: String(c?.name || c?.categoryName || '') }))
    .filter((c) => c.id || c.name)
}

export function mapSkit(row) {
  const id = String(row?.serial_id || row?.id || '')
  if (row?.coverURL) skitCoverCache.set(id, String(row.coverURL))
  return {
    id,
    title: String(row?.name || ''),
    intro: row?.introduction != null ? String(row.introduction) : '',
    cover: id ? `/boluo-api/api/skits/${encodeURIComponent(id)}/cover` : '',
    episodes: Number(row?.total) || 0,
    finished: Boolean(row?.is_finished),
    tags: Array.isArray(row?.tags) ? row.tags.map((t) => String(t)) : [],
    label: row?.skitLabel ? String(row.skitLabel) : '',
    categoryIds: Array.isArray(row?.categoryIds) ? row.categoryIds.map((c) => String(c)) : [],
    views: Number(row?.playCntTotal) || 0,
    likes: Number(row?.likedCntTotal) || 0,
    collects: Number(row?.collectedCntTotal) || 0,
    updated: row?.updatedDate ? String(row.updatedDate) : '',
    source: 'boluo',
    type: 'skit',
  }
}

const skitCoverCache = new Map()
let skitCategories = { at: 0, list: [] }

export async function listSkitCategories() {
  if (Date.now() - skitCategories.at < 3600_000 && skitCategories.list.length) {
    return skitCategories.list
  }
  const data = await api('/categories/skitVideo/subCategories')
  const rows = Array.isArray(data?.categories) ? data.categories : []
  const list = rows
    .map((c) => ({ id: String(c?.id || c?.categoryId || ''), name: String(c?.name || '') }))
    .filter((c) => c.id || c.name)
  if (list.length) skitCategories = { at: Date.now(), list }
  return list
}

async function skitCategoryName(ids) {
  if (!Array.isArray(ids) || !ids.length) return ''
  try {
    const cats = await listSkitCategories()
    return cats.find((c) => c.id === ids[0])?.name || ''
  } catch {
    return ''
  }
}

export async function listSkits({ page, pageSize, category, tag, q, sort } = {}) {
  await catalog.ensureSkitCatalog(api)
  const res = catalog.querySkits({ page, pageSize, category, tag, q, sort })
  const items = await Promise.all(
    res.rows
      .filter((r) => r && r.serial_id && r.name)
      .map(async (r) => ({ ...mapSkit(r), categoryName: await skitCategoryName(r.categoryIds) })),
  )
  return {
    items,
    total: res.total,
    page: res.page,
    pageSize: res.pageSize,
    complete: res.complete,
    updatedAt: res.updatedAt,
  }
}

export async function listSkitTags() {
  const data = await api('/skit/getTags')
  return (Array.isArray(data) ? data : []).map((t) => String(t)).filter(Boolean)
}

async function skitEpisodes(serialId) {
  const data = await api(
    `/skit/getEpisodesById?serialId=${encodeURIComponent(serialId)}&orderby=ASC&clientCache=false`,
  )
  const eps = Array.isArray(data) ? data : Array.isArray(data?.episodes) ? data.episodes : []
  return eps.map((e, i) => ({
    id: String(e?.id || ''),
    number: Number(e?.sequence) || i + 1,
    title: e?.name ? String(e.name) : `第 ${i + 1} 集`,
    duration: Math.round(Number(e?.time)) || 0,
    durationText: formatDuration(e?.time),
    unlocked: e?.hasWatchPermission !== false,
    cover: `/boluo-api/api/skits/${encodeURIComponent(serialId)}/cover`,
    _url: e?.url ? String(e.url) : '',
  }))
}

async function skitMeta(sid) {
  await catalog.ensureSkitCatalog(api)
  const row = catalog.skitRow(sid)
  if (row) return row
  for (let page = 1; page <= 40; page += 1) {
    try {
      const data = await api(`/skit/getSkitsByCategory?page=${page}&pageSize=50`)
      const rows = Array.isArray(data?.pageData) ? data.pageData : []
      const hit = rows.find((r) => String(r?.serial_id || r?.id || '') === sid)
      if (hit) return hit
      if (!rows.length) break
    } catch { break }
  }
  return null
}

export async function getSkit(serialId) {
  const sid = String(serialId || '').trim()
  if (!sid) throw httpError(404, 'not_found', '该视频暂不可用')
  const episodes = await skitEpisodes(sid)
  if (!episodes.length) throw httpError(404, 'not_found', '该视频暂不可用')
  const meta = await skitMeta(sid)
  const mapped = meta ? mapSkit(meta) : { id: sid, title: '', source: 'boluo', type: 'skit' }
  const categoryName = await skitCategoryName(mapped.categoryIds)
  return { ...mapped, categoryName, episode_list: episodes.map(({ _url, ...e }) => e) }
}

export async function writeSkitPlaylist(serialId, epId, mode, res) {
  const episodes = await skitEpisodes(serialId)
  const want = String(epId || '')
  const ep = episodes.find((e) => e.id === want)
    || episodes.find((e) => String(e.number) === want)
    || episodes.find((e) => e.unlocked)
  if (!ep?.id || !ep._url) throw httpError(404, 'not_found', '该视频暂不可用')
  const { token } = session()
  const got = await httpGet(ep._url, {
    headers: { Accept: 'application/vnd.apple.mpegurl,*/*', t: '3', k: '3', sid, token },
  })
  const text = got.body.toString('utf8')
  if (got.status !== 200 || !text.includes('#EXTM3U')) {
    throw httpError(502, 'unavailable', '该视频暂不可用')
  }
  const exp = Math.floor(Date.now() / 1000) + PLAY_TTL_SEC
  const out = mode === 'direct'
    ? text.split(/\r?\n/).map((line) => {
      const trimmed = line.trim()
      if (!trimmed) return line
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_m, uri) => {
          try { return `URI="${new URL(uri, ep._url).href}"` } catch { return _m }
        })
      }
      try { return new URL(trimmed, ep._url).href } catch { return line }
    }).join('\n')
    : rewritePlaylist(text, ep._url, exp)
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
  res.send(out)
}

export async function writeSkitCover(serialId, res) {
  const sid = String(serialId || '').trim()
  let coverPath = skitCoverCache.get(sid) || ''
  if (!coverPath) {
    const meta = await skitMeta(sid)
    if (meta?.coverURL) coverPath = String(meta.coverURL)
  }
  const url = mediaUrl(coverPath)
  if (!url) return false
  const upstream = await httpGet(url)
  if (upstream.status !== 200 || !upstream.body.length) return false
  let body = upstream.body
  let contentType = String(upstream.headers['content-type'] || 'image/jpeg')
  if (/\.ceb(\?|$)/i.test(url)) {
    const dec = decryptCeb(upstream.body)
    if (!dec) return false
    body = dec.body
    contentType = dec.contentType
  }
  res.setHeader('Cache-Control', 'public, max-age=3600')
  res.setHeader('Content-Type', contentType)
  res.send(body)
  return true
}

export function clearBoluoState() {
  sid = ''
  activeBase = null
  coverPathCache.clear()
}

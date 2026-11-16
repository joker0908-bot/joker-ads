import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { SITE_DATA_DIR } from './paths.mjs'
import * as huangguo from './huangguoVideos.mjs'

const PLAY_TTL_SEC = Math.max(30, Number(process.env.VIDEO_PLAY_TTL_SEC || 300))
const MEDIA_DIR = process.env.VIDEO_MEDIA_DIR || path.join(SITE_DATA_DIR, 'videos', 'media')
const CATALOG_PATH = process.env.VIDEO_CATALOG_PATH || path.join(SITE_DATA_DIR, 'videos', 'catalog.json')

export function catalogPath() {
  return CATALOG_PATH
}

export function mediaDir() {
  return MEDIA_DIR
}

function videoSecret() {
  return String(process.env.VIDEO_URL_SECRET || '')
}

function loadCatalog() {
  try {
    if (!fs.existsSync(CATALOG_PATH)) return { categories: [], videos: [] }
    const raw = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'))
    const categories = Array.isArray(raw?.categories)
      ? raw.categories.filter((c) => c && c.id && c.name).map((c) => ({
        id: String(c.id),
        name: String(c.name),
      }))
      : []
    const videos = Array.isArray(raw?.videos)
      ? raw.videos.filter((v) => v && v.id && v.title)
      : []
    return { categories, videos }
  } catch {
    return { categories: [], videos: [] }
  }
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

function safeJoin(root, rel) {
  if (!rel) return null
  const base = path.resolve(root)
  const abs = path.resolve(base, String(rel))
  const prefix = base.endsWith(path.sep) ? base : base + path.sep
  if (abs !== base && !abs.startsWith(prefix)) return null
  try {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null
  } catch {
    return null
  }
  return abs
}

function publicItem(v, categories) {
  const cat = categories.find((c) => c.id === String(v.categoryId || ''))
  const hasCover = Boolean(v.coverFile || v.cover)
  return {
    id: String(v.id),
    title: String(v.title),
    cover: hasCover ? `/api/public/videos/${encodeURIComponent(String(v.id))}/cover` : '',
    duration: Number(v.duration) || 0,
    durationText: formatDuration(v.duration),
    categoryId: v.categoryId ? String(v.categoryId) : '',
    categoryName: cat?.name || (v.categoryName ? String(v.categoryName) : ''),
  }
}

export function useHuangguo() {
  const forced = String(process.env.VIDEO_SOURCE || 'auto').toLowerCase()
  if (forced === 'local') return false
  if (forced === 'huangguo') return huangguo.configured()
  if (loadCatalog().videos.length) return false
  return huangguo.configured()
}

export function isHuangguoId(id) {
  return huangguo.isHuangguoId(id)
}

export async function listCategories() {
  if (useHuangguo()) return huangguo.categoriesFrom(await huangguo.listShows())
  return loadCatalog().categories
}

function pageVideos(rows, mapRow, { category = '', q = '', page = 1, pageSize = 20 } = {}) {
  const pageN = Math.max(1, Number(page) || 1)
  const size = Math.min(50, Math.max(1, Number(pageSize) || 20))
  let filtered = rows
  const cat = String(category || '').trim()
  if (cat) filtered = filtered.filter((v) => String(v.categoryId || v.category || '') === cat)
  const needle = String(q || '').trim().toLowerCase()
  if (needle) filtered = filtered.filter((v) => String(v.title || '').toLowerCase().includes(needle))
  const total = filtered.length
  const start = (pageN - 1) * size
  return {
    ok: true,
    page: pageN,
    pageSize: size,
    total,
    items: filtered.slice(start, start + size).map(mapRow),
    ...(total === 0 ? { code: 'empty' } : {}),
  }
}

export async function listVideos(query = {}) {
  if (useHuangguo()) {
    const shows = await huangguo.listShows()
    return pageVideos(shows, (show) => huangguo.mapItem(show), query)
  }
  const { categories, videos } = loadCatalog()
  return pageVideos(
    videos.filter((v) => !v.hidden),
    (v) => publicItem(v, categories),
    query,
  )
}

function sign(id, exp) {
  const secret = videoSecret()
  const key = secret || 'dev-only-unsigned'
  return crypto.createHmac('sha256', key).update(`${id}.${exp}`).digest('hex')
}

function httpError(status, code, message) {
  const err = new Error(message)
  err.status = status
  err.code = code
  return err
}

export function issuePlayToken(id) {
  const exp = Math.floor(Date.now() / 1000) + PLAY_TTL_SEC
  return { exp, sig: sign(id, exp), expiresAt: new Date(exp * 1000).toISOString() }
}

function signedPlay(id, extra = '') {
  const token = issuePlayToken(id)
  return {
    play: {
      url: `/api/public/videos/${encodeURIComponent(String(id))}/media?exp=${token.exp}&sig=${token.sig}${extra}`,
      expiresAt: token.expiresAt,
    },
  }
}

async function getHuangguoVideo(id, episode) {
  if (!huangguo.configured()) throw httpError(404, 'not_found', '该视频暂不可用')
  const show = await huangguo.getShow(id)
  const item = huangguo.mapItem(show)
  const episodes = Array.isArray(show.episode_list) ? show.episode_list : []
  const want = Math.max(1, Number(episode) || 1)
  const ep = episodes.find((entry) => entry.number === want && entry.unlocked)
    || episodes.find((entry) => entry.unlocked)
  if (!ep?.id) {
    return { ok: true, ...item, unavailable: true, play: null, episodes, episodeNumber: want }
  }
  const signed = signedPlay(item.id, `&ep=${ep.number}`)
  return {
    ok: true,
    ...item,
    unavailable: false,
    episodes,
    episodeNumber: ep.number,
    play: { ...signed.play, type: 'hls' },
  }
}

export async function getVideo(id, { episode } = {}) {
  if (huangguo.isHuangguoId(id)) return getHuangguoVideo(id, episode)
  const { categories, videos } = loadCatalog()
  const v = videos.find((x) => String(x.id) === String(id))
  if (!v) throw httpError(404, 'not_found', '该视频暂不可用')
  const item = publicItem(v, categories)
  if (v.unavailable || v.hidden) {
    return { ok: true, ...item, unavailable: true, play: null }
  }
  const file = safeJoin(MEDIA_DIR, v.file)
  if (!file) {
    return { ok: true, ...item, unavailable: true, play: null }
  }
  const signed = signedPlay(v.id)
  const ext = path.extname(file).slice(1).toLowerCase() || 'mp4'
  return {
    ok: true,
    ...item,
    unavailable: false,
    play: {
      ...signed.play,
      type: ext === 'm3u8' ? 'hls' : ext,
    },
  }
}

export async function writeCover(id, res) {
  if (huangguo.isHuangguoId(id)) {
    if (!huangguo.configured()) return false
    let show
    try {
      const shows = await huangguo.listShows()
      show = shows.find((row) => huangguo.toPublicId(row.id) === String(id))
    } catch {}
    if (!show?.cover) {
      try { show = await huangguo.getShow(id) } catch { return false }
    }
    const upstream = show ? await huangguo.fetchCover(show) : null
    if (!upstream) return false
    res.setHeader('Cache-Control', 'public, max-age=3600')
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/jpeg')
    Readable.fromWeb(upstream.body).pipe(res)
    return true
  }
  const file = coverFileFor(id)
  if (!file) return false
  res.setHeader('Cache-Control', 'public, max-age=3600')
  res.sendFile(file, { headers: { 'Content-Type': mimeFor(file) } })
  return true
}

export async function writePlaylist(id, episode, exp, sig, res) {
  if (!huangguo.isHuangguoId(id)) return false
  const show = await huangguo.getShow(id)
  const want = Math.max(1, Number(episode) || 1)
  const ep = (show.episode_list || []).find((entry) => entry.number === want && entry.unlocked)
    || (show.episode_list || []).find((entry) => entry.unlocked)
  if (!ep?.id) throw httpError(404, 'unavailable', '该视频暂不可用')
  const text = await huangguo.fetchPlaylist(huangguo.showIdOf(id), ep.id)
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
  res.send(huangguo.rewritePlaylist(text, id, exp, sig))
  return true
}

export async function writeSegment(id, rel, res) {
  if (!huangguo.isHuangguoId(id)) return false
  const upstream = await huangguo.fetchSegment(rel)
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'video/MP2T')
  Readable.fromWeb(upstream.body).pipe(res)
  return true
}

export function verifyPlayToken(id, exp, sig) {
  const expN = Number(exp)
  const now = Math.floor(Date.now() / 1000)
  if (!Number.isFinite(expN) || expN < now) {
    throw httpError(410, 'expired', '播放地址已失效，请返回重试')
  }
  const expected = sign(id, expN)
  const got = String(sig || '')
  const a = Buffer.from(expected)
  const b = Buffer.from(got)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw httpError(410, 'expired', '播放地址已失效，请返回重试')
  }
}

export function mediaFileFor(id) {
  const { videos } = loadCatalog()
  const v = videos.find((x) => String(x.id) === String(id))
  if (!v || v.unavailable || v.hidden) return null
  return safeJoin(MEDIA_DIR, v.file)
}

export function coverFileFor(id) {
  const { videos } = loadCatalog()
  const v = videos.find((x) => String(x.id) === String(id))
  if (!v) return null
  return safeJoin(MEDIA_DIR, v.coverFile || v.cover)
}

export function mimeFor(filePath) {
  const ext = path.extname(filePath || '').toLowerCase()
  return {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.m3u8': 'application/vnd.apple.mpegurl',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  }[ext] || 'application/octet-stream'
}

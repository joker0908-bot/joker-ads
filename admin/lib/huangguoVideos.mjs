import { upstreamPartnerKey } from './dramaApiKey.mjs'

const CATEGORY_NAMES = {
  dushi: '都市',
  tianchong: '甜宠',
  nixi: '逆袭',
  guzhuang: '古装',
  zhanshen: '战神',
  zhuxu: '赘婿',
  qihuan: '奇幻',
  xuanyi: '悬疑',
}

const PREFIX = 'hg:'
const CACHE_MS = Math.max(10_000, Number(process.env.HUANGGUO_CACHE_MS || 60_000))
const FETCH_MS = Math.max(2000, Number(process.env.HUANGGUO_FETCH_MS || 8000))

let cache = { at: 0, shows: null }

export function configured() {
  return Boolean(String(process.env.HUANGGUO_API_BASE || '').trim())
}

export function apiBase() {
  return String(process.env.HUANGGUO_API_BASE || '').trim().replace(/\/$/, '')
}

export function mediaOrigin() {
  return String(process.env.HUANGGUO_ORIGIN || '').trim().replace(/\/$/, '')
    || apiBase().replace(/\/huangguo-api$/, '')
}

export function isHuangguoId(id) {
  return String(id || '').startsWith(PREFIX)
}

export function toPublicId(showId) {
  return `${PREFIX}${showId}`
}

export function showIdOf(id) {
  const raw = String(id || '')
  return raw.startsWith(PREFIX) ? raw.slice(PREFIX.length) : raw
}

export function categoryName(id) {
  const key = String(id || '').trim()
  return CATEGORY_NAMES[key] || key
}

function httpError(status, code, message) {
  const err = new Error(message)
  err.status = status
  err.code = code
  return err
}

export function upstreamApiKey() {
  return upstreamPartnerKey()
}

function upstreamHeaders(extra) {
  const headers = extra ? { ...extra } : {}
  headers.Referer = 'https://huangguopojie.com/'
  const key = upstreamApiKey()
  if (key) headers['X-Api-Key'] = key
  return headers
}

async function fetchText(url, { timeout = FETCH_MS, accept } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      cache: 'no-store',
      headers: upstreamHeaders(accept ? { Accept: accept } : undefined),
    })
    const text = await res.text()
    return { res, text }
  } catch (e) {
    if (e?.name === 'AbortError') throw httpError(502, 'upstream', '加载失败，请检查网络后重试')
    throw httpError(502, 'upstream', '加载失败，请检查网络后重试')
  } finally {
    clearTimeout(timer)
  }
}

async function fetchBin(url, { timeout = FETCH_MS } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    return await fetch(url, { signal: ctrl.signal, cache: 'no-store' })
  } catch (e) {
    if (e?.name === 'AbortError') throw httpError(502, 'upstream', '加载失败，请检查网络后重试')
    throw httpError(502, 'upstream', '加载失败，请检查网络后重试')
  } finally {
    clearTimeout(timer)
  }
}

function normalizeShow(raw) {
  if (!raw || !raw.id || !raw.title) return null
  const episodes = Number(raw.episodes)
  return {
    id: String(raw.id),
    title: String(raw.title),
    category: raw.category ? String(raw.category) : '',
    tags: Array.isArray(raw.tags) ? raw.tags.map((tag) => String(tag)) : [],
    episodes: Number.isFinite(episodes) && episodes > 0 ? episodes : 0,
    intro: raw.intro != null ? String(raw.intro) : '',
    cover: raw.cover ? String(raw.cover) : '',
    content_updated_at: raw.content_updated_at ? String(raw.content_updated_at) : '',
    episode_list: Array.isArray(raw.episode_list) ? raw.episode_list : undefined,
  }
}

export async function listShows({ refresh = false } = {}) {
  const now = Date.now()
  if (!refresh && cache.shows && now - cache.at < CACHE_MS) return cache.shows
  const base = apiBase()
  if (!base) throw httpError(502, 'upstream', '加载失败，请检查网络后重试')
  const { res, text } = await fetchText(`${base}/api/shows`, { accept: 'application/json' })
  if (!res.ok) throw httpError(502, 'upstream', '加载失败，请检查网络后重试')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw httpError(502, 'upstream', '加载失败，请检查网络后重试')
  }
  const rows = Array.isArray(parsed?.data) ? parsed.data : []
  const shows = rows.map(normalizeShow).filter(Boolean)
  cache = { at: now, shows }
  return shows
}

export function mapItem(show) {
  const id = toPublicId(show.id)
  return {
    id,
    title: String(show.title),
    cover: show.cover ? `/api/public/videos/${encodeURIComponent(id)}/cover` : '',
    duration: 0,
    durationText: show.episodes > 0 ? `${show.episodes}集` : '',
    categoryId: show.category || '',
    categoryName: categoryName(show.category),
  }
}

export function categoriesFrom(shows) {
  const seen = new Map()
  for (const show of shows) {
    if (!show.category || seen.has(show.category)) continue
    seen.set(show.category, { id: show.category, name: categoryName(show.category) })
  }
  return [...seen.values()]
}

export async function getShow(id) {
  const showId = showIdOf(id)
  const base = apiBase()
  if (!base || !showId) throw httpError(404, 'not_found', '该视频暂不可用')
  const { res, text } = await fetchText(`${base}/api/show/${encodeURIComponent(showId)}`, {
    accept: 'application/json',
  })
  if (res.status === 404) throw httpError(404, 'not_found', '该视频暂不可用')
  if (!res.ok) throw httpError(502, 'upstream', '加载失败，请检查网络后重试')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw httpError(502, 'upstream', '加载失败，请检查网络后重试')
  }
  const show = normalizeShow(parsed?.data)
  if (!show) throw httpError(404, 'not_found', '该视频暂不可用')
  const list = Array.isArray(parsed?.data?.episode_list) ? parsed.data.episode_list : []
  show.episode_list = list
    .map((entry) => {
      if (!entry) return null
      const episodeId = entry.id ?? entry.upstream_id
      const number = Number(entry.number)
      if (episodeId == null || !Number.isFinite(number) || number < 1) return null
      return {
        id: String(episodeId),
        number,
        title: entry.title ? String(entry.title) : `第 ${number} 集`,
        unlocked: entry.unlocked !== false,
      }
    })
    .filter(Boolean)
  return show
}

export function safeMediaPath(rel) {
  if (!rel) return null
  let pathName = String(rel).trim()
  if (!pathName) return null
  if (/^https?:\/\//i.test(pathName)) {
    try {
      const u = new URL(pathName)
      pathName = u.pathname
    } catch {
      return null
    }
  }
  if (!pathName.startsWith('/huangguo/download/')) return null
  // 解码后再判一次，拦截 %2e%2e 等编码形式的目录穿越
  let decoded
  try { decoded = decodeURIComponent(pathName) } catch { return null }
  if (decoded.includes('..') || decoded.includes('\\') || decoded.includes('\0')) return null
  return pathName
}

export function rewritePlaylist(text, videoId, exp, sig) {
  const segProxy = (raw) => {
    const safe = safeMediaPath(raw)
    if (!safe) return null
    return `/api/public/videos/${encodeURIComponent(videoId)}/seg?p=${encodeURIComponent(safe)}&exp=${exp}&sig=${sig}`
  }
  return String(text || '').split(/\r?\n/).map((line) => {
    const trimmed = line.trim()
    if (!trimmed) return line
    if (trimmed.startsWith('#')) {
      // 注释行里的 URI="..."（密钥/MAP/多音轨）同样要走本地代理
      return line.replace(/URI="([^"]+)"/g, (m, uri) => {
        const proxy = segProxy(uri)
        return proxy ? `URI="${proxy}"` : m
      })
    }
    return segProxy(trimmed) || line
  }).join('\n')
}

export async function fetchCover(show) {
  const origin = mediaOrigin()
  const pathName = safeMediaPath(show?.cover)
  if (!origin || !pathName) return null
  const upstream = await fetchBin(`${origin}${pathName}`)
  if (!upstream.ok) {
    // 非 2xx 的 body 不消费会占住连接，主动丢弃
    upstream.body?.cancel().catch(() => {})
    return null
  }
  return upstream
}

export async function fetchPlaylist(showId, episodeId) {
  const base = apiBase()
  if (!base) throw httpError(502, 'upstream', '加载失败，请检查网络后重试')
  const url = `${base}/api/video/${encodeURIComponent(showId)}/${encodeURIComponent(episodeId)}?mode=local&fresh=${Date.now()}`
  const { res, text } = await fetchText(url, { accept: 'application/vnd.apple.mpegurl,application/json;q=0.5' })
  if (res.status === 404) throw httpError(404, 'not_found', '该视频暂不可用')
  if (!res.ok || !text.includes('#EXTM3U')) {
    throw httpError(502, 'unavailable', '该视频暂不可用')
  }
  return text
}

export async function fetchSegment(rel) {
  const origin = mediaOrigin()
  const pathName = safeMediaPath(rel)
  if (!origin || !pathName) throw httpError(404, 'not_found', '该视频暂不可用')
  const upstream = await fetchBin(`${origin}${pathName}`)
  if (upstream.status === 404) {
    upstream.body?.cancel().catch(() => {})
    throw httpError(404, 'not_found', '该视频暂不可用')
  }
  if (!upstream.ok) {
    upstream.body?.cancel().catch(() => {})
    throw httpError(502, 'upstream', '加载失败，请检查网络后重试')
  }
  return upstream
}

export function clearCache() {
  cache = { at: 0, shows: null }
}

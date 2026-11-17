import * as huangguo from './huangguoVideos.mjs'
import { issuePlayToken, verifyPlayToken, writeCover, writeSegment } from './siteVideos.mjs'

function httpError(status, code, message) {
  const err = new Error(message)
  err.status = status
  err.code = code
  return err
}

function publicId(showId) {
  return huangguo.toPublicId(huangguo.showIdOf(showId))
}

export function mapShow(show) {
  const id = huangguo.showIdOf(show.id)
  return {
    id,
    title: String(show.title || ''),
    category: show.category ? String(show.category) : '',
    tags: Array.isArray(show.tags) ? show.tags.map((tag) => String(tag)) : [],
    episodes: Number(show.episodes) || 0,
    intro: show.intro != null ? String(show.intro) : '',
    source: 'boluo',
    cover: show.cover ? `/boluo-api/api/cover/${encodeURIComponent(id)}` : '',
    ...(show.content_updated_at ? { content_updated_at: String(show.content_updated_at) } : {}),
  }
}

export async function listShows({ size } = {}) {
  if (!huangguo.configured()) throw httpError(502, 'upstream', '加载失败，请检查网络后重试')
  const shows = await huangguo.listShows()
  const rows = shows.map(mapShow)
  const cap = Number(size)
  if (Number.isFinite(cap) && cap > 0) return rows.slice(0, Math.min(500, Math.floor(cap)))
  return rows
}

export async function getShow(id) {
  if (!huangguo.configured()) throw httpError(502, 'upstream', '加载失败，请检查网络后重试')
  const show = await huangguo.getShow(id)
  return {
    ...mapShow(show),
    episode_list: Array.isArray(show.episode_list) ? show.episode_list : [],
  }
}

export function rewritePlaylist(text, videoId, exp, sig) {
  return String(text || '').split(/\r?\n/).map((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return line
    const safe = huangguo.safeMediaPath(trimmed)
    if (!safe) return line
    return `/boluo-api/api/seg?id=${encodeURIComponent(videoId)}&p=${encodeURIComponent(safe)}&exp=${exp}&sig=${sig}`
  }).join('\n')
}

export async function writePlaylist(showId, episodeId, res) {
  if (!huangguo.configured()) throw httpError(502, 'upstream', '加载失败，请检查网络后重试')
  const show = await huangguo.getShow(showId)
  const want = String(episodeId || '')
  const ep = (show.episode_list || []).find((entry) => String(entry.id) === want && entry.unlocked)
  if (!ep?.id) throw httpError(404, 'not_found', '该视频暂不可用')
  const text = await huangguo.fetchPlaylist(huangguo.showIdOf(show.id), ep.id)
  const videoId = publicId(show.id)
  const token = issuePlayToken(videoId)
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
  res.send(rewritePlaylist(text, videoId, token.exp, token.sig))
}

export async function writeShowCover(showId, res) {
  return writeCover(publicId(showId), res)
}

export async function writeShowSegment(videoId, rel, exp, sig, res) {
  const id = publicId(videoId)
  verifyPlayToken(id, exp, sig)
  return writeSegment(id, rel, res)
}

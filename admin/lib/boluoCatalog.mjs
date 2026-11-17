import fs from 'node:fs'
import path from 'node:path'
import { SITE_DATA_DIR } from './paths.mjs'

const CATALOG_PATH = process.env.BOLUO_CATALOG_PATH || path.join(SITE_DATA_DIR, 'videos', 'boluo-videos-catalog.json')
const TTL_MS = Math.max(60_000, Number(process.env.BOLUO_CATALOG_TTL_MS || 6 * 3600 * 1000))
const SEED_PAGES = Math.max(1, Number(process.env.BOLUO_CATALOG_SEED_PAGES || 5))
const PAGE_DELAY_MS = Math.max(20, Number(process.env.BOLUO_CATALOG_PAGE_DELAY_MS || 120))
const ENRICH_MAX = Number(process.env.BOLUO_CATALOG_ENRICH_MAX ?? 0)
const ENRICH_CONCURRENCY = Math.max(1, Number(process.env.BOLUO_CATALOG_ENRICH_CONCURRENCY || 4))
const MAX_PAGES = Math.max(10, Number(process.env.BOLUO_CATALOG_MAX_PAGES || 800))
const SKIT_PAGE_SIZE = 50

const state = {
  loaded: false,
  rows: new Map(),
  details: new Map(),
  updatedAt: 0,
  complete: false,
  refreshing: null,
  enriching: null,
  skits: new Map(),
  skitsUpdatedAt: 0,
  skitsComplete: false,
  refreshingSkits: null,
}

export function catalogPath() {
  return CATALOG_PATH
}

function load() {
  try {
    if (!fs.existsSync(CATALOG_PATH)) return
    const raw = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'))
    for (const row of raw.rows || []) {
      if (row?.id) state.rows.set(String(row.id), row)
    }
    for (const [k, v] of Object.entries(raw.details || {})) {
      state.details.set(String(k), v)
    }
    for (const row of raw.skits || []) {
      if (row?.serial_id) state.skits.set(String(row.serial_id), row)
    }
    state.updatedAt = Number(raw.updatedAt) || 0
    state.complete = Boolean(raw.complete)
    state.skitsUpdatedAt = Number(raw.skitsUpdatedAt) || 0
    state.skitsComplete = Boolean(raw.skitsComplete)
  } catch {
    // JSON 损坏等异常：回退为空目录，ensureCatalog 会因 rows 为空触发冷启动重建
  } finally {
    // 文件不存在时提前 return 也不能漏掉本标记，否则每次调用都会重复尝试读盘
    state.loaded = true
  }
}

// 原子写：先写临时文件并 fsync，再 rename 覆盖，崩溃也不会留下半个 JSON（参照 jsonStore.writeJsonAtomic，此处自实现避免循环依赖）
function persist() {
  const tmp = `${CATALOG_PATH}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.mkdirSync(path.dirname(CATALOG_PATH), { recursive: true, mode: 0o755 })
    const payload = {
      updatedAt: state.updatedAt,
      complete: state.complete,
      rows: [...state.rows.values()],
      details: Object.fromEntries(state.details),
      skitsUpdatedAt: state.skitsUpdatedAt,
      skitsComplete: state.skitsComplete,
      skits: [...state.skits.values()],
    }
    const fd = fs.openSync(tmp, 'w', 0o600)
    try {
      fs.writeFileSync(fd, JSON.stringify(payload))
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, CATALOG_PATH)
  } catch {
    try { fs.rmSync(tmp, { force: true }) } catch {}
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function harvest(api) {
  let page = 1
  let seen = 0
  while (page <= MAX_PAGES) {
    let data
    try {
      data = await api(`/videos/recommend?page=${page}&pageSize=18`)
    } catch {
      break
    }
    const rows = Array.isArray(data?.videos) ? data.videos : Array.isArray(data?.list) ? data.list : []
    if (!rows.length) break
    for (const v of rows) {
      if (!v?.id) continue
      const id = String(v.id)
      if (!state.rows.has(id)) {
        state.rows.set(id, {
          id,
          name: String(v.name || v.title || ''),
          time: Number(v.time) || 0,
          playCnt: Number(v.playCnt) || 0,
          hot: Number(v.hot) || 0,
          commentCnt: Number(v.commentCnt) || 0,
          likedCnt: Number(v.likedCnt) || 0,
          collectedCnt: Number(v.collectedCnt) || 0,
          price: Number(v.price) || 0,
          payType: v.payType ? String(v.payType) : '',
          coverURL: v.coverURL ? String(v.coverURL) : '',
          verticalCoverURL: v.verticalCoverURL ? String(v.verticalCoverURL) : '',
          width: Number(v.width) || 0,
          height: Number(v.height) || 0,
        })
        seen += 1
      }
    }
    if (page % 40 === 0) persist()
    await sleep(PAGE_DELAY_MS)
    page += 1
  }
  state.complete = true
  state.updatedAt = Date.now()
  persist()
  return seen
}

async function enrich(api) {
  let done = 0
  const ids = [...state.rows.keys()].filter((id) => !state.details.has(id))
  for (const id of ids) {
    if (done >= ENRICH_MAX) break
    done += 1
    try {
      const d = await api(`/videos/${encodeURIComponent(id)}`)
      const v = d?.video || {}
      const tags = Array.isArray(v.videoTags) ? v.videoTags : Array.isArray(v.tags) ? v.tags : []
      state.details.set(id, {
        tags: tags.map((t) => (typeof t === 'string' ? t : t?.name || t?.tag || '')).filter(Boolean),
        user: v?.user?.username ? String(v.user.username) : '',
      })
    } catch {
      state.details.set(id, { tags: [], missing: true })
    }
    if (done % 100 === 0) persist()
    await sleep(60)
  }
  persist()
}

async function enrichPool(api) {
  const pending = [...state.rows.keys()].filter((id) => {
    const d = state.details.get(id)
    return !d || (!d.missing && !d.tags?.length)
  })
  const queue = ENRICH_MAX > 0 ? pending.slice(0, ENRICH_MAX) : pending
  let idx = 0
  let done = 0
  const workers = Array.from({ length: ENRICH_CONCURRENCY }, async () => {
    while (idx < queue.length) {
      const id = queue[idx]
      idx += 1
      try {
        const d = await api(`/videos/${encodeURIComponent(id)}`)
        const v = d?.video || {}
        const tags = Array.isArray(v.videoTags) ? v.videoTags : Array.isArray(v.tags) ? v.tags : []
        state.details.set(id, {
          tags: tags.map((t) => (typeof t === 'string' ? t : t?.name || t?.tag || '')).filter(Boolean),
          user: v?.user?.username ? String(v.user.username) : '',
        })
      } catch {
        state.details.set(id, { tags: [], missing: true })
      }
      done += 1
      if (done % 100 === 0) persist()
      await sleep(80)
    }
  })
  await Promise.all(workers)
  persist()
}

export async function ensureCatalog(api) {
  if (!state.loaded) load()
  if (state.rows.size === 0 && !state.refreshing) {
    // Cold start: fetch first pages synchronously, continue the rest in background.
    let page = 1
    while (page <= SEED_PAGES) {
      try {
        const data = await api(`/videos/recommend?page=${page}&pageSize=18`)
        const rows = Array.isArray(data?.videos) ? data.videos : []
        if (!rows.length) break
        for (const v of rows) {
          if (v?.id) {
            state.rows.set(String(v.id), {
              id: String(v.id),
              name: String(v.name || v.title || ''),
              time: Number(v.time) || 0,
              playCnt: Number(v.playCnt) || 0,
              hot: Number(v.hot) || 0,
              commentCnt: Number(v.commentCnt) || 0,
              likedCnt: Number(v.likedCnt) || 0,
              collectedCnt: Number(v.collectedCnt) || 0,
              price: Number(v.price) || 0,
              payType: v.payType ? String(v.payType) : '',
              coverURL: v.coverURL ? String(v.coverURL) : '',
              verticalCoverURL: v.verticalCoverURL ? String(v.verticalCoverURL) : '',
              width: Number(v.width) || 0,
              height: Number(v.height) || 0,
            })
          }
        }
      } catch { break }
      page += 1
    }
    state.updatedAt = Date.now()
    persist()
  }
  const stale = Date.now() - state.updatedAt > TTL_MS
  if (!state.complete || stale) {
    if (!state.refreshing) {
      state.refreshing = (async () => {
        try {
          await harvest(api)
        } finally {
          state.refreshing = null
        }
      })()
    }
  }
  if (!state.enriching && ENRICH_MAX > 0) {
    state.enriching = (async () => {
      try {
        await enrichPool(api)
      } finally {
        state.enriching = null
      }
    })()
  }
}

function slimSkit(row) {
  return {
    serial_id: String(row.serial_id || row.id || ''),
    name: String(row.name || ''),
    introduction: row.introduction != null ? String(row.introduction) : '',
    total: Number(row.total) || 0,
    is_finished: Boolean(row.is_finished),
    tags: Array.isArray(row.tags) ? row.tags.map((t) => String(t)) : [],
    categoryIds: Array.isArray(row.categoryIds) ? row.categoryIds.map((c) => String(c)) : [],
    coverURL: row.coverURL ? String(row.coverURL) : '',
    playCntTotal: Number(row.playCntTotal) || 0,
    likedCntTotal: Number(row.likedCntTotal) || 0,
    collectedCntTotal: Number(row.collectedCntTotal) || 0,
    updatedDate: row.updatedDate ? String(row.updatedDate) : '',
    skitLabel: row.skitLabel ? String(row.skitLabel) : '',
  }
}

async function harvestSkits(api) {
  let page = 1
  while (page <= 100) {
    let data
    try {
      data = await api(`/skit/getSkitsByCategory?page=${page}&pageSize=${SKIT_PAGE_SIZE}`)
    } catch {
      break
    }
    const rows = Array.isArray(data?.pageData) ? data.pageData : []
    if (!rows.length) break
    for (const row of rows) {
      const sid = String(row?.serial_id || row?.id || '')
      if (sid) state.skits.set(sid, slimSkit(row))
    }
    if (page % 10 === 0) persist()
    await sleep(PAGE_DELAY_MS)
    page += 1
  }
  state.skitsComplete = true
  state.skitsUpdatedAt = Date.now()
  persist()
}

export async function ensureSkitCatalog(api) {
  if (!state.loaded) load()
  if (state.skits.size === 0 && !state.refreshingSkits) {
    try {
      const data = await api(`/skit/getSkitsByCategory?page=1&pageSize=${SKIT_PAGE_SIZE}`)
      for (const row of data?.pageData || []) {
        const sid = String(row?.serial_id || row?.id || '')
        if (sid) state.skits.set(sid, slimSkit(row))
      }
    } catch {}
  }
  const stale = Date.now() - state.skitsUpdatedAt > TTL_MS
  if (!state.skitsComplete || stale) {
    if (!state.refreshingSkits) {
      state.refreshingSkits = (async () => {
        try {
          await harvestSkits(api)
        } finally {
          state.refreshingSkits = null
        }
      })()
    }
  }
}

export function querySkits({ page, pageSize, category, tag, q, sort } = {}) {
  const pageN = Math.max(1, Number(page) || 1)
  const size = Math.min(50, Math.max(1, Number(pageSize) || 20))
  let rows = [...state.skits.values()]
  const cat = String(category || '').trim()
  if (cat) rows = rows.filter((r) => r.categoryIds.includes(cat))
  const wantTag = String(tag || '').trim()
  if (wantTag) rows = rows.filter((r) => r.tags.includes(wantTag))
  const needle = String(q || '').trim().toLowerCase()
  if (needle) rows = rows.filter((r) => r.name.toLowerCase().includes(needle))
  const mode = String(sort || 'recommend')
  if (mode === 'latest') rows = [...rows].sort((a, b) => String(b.updatedDate).localeCompare(String(a.updatedDate)))
  else if (mode === 'views') rows = [...rows].sort((a, b) => b.playCntTotal - a.playCntTotal)
  const total = rows.length
  const start = (pageN - 1) * size
  return {
    rows: rows.slice(start, start + size),
    total,
    page: pageN,
    pageSize: size,
    complete: state.skitsComplete,
    updatedAt: state.skitsUpdatedAt ? new Date(state.skitsUpdatedAt).toISOString() : '',
  }
}

export function skitRow(serialId) {
  return state.skits.get(String(serialId || '')) || null
}

export function queryVideos({ page, pageSize, sort, q, tag } = {}) {
  const pageN = Math.max(1, Number(page) || 1)
  const size = Math.min(50, Math.max(1, Number(pageSize) || 20))
  let rows = [...state.rows.values()]
  const needle = String(q || '').trim().toLowerCase()
  if (needle) rows = rows.filter((r) => r.name.toLowerCase().includes(needle))
  const wantTag = String(tag || '').trim()
  if (wantTag) {
    rows = rows.filter((r) => {
      const d = state.details.get(r.id)
      return Array.isArray(d?.tags) && d.tags.includes(wantTag)
    })
  }
  const mode = String(sort || 'recommend')
  if (mode === 'hot') rows = [...rows].sort((a, b) => b.hot - a.hot)
  else if (mode === 'views') rows = [...rows].sort((a, b) => b.playCnt - a.playCnt)
  else if (mode === 'duration') rows = [...rows].sort((a, b) => b.time - a.time)
  const total = rows.length
  const start = (pageN - 1) * size
  return {
    rows: rows.slice(start, start + size),
    total,
    page: pageN,
    pageSize: size,
    enriched: state.details.size,
    complete: state.complete,
    updatedAt: state.updatedAt ? new Date(state.updatedAt).toISOString() : '',
  }
}

export function catalogStats() {
  return {
    videos: state.rows.size,
    enriched: state.details.size,
    complete: state.complete,
    updatedAt: state.updatedAt ? new Date(state.updatedAt).toISOString() : '',
    refreshing: Boolean(state.refreshing),
    enriching: Boolean(state.enriching),
    skits: state.skits.size,
    skitsComplete: state.skitsComplete,
    skitsUpdatedAt: state.skitsUpdatedAt ? new Date(state.skitsUpdatedAt).toISOString() : '',
    refreshingSkits: Boolean(state.refreshingSkits),
  }
}

export function rowTags(id) {
  return state.details.get(String(id))?.tags || []
}

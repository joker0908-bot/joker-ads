/**
 * Surgical tabbar patch for the running admin SITE_DATA_DIR.
 * Sets 应用/精选/AI短剧/抖阴/我的. Does not replace apps or popups.
 */
import { readDraft, readLive, writeDraft, writeLive } from '../lib/jsonStore.mjs'

const TABBAR = [
  { id: 'apps', label: '应用', icon: 'grid' },
  { id: 'featured', label: '精选', icon: 'crown' },
  { id: 'video', label: 'AI短剧', icon: 'film' },
  { id: 'douyin', label: '抖阴', icon: 'music' },
  { id: 'mine', label: '我的', icon: 'smile' },
]

function patchConfig(config) {
  const next = { ...(config || {}) }
  next.tabbar = TABBAR.map((t) => ({ ...t }))
  return next
}

function patchTabs(tabs) {
  const next = { ...(tabs || {}) }
  next.routes = { ...(next.routes || {}) }
  delete next.routes.invite
  delete next.routes.home
  next.routes.apps = next.routes.apps || '/appcenter'
  next.routes.featured = next.routes.featured || '/videosPage'
  next.routes.video = '/video'
  next.routes.douyin = next.routes.douyin || '/short'
  next.routes.mine = next.routes.mine || '/my'
  return next
}

const liveConfig = readLive('config.json')
if (!liveConfig || typeof liveConfig !== 'object') {
  throw new Error('live config.json missing or invalid — stop')
}

const before = (liveConfig.tabbar || []).map((t) => `${t.id}:${t.label}`).join(',')
writeLive('config.json', patchConfig(liveConfig))
writeLive('tabs.json', patchTabs(readLive('tabs.json') || {}))

const draftConfig = readDraft('config.json') || liveConfig
const draftTabs = readDraft('tabs.json') || {}
writeDraft('config.json', patchConfig(draftConfig))
writeDraft('tabs.json', patchTabs(draftTabs))

const meta = readLive('meta.json') || readDraft('meta.json') || { version: 0 }
meta.version = Number(meta.version || 0) + 1
meta.publishedAt = new Date().toISOString()
writeLive('meta.json', meta)
writeDraft('meta.json', meta)

const after = (readLive('config.json').tabbar || []).map((t) => `${t.id}:${t.label}`).join(',')
console.log(JSON.stringify({
  ok: true,
  before,
  after,
  version: meta.version,
  publishedAt: meta.publishedAt,
}))

import { computed } from 'vue'
import { useSiteConfig } from './useSiteConfig.js'
import tabsFallback from '../data/tabs.json'

const HIDDEN_TABS = new Set(['invite', 'home'])
const VIDEO_TAB = { id: 'video', label: 'AI短剧', icon: 'film' }

function withVideoTab(raw) {
  const items = raw.filter((t) => t && t.id && !HIDDEN_TABS.has(t.id)).map((t) => (
    t.id === 'video' ? { ...t, label: VIDEO_TAB.label } : t
  ))
  if (items.some((t) => t.id === 'video')) return items
  const featuredAt = items.findIndex((t) => t.id === 'featured')
  const douyinAt = items.findIndex((t) => t.id === 'douyin')
  const next = [...items]
  if (featuredAt >= 0) next.splice(featuredAt + 1, 0, VIDEO_TAB)
  else if (douyinAt >= 0) next.splice(douyinAt, 0, VIDEO_TAB)
  else next.splice(Math.min(2, next.length), 0, VIDEO_TAB)
  return next
}

export function useTabbar() {
  const siteConfig = useSiteConfig()
  const items = computed(() => withVideoTab(siteConfig.config.tabbar || []))
  const routes = computed(() => ({
    invite: '/invite',
    home: '/invite',
    ...(tabsFallback.routes || {}),
    ...(siteConfig.tabs?.routes || {}),
    video: '/video',
  }))
  return { items, routes }
}

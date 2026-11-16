<template>
  <TabShell active="video">
    <header class="vid-head">
      <h1>AI短剧</h1>
      <form class="vid-search" @submit.prevent="runSearch">
        <input
          v-model="keyword"
          type="search"
          enterkeyhint="search"
          placeholder="搜索短剧"
          @keyup.enter="runSearch"
        />
        <button type="submit">搜索</button>
      </form>
    </header>

    <nav v-if="categories.length" class="cat-tabs">
      <button
        class="cat-tab"
        :class="{ 'is-active': !categoryId }"
        @click="setCategory('')"
      >全部</button>
      <button
        v-for="c in categories"
        :key="c.id"
        class="cat-tab"
        :class="{ 'is-active': categoryId === c.id }"
        @click="setCategory(c.id)"
      >{{ c.name }}</button>
    </nav>

    <section v-if="loading && !items.length" class="status">加载中…</section>
    <section v-else-if="error" class="status status--err">
      <p>{{ error }}</p>
      <button type="button" class="retry" @click="load()">重试</button>
    </section>
    <section v-else-if="!items.length" class="status">暂无视频</section>
    <section v-else class="video-list">
      <article
        v-for="v in items"
        :key="v.id"
        class="video-row"
        @click="openVideo(v)"
      >
        <div class="video-row__cover">
          <img v-if="v.cover" :src="v.cover" alt="" />
          <span v-if="v.durationText" class="video-row__badge">{{ v.durationText }}</span>
        </div>
        <div class="video-row__body">
          <h3>{{ v.title }}</h3>
        </div>
      </article>
    </section>

    <nav v-if="total > pageSize" class="pager">
      <button type="button" :disabled="page <= 1 || loading" @click="setPage(page - 1)">上一页</button>
      <span>{{ page }} / {{ pageCount }}</span>
      <button type="button" :disabled="page >= pageCount || loading" @click="setPage(page + 1)">下一页</button>
    </nav>
  </TabShell>
</template>

<script>
export default { name: 'VideoPage' }
</script>

<script setup>
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import TabShell from '../components/TabShell.vue'
import { fetchSiteVideoCategories, fetchSiteVideos } from '../api/siteVideos.js'

const POS_KEY = 'dw_video_list_pos'
const PAGE_SIZE = 20

const route = useRoute()
const router = useRouter()
const keyword = ref(String(route.query.q || ''))
const categoryId = ref(String(route.query.category || ''))
const page = ref(Math.max(1, Number(route.query.page) || 1))
const pageSize = ref(PAGE_SIZE)
const total = ref(0)
const items = ref([])
const categories = ref([])
const loading = ref(false)
const error = ref('')
let loadToken = 0
const scroller = () => document.scrollingElement || document.documentElement

const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))

function savePos() {
  try {
    sessionStorage.setItem(POS_KEY, JSON.stringify({
      categoryId: categoryId.value,
      q: keyword.value,
      page: page.value,
      scrollTop: scroller().scrollTop || 0,
    }))
  } catch {}
}

function restorePos() {
  try {
    const raw = sessionStorage.getItem(POS_KEY)
    if (!raw) return 0
    const pos = JSON.parse(raw)
    return Number(pos?.scrollTop) || 0
  } catch {
    return 0
  }
}

function syncQuery() {
  const query = {}
  if (keyword.value) query.q = keyword.value
  if (categoryId.value) query.category = categoryId.value
  if (page.value > 1) query.page = String(page.value)
  const path = keyword.value ? '/video/search' : '/video'
  router.replace({ path, query })
}

async function load() {
  const token = ++loadToken
  loading.value = true
  error.value = ''
  try {
    const data = await fetchSiteVideos({
      category: categoryId.value,
      q: keyword.value,
      page: page.value,
      pageSize: PAGE_SIZE,
    })
    if (token !== loadToken) return
    items.value = Array.isArray(data.items) ? data.items : []
    total.value = Number(data.total) || 0
    pageSize.value = Number(data.pageSize) || PAGE_SIZE
    if (Number(data.page) >= 1) page.value = Number(data.page)
  } catch (e) {
    if (token !== loadToken) return
    items.value = []
    total.value = 0
    error.value = e?.message || '加载失败，请检查网络后重试'
  } finally {
    if (token === loadToken) loading.value = false
  }
}

async function loadCategories() {
  try {
    const data = await fetchSiteVideoCategories()
    categories.value = Array.isArray(data.categories) ? data.categories : []
  } catch {
    categories.value = []
  }
}

function runSearch() {
  page.value = 1
  syncQuery()
  load()
}

function setCategory(id) {
  categoryId.value = id
  page.value = 1
  syncQuery()
  load()
}

function setPage(next) {
  page.value = Math.min(pageCount.value, Math.max(1, next))
  syncQuery()
  load().then(() => {
    scroller().scrollTop = 0
  })
}

function openVideo(v) {
  if (!v?.id) return
  savePos()
  router.push(`/video/${encodeURIComponent(v.id)}`)
}

watch(() => route.query, (query) => {
  if (route.path !== '/video' && route.path !== '/video/search') return
  keyword.value = String(query.q || '')
  categoryId.value = String(query.category || '')
  page.value = Math.max(1, Number(query.page) || 1)
}, { flush: 'sync' })

onMounted(async () => {
  await loadCategories()
  await load()
  const top = restorePos()
  if (top) requestAnimationFrame(() => { scroller().scrollTop = top })
})

onActivated(() => {
  const top = restorePos()
  if (top) requestAnimationFrame(() => { scroller().scrollTop = top })
})

onDeactivated(savePos)
onBeforeUnmount(savePos)
</script>

<style scoped>
.vid-head {
  padding: 0.22rem var(--bl-pad-x) 0.12rem;
}
.vid-head h1 {
  color: #fff;
  font-size: 0.4rem;
  font-weight: 700;
}
.vid-search {
  display: flex;
  gap: 0.12rem;
  margin-top: 0.16rem;
}
.vid-search input {
  background: var(--bl-surface);
  border: 1px solid var(--bl-hair);
  border-radius: 999px;
  color: var(--bl-text);
  flex: 1;
  font-size: 0.28rem;
  min-width: 0;
  padding: 0.16rem 0.24rem;
}
.vid-search button,
.retry {
  background: var(--bl-grad); box-shadow: var(--bl-glow-shadow);
  border: none;
  border-radius: 999px;
  color: var(--bl-on-accent);
  flex-shrink: 0;
  font-size: 0.26rem;
  font-weight: 700;
  padding: 0.14rem 0.24rem;
}
.cat-tabs {
  display: flex;
  gap: 0.16rem;
  overflow-x: auto;
  padding: 0.08rem var(--bl-pad-x) 0.16rem;
  white-space: nowrap;
}
.cat-tab {
  background: none;
  border: none;
  border-radius: 999px;
  color: var(--bl-faint);
  font-size: 0.3rem;
  padding: 0.1rem 0.18rem;
}
.cat-tab.is-active {
  background: var(--bl-surface);
  border: 1px solid var(--bl-hair);
  color: var(--bl-text);
  font-weight: 600;
}
.status {
  color: var(--bl-muted);
  font-size: 0.3rem;
  padding: 1.2rem var(--bl-pad-x);
  text-align: center;
}
.status--err .retry {
  margin-top: 0.24rem;
}
.video-list {
  display: grid;
  gap: 0.2rem;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  padding: 0 var(--bl-pad-x) 0.32rem;
}
.video-row {
  background: var(--bl-surface);
  border: 1px solid var(--bl-hair);
  border-radius: var(--bl-radius);
  min-width: 0;
  overflow: hidden;
}
.video-row:active {
  opacity: 0.75;
}
.video-row__cover {
  aspect-ratio: 3 / 4;
  background: var(--bl-surface-2);
  overflow: hidden;
  position: relative;
}
.video-row__cover img {
  display: block;
  height: 100%;
  object-fit: cover;
  width: 100%;
}
.video-row__badge {
  background: rgba(9, 10, 13, 0.8);
  border-radius: 999px;
  bottom: 0.08rem;
  color: #fff;
  font-size: 0.2rem;
  padding: 0.04rem 0.1rem;
  position: absolute;
  right: 0.08rem;
}
.video-row__body {
  padding: 0.12rem 0.1rem 0.14rem;
}
.video-row__body h3 {
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  color: #fff;
  display: -webkit-box;
  font-size: 0.26rem;
  line-height: 1.35;
  min-height: 2.7em;
  overflow: hidden;
}
.pager {
  align-items: center;
  display: flex;
  gap: 0.2rem;
  justify-content: center;
  padding: 0.12rem 0 0.4rem;
}
.pager button {
  background: var(--bl-surface);
  border: 1px solid var(--bl-hair);
  border-radius: 999px;
  color: var(--bl-text);
  font-size: 0.26rem;
  padding: 0.12rem 0.22rem;
}
.pager button:disabled {
  opacity: 0.4;
}
.pager span {
  color: var(--bl-muted);
  font-size: 0.26rem;
}
</style>

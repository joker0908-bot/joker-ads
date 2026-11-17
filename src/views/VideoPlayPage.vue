<template>
  <div class="play" :class="{ 'is-fill': fill }">
    <header class="play__bar">
      <button class="play__back" type="button" @click="goBack">‹</button>
      <span class="play__bar-title">{{ detail?.title || '播放' }}</span>
      <button class="play__fill" type="button" @click="fill = !fill">{{ fill ? '还原' : '铺满' }}</button>
    </header>

    <div class="play__stage">
      <video
        ref="videoEl"
        class="play__video"
        controls
        playsinline
        webkit-playsinline="true"
        x5-playsinline="true"
        x5-video-player-type="h5"
        :poster="detail?.cover || undefined"
        @error="onVideoError"
      />
      <div v-if="status" class="play__status">
        <p>{{ status }}</p>
        <button v-if="canRetry" type="button" class="retry" @click="load(true)">重试</button>
      </div>
    </div>

    <section v-if="detail" class="play__meta">
      <h1>{{ detail.title }}</h1>
      <p class="play__stats">
        <template v-if="detail.categoryName">{{ detail.categoryName }} · </template>
        {{ detail.durationText || '—' }}
      </p>
      <nav v-if="episodes.length > 1" class="play__eps">
        <button
          v-for="ep in episodes"
          :key="ep.number"
          type="button"
          :class="{ 'is-active': ep.number === episodeNumber }"
          @click="setEpisode(ep.number)"
        >{{ ep.number }}</button>
      </nav>
    </section>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { fetchSiteVideo } from '../api/siteVideos.js'

const route = useRoute()
const router = useRouter()
const videoEl = ref(null)
const detail = ref(null)
const status = ref('加载中…')
const canRetry = ref(false)
const fill = ref(false)
const episodes = computed(() => Array.isArray(detail.value?.episodes) ? detail.value.episodes : [])
const episodeNumber = computed(() => Math.max(1, Number(route.query.ep || detail.value?.episodeNumber) || 1))
let loadSeq = 0
let refreshing = false
let hls = null

function goBack() {
  if (fill.value) {
    fill.value = false
    return
  }
  if (window.history.length > 1) router.back()
  else router.push('/video')
}

function setEpisode(n) {
  const next = Math.max(1, Number(n) || 1)
  if (next === episodeNumber.value) return
  router.replace({ query: { ...route.query, ep: String(next) } })
}

function destroy() {
  if (hls) {
    try { hls.destroy() } catch {}
    hls = null
  }
  const el = videoEl.value
  if (!el) return
  try { el.pause() } catch {}
  el.removeAttribute('src')
  try { el.load() } catch {}
}

function onVideoError() {
  status.value = '网络中断，请稍后重试'
  canRetry.value = true
}

function isHls(url, type) {
  return type === 'hls' || /\.m3u8(\?|$)/i.test(url)
}

async function attach(url, type) {
  const el = videoEl.value
  if (!el || !url) throw new Error('no media')
  destroy()
  if (isHls(url, type)) {
    const { default: Hls } = await import('hls.js')
    if (Hls.isSupported()) {
      await new Promise((resolve, reject) => {
        hls = new Hls({ enableWorker: true })
        hls.loadSource(url)
        hls.attachMedia(el)
        hls.on(Hls.Events.MANIFEST_PARSED, () => resolve())
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (data?.fatal) reject(new Error('hls fatal'))
        })
      })
      try { await el.play() } catch {}
      return
    }
    if (el.canPlayType('application/vnd.apple.mpegurl')) {
      el.src = url
      try { await el.play() } catch {}
      return
    }
    throw new Error('unsupported')
  }
  await new Promise((resolve, reject) => {
    const onOk = () => { cleanup(); resolve() }
    const onErr = () => { cleanup(); reject(new Error('media error')) }
    const cleanup = () => {
      el.removeEventListener('loadeddata', onOk)
      el.removeEventListener('error', onErr)
    }
    el.addEventListener('loadeddata', onOk, { once: true })
    el.addEventListener('error', onErr, { once: true })
    el.src = url
    el.load()
  })
  try { await el.play() } catch {}
}

async function load(isRetry = false) {
  const id = route.params.id
  const ep = episodeNumber.value
  const seq = ++loadSeq
  canRetry.value = false
  if (!id) {
    status.value = '该视频暂不可用'
    return
  }
  status.value = isRetry ? '重试中…' : '加载中…'
  if (!isRetry) detail.value = null
  destroy()
  try {
    const data = await fetchSiteVideo(id, { ep })
    if (seq !== loadSeq) return
    detail.value = data
    if (data.unavailable || !data.play?.url) {
      status.value = '该视频暂不可用'
      canRetry.value = true
      return
    }
    status.value = ''
    await attach(data.play.url, data.play.type)
    if (seq !== loadSeq) return
  } catch (e) {
    if (seq !== loadSeq) return
    if (e?.code === 'expired' && !refreshing) {
      refreshing = true
      try {
        const again = await fetchSiteVideo(id, { ep })
        if (seq !== loadSeq) return
        detail.value = again
        if (again.play?.url) {
          status.value = ''
          await attach(again.play.url, again.play.type)
          return
        }
      } catch {
        status.value = '播放地址已失效，请返回重试'
        canRetry.value = true
        return
      } finally {
        refreshing = false
      }
    }
    if (e?.code === 'not_found' || e?.status === 404) {
      status.value = '该视频暂不可用'
      canRetry.value = false
      return
    }
    if (e?.code === 'expired') {
      status.value = '播放地址已失效，请返回重试'
      canRetry.value = true
      return
    }
    status.value = e?.code === 'network' ? '网络中断，请稍后重试' : (e?.message || '加载失败，请检查网络后重试')
    canRetry.value = true
  }
}

onMounted(() => load())
watch(() => [route.params.id, route.query.ep], () => load())
onBeforeUnmount(destroy)
</script>

<style scoped>
.play {
  background: var(--bl-bg);
  min-height: 100vh;
  padding-bottom: 0.4rem;
}
.play.is-fill {
  background: #000;
}
.play__bar {
  align-items: center;
  display: flex;
  gap: 0.16rem;
  padding: 0.16rem 0.24rem;
}
.play__back,
.play__fill {
  background: var(--bl-accent-dim);
  border: 1px solid var(--bl-line);
  color: var(--bl-accent-soft);
}
.play__back {
  border-radius: 50%;
  font-size: 0.48rem;
  height: 0.72rem;
  line-height: 0.64rem;
  padding: 0;
  width: 0.72rem;
}
.play__fill {
  border-radius: 999px;
  font-size: 0.24rem;
  margin-left: auto;
  padding: 0.08rem 0.16rem;
}
.play__bar-title {
  color: #fff;
  flex: 1;
  font-size: 0.32rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.play__stage {
  background: #000;
  position: relative;
  width: 100%;
}
.play__video {
  aspect-ratio: 16 / 9;
  display: block;
  width: 100%;
}
.play.is-fill .play__stage,
.play.is-fill .play__video {
  height: 100vh;
  height: 100dvh;
}
.play.is-fill .play__stage {
  inset: 0;
  position: fixed;
  z-index: 80;
}
.play.is-fill .play__video {
  aspect-ratio: auto;
  object-fit: contain;
}
.play.is-fill .play__bar {
  position: relative;
  z-index: 90;
}
.play.is-fill .play__meta {
  display: none;
}
.play__status {
  color: rgba(255, 255, 255, 0.75);
  font-size: 0.28rem;
  left: 0;
  position: absolute;
  text-align: center;
  top: 50%;
  transform: translateY(-50%);
  width: 100%;
  z-index: 2;
}
.retry {
  background: var(--bl-grad); box-shadow: var(--bl-glow-shadow);
  border: none;
  border-radius: 999px;
  color: var(--bl-on-accent);
  font-size: 0.26rem;
  font-weight: 700;
  margin-top: 0.18rem;
  padding: 0.12rem 0.24rem;
}
.play__meta {
  padding: 0.24rem 0.32rem;
}
.play__meta h1 {
  color: #fff;
  font-size: 0.34rem;
  line-height: 1.4;
}
.play__stats {
  color: rgba(255, 255, 255, 0.45);
  font-size: 0.26rem;
  margin-top: 0.12rem;
}
.play__eps {
  display: flex;
  flex-wrap: wrap;
  gap: 0.12rem;
  margin-top: 0.2rem;
}
.play__eps button {
  background: var(--bl-surface);
  border: 1px solid var(--bl-hair);
  border-radius: 0.1rem;
  color: var(--bl-text);
  font-size: 0.26rem;
  min-width: 0.64rem;
  padding: 0.1rem 0.14rem;
}
.play__eps button.is-active {
  background: var(--bl-grad); box-shadow: var(--bl-glow-shadow);
  border-color: var(--bl-neon);
  color: var(--bl-on-accent);
  font-weight: 700;
}
</style>

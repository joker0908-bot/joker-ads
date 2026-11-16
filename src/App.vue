<template>
  <div v-if="!siteConfig.ready" class="boot">加载中…</div>
  <div v-else class="app-shell">
    <section v-if="siteConfig.error" role="status" class="config-error">
      {{ siteConfig.error }} <button @click="loadSiteConfig">重试</button>
    </section>
    <router-view v-slot="{ Component }">
      <KeepAlive include="VideoPage">
        <component :is="Component" />
      </KeepAlive>
    </router-view>
    <AdPopup v-if="!isWatching && !isInvite && !customerState.isVip" :popups="siteConfig.config.popups" />
    <ToastHost />
    <IdentityCard v-if="!isInvite" v-model="showCard" />
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useSiteConfig, loadSiteConfig } from './composables/useSiteConfig.js'
import { customerState, shouldAutoShowCard, markCardShown } from './composables/useCustomer.js'
import IdentityCard from './components/IdentityCard.vue'
import AdPopup from './components/AdPopup.vue'
import ToastHost from './components/ToastHost.vue'

const siteConfig = useSiteConfig()
const route = useRoute()
const showCard = ref(false)
const isInvite = computed(() => route.path === '/invite')
watch(() => customerState.ready, () => {
  if (!isInvite.value && shouldAutoShowCard()) { showCard.value = true; markCardShown() }
}, { immediate: true })
const isWatching = computed(() => {
  const p = route.path
  return p.startsWith('/play/') || p.startsWith('/short') || (p.startsWith('/video/') && p !== '/video/search')
})
</script>

<style scoped>
.config-error { padding: 12px; color: #fff; background: #493712; }
.config-error button { margin-left: 12px; padding: 4px 12px; }
.app-shell,
.boot {
  min-height: 100vh;
  background: var(--bl-bg);
}
.boot {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--bl-muted);
  font-size: 14px;
  letter-spacing: 0.12em;
}
</style>

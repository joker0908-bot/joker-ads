<template>
  <div class="tab-shell">
    <slot />
    <TabBar :items="tabbar" :active="active" @change="onChange" />
  </div>
</template>

<script setup>
import { useRouter } from 'vue-router'
import TabBar from './TabBar.vue'
import { useTabbar } from '../composables/useTabbar.js'
import tabsFallback from '../data/tabs.json'

defineProps({ active: { type: String, default: 'apps' } })

const router = useRouter()
const { items: tabbar, routes: routeMap } = useTabbar()

function onChange(id) {
  const path = routeMap.value[id] || tabsFallback.routes?.[id] || '/appcenter'
  if (router.currentRoute.value.path !== path) router.push(path)
}
</script>

<style scoped>
.tab-shell {
  min-height: 100vh;
  padding-bottom: calc(var(--bl-tabbar-h) + env(safe-area-inset-bottom));
}
</style>

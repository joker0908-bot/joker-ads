<template>
  <nav class="tabbar">
    <button
      v-for="item in items"
      :key="item.id"
      class="tabbar-item"
      :class="{ 'is-active': active === item.id }"
      @click="$emit('change', item.id)"
    >
      <span class="tabbar-item__icon" v-html="iconSvg(item.icon)" />
      <span class="tabbar-item__text">{{ item.label }}</span>
    </button>
  </nav>
</template>

<script setup>
defineProps({
  items: { type: Array, required: true },
  active: { type: String, default: 'apps' },
})

defineEmits(['change'])

const icons = {
  home: `<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M12 3.2 3 11h2.2v9h5.1v-6.2h3.4V20h5.1v-9H21L12 3.2z"/></svg>`,
  grid: `<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><rect x="3" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6"/></svg>`,
  crown: `<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M3 19h18v-2H3v2zm1.5-4h15L21 7l-5 3-4-6-4 6-5-3 1.5 8z"/></svg>`,
  film: `<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M4 5h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm14 1.2 4-2.2v16l-4-2.2V6.2zM6 8v2h2V8H6zm0 4v2h2v-2H6z"/></svg>`,
  music: `<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M17 3v10.26A4 4 0 1 0 19 17V7h4V3h-6zM7 13a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"/></svg>`,
  smile: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><circle cx="9" cy="10" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="1.1" fill="currentColor" stroke="none"/><path d="M8.2 14.2c1.1 1.6 2.4 2.4 3.8 2.4s2.7-.8 3.8-2.4"/></svg>`,
}

// v-html 只渲染白名单内自带的 SVG；item.icon 来自配置数据，
// 必须用 hasOwnProperty 判定，避免 constructor 等原型链键取到非预期值。
function iconSvg(name) {
  return Object.prototype.hasOwnProperty.call(icons, name) ? icons[name] : ''
}
</script>

<style scoped>
.tabbar {
  background: rgba(11, 7, 22, 0.92);
  border-top: 1px solid var(--bl-hair);
  bottom: 0;
  box-sizing: border-box;
  display: flex;
  height: var(--bl-tabbar-h);
  left: 0;
  padding-bottom: env(safe-area-inset-bottom);
  position: fixed;
  right: 0;
  width: 100%;
  z-index: 100;
  backdrop-filter: blur(14px);
}

.tabbar-item {
  align-items: center;
  background: transparent;
  color: var(--bl-faint);
  cursor: pointer;
  display: flex;
  flex: 1;
  flex-direction: column;
  justify-content: center;
  line-height: 1;
  padding: 0.14rem 0;
  position: relative;
  transition: color 0.2s var(--bl-ease);
}

.tabbar-item.is-active {
  color: var(--bl-accent);
  text-shadow: 0 0 12px rgba(255, 79, 216, 0.65);
}

.tabbar-item.is-active::before {
  background: var(--bl-grad); box-shadow: var(--bl-glow-shadow);
  border-radius: 99px;
  content: '';
  height: 0.05rem;
  left: 32%;
  position: absolute;
  right: 32%;
  top: 0;
}

.tabbar-item__icon {
  align-items: center;
  display: flex;
  height: 0.5rem;
  justify-content: center;
  margin-bottom: 0.1rem;
}

.tabbar-item__text {
  font-size: 0.22rem;
  font-weight: 500;
  letter-spacing: 0.04em;
}

.tabbar-item.is-active .tabbar-item__text {
  font-weight: 700;
}
</style>

<template>
  <div class="stage">
    <header class="top">
      <div class="brand">
        <img src="/brand/logo.png" alt="菠萝视频" width="104" height="104" />
      </div>
      <nav>
        <button type="button" @click="openBiz">商务合作</button>
        <button type="button" @click="router.push('/message')">官方客服</button>
        <button type="button" @click="openCard">我的身份卡</button>
      </nav>
    </header>

    <div class="frame">
      <div class="hero">
        <div class="copy">
          <p class="eyebrow">菠萝视频成人版 · 你的专属阅片社区</p>
          <h1>独家百万资源库<br />沉浸式阅片新纪元</h1>
          <p class="lead">精彩成人视频爽不停</p>
          <div class="tags">
            <span>独家原创</span>
            <span>全网资源</span>
            <span>反差女友</span>
            <span>每日更新</span>
          </div>
        </div>
        <div class="visual">
          <div class="visual__clip">
            <div class="visual__glow" aria-hidden="true" />
            <img class="visual__logo" src="/brand/logo.png" alt="菠萝视频" />
            <p class="visual__name">菠萝视频</p>
          </div>
        </div>
      </div>

      <aside class="dock">
        <div class="qr-block">
          <img v-if="qr" :src="qr" alt="扫码进入菠萝视频" />
          <p>扫码下载或打开菠萝视频<br />支持 iOS / 安卓 / 电脑浏览器</p>
        </div>
        <div class="cta">
          <button type="button" class="cta__enter" @click="enter">进入菠萝视频</button>
          <button type="button" class="cta__copy" @click="copyLink">复制邀请链接</button>
        </div>
      </aside>
    </div>

    <IdentityCard v-model="showCard" />
  </div>
</template>

<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import IdentityCard from '../components/IdentityCard.vue'
import { customerState, boluoInviteUrl, shouldAutoShowCard, markCardShown } from '../composables/useCustomer.js'
import { qrDataUrl } from '../lib/qr.js'
import { copyText, showToast } from '../composables/useToast.js'

const router = useRouter()
const qr = ref('')
const showCard = ref(false)

onMounted(async () => {
  document.documentElement.dataset.landing = 'invite'
  try {
    qr.value = await qrDataUrl(boluoInviteUrl(customerState.inviteCode), 200)
  } catch {}
  if (shouldAutoShowCard()) {
    showCard.value = true
    markCardShown()
  }
})

onUnmounted(() => {
  delete document.documentElement.dataset.landing
})

function enter() {
  router.push('/appcenter')
}

function openCard() {
  showCard.value = true
}

function openBiz() {
  window.open('https://t.me/Ailen99999', '_blank', 'noopener,noreferrer')
}

async function copyLink() {
  const url = boluoInviteUrl(customerState.inviteCode)
  showToast((await copyText(url)) ? '邀请链接已复制' : '复制失败')
}
</script>

<style scoped>
.stage {
  background:
    radial-gradient(ellipse 60% 50% at 80% 40%, rgba(255, 79, 216, 0.12), transparent 55%),
    radial-gradient(ellipse 40% 40% at 10% 10%, rgba(255, 79, 216, 0.08), transparent 50%),
    var(--bl-bg);
  color: var(--bl-text);
  display: flex;
  flex-direction: column;
  align-items: center;
  min-height: 100vh;
  overflow-x: hidden;
  padding: 20px 28px 40px;
}
.top,
.frame {
  width: 100%;
  max-width: 1280px;
}
.frame {
  display: flex;
  flex-direction: column;
}
.top {
  align-items: center;
  display: flex;
  justify-content: space-between;
  gap: 16px;
}
.brand img {
  border-radius: 22px;
  display: block;
  height: 104px;
  width: 104px;
}
nav {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
nav button {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--bl-hair);
  border-radius: 999px;
  color: var(--bl-text);
  font-size: 13px;
  padding: 8px 14px;
}
.hero {
  align-items: center;
  display: grid;
  gap: 28px;
  grid-template-columns: minmax(0, 1fr);
  margin-top: 28px;
}
.copy h1 {
  font-size: clamp(28px, 6vw, 48px);
  letter-spacing: 0.04em;
  line-height: 1.2;
  margin: 10px 0 14px;
}
.eyebrow,
.lead {
  color: rgba(247, 243, 255, 0.7);
  font-size: 16px;
}
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 20px 0 0;
}
.tags span {
  background: var(--bl-grad); box-shadow: var(--bl-glow-shadow);
  border-radius: 999px;
  color: var(--bl-on-accent);
  font-size: 13px;
  font-weight: 700;
  padding: 6px 12px;
}
.visual {
  min-width: 0;
  width: 100%;
}
.visual__clip {
  aspect-ratio: 16 / 9;
  background: var(--bl-bg);
  border-radius: 24px;
  overflow: hidden;
  position: relative;
  width: 100%;
}
.visual__clip {
  align-items: center;
  background: var(--bl-hex), var(--bl-grad-soft), var(--bl-bg-deep);
  border: 1px solid var(--bl-line);
  display: flex;
  flex-direction: column;
  justify-content: center;
}
.visual__glow {
  background: var(--bl-grad);
  border-radius: 50%;
  filter: blur(60px);
  height: 46%;
  opacity: 0.45;
  position: absolute;
  width: 46%;
}
.visual__logo {
  border-radius: 28%;
  box-shadow: var(--bl-glow-shadow);
  height: auto;
  max-width: 220px;
  position: relative;
  width: 34%;
}
.visual__name {
  background: var(--bl-grad);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  font-size: clamp(28px, 5vw, 44px);
  font-weight: 800;
  letter-spacing: 0.12em;
  margin-top: 18px;
  position: relative;
}
.dock {
  align-items: center;
  background: rgba(22, 14, 40, 0.82);
  border: 1px solid var(--bl-line);
  border-radius: 16px;
  display: flex;
  gap: 16px;
  justify-content: space-between;
  margin-top: 16px;
  min-height: 88px;
  padding: 12px 16px;
}
.qr-block {
  align-items: center;
  display: flex;
  flex: 0 1 auto;
  gap: 12px;
  min-width: 0;
}
.qr-block img {
  background: #fff;
  border-radius: 8px;
  flex: 0 0 auto;
  height: 64px;
  padding: 4px;
  width: 64px;
}
.qr-block p {
  color: rgba(247, 243, 255, 0.55);
  font-size: 13px;
  line-height: 1.5;
}
.cta {
  display: flex;
  flex: 0 0 auto;
  gap: 12px;
}
.cta__enter,
.cta__copy {
  border: none;
  border-radius: 12px;
  cursor: pointer;
  flex: none;
  font-size: 15px;
  font-weight: 700;
  height: 48px;
  letter-spacing: 0.04em;
  padding: 0;
  width: 200px;
}
.cta__enter {
  background: var(--bl-grad); box-shadow: var(--bl-glow-shadow);
  box-shadow: 0 8px 20px rgba(255, 79, 216, 0.28);
  color: var(--bl-on-accent);
}
.cta__copy {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.2);
  color: #fff;
}
@media (min-width: 960px) {
  .stage {
    padding: 24px 36px 40px;
  }
  .hero {
    grid-template-columns: minmax(240px, 320px) minmax(0, 1fr);
    gap: 28px;
    margin-top: 20px;
  }
  .visual__clip {
    max-height: min(64vh, 560px);
  }
}
@media (max-width: 959px) {
  .frame {
    display: grid;
    gap: 16px;
    grid-template-areas:
      'visual'
      'dock'
      'copy';
    margin-top: 20px;
  }
  .hero {
    display: contents;
    margin-top: 0;
  }
  .copy {
    grid-area: copy;
  }
  .visual {
    grid-area: visual;
  }
  .dock {
    grid-area: dock;
    margin-top: 0;
  }
  .cta {
    width: 100%;
    max-width: 420px;
    margin-left: auto;
  }
  .cta__enter,
  .cta__copy {
    flex: 1;
    width: auto;
  }
}
@media (max-width: 720px) {
  .brand img {
    height: 72px;
    width: 72px;
  }
  .visual__clip {
    aspect-ratio: 9 / 16;
    max-height: min(58vh, 720px);
  }
  .dock {
    align-items: stretch;
    flex-direction: column;
    height: auto;
    min-height: 0;
  }
  .cta {
    width: 100%;
  }
  .cta__enter,
  .cta__copy {
    flex: 1;
    width: auto;
  }
}
</style>

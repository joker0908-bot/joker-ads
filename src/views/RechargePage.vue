<template>
  <div class="recharge">
    <header class="recharge__head">
      <button class="recharge__back" @click="router.back()">‹</button>
      <h1>{{ pageTitle }}</h1>
    </header>

    <nav class="recharge__tabs">
      <button
        v-for="t in tabs"
        :key="t.id"
        class="recharge__tab"
        :class="{ 'is-active': activeTab === t.id }"
        @click="activeTab = t.id"
      >{{ t.label }}</button>
    </nav>

    <p v-if="loading" class="recharge__hint">加载套餐中…</p>
    <p v-else-if="error" class="recharge__hint recharge__hint--err">{{ error }}</p>

    <section class="pkg-grid">
      <button
        v-for="(pkg, i) in packages"
        :key="pkg.id || i"
        class="pkg"
        :class="{ 'is-active': selected === i }"
        @click="selected = i"
      >
        <strong>{{ pkg.name }}</strong>
        <span class="pkg__price">¥{{ pkg.price }}</span>
        <span v-if="pkg.tip" class="pkg__tip">{{ pkg.tip }}</span>
      </button>
    </section>

    <section class="pay-types">
      <h3>支付方式</h3>
      <button
        v-for="p in payChannels"
        :key="p.key"
        class="pay-type"
        :class="{ 'is-active': payChannel === p.key, 'is-disabled': !channelOk(p) }"
        :disabled="!channelOk(p)"
        @click="payChannel = p.key"
      >
        {{ p.name }}
        <span class="pay-type__range">¥{{ p.min }}-{{ p.max }}</span>
      </button>
    </section>

    <button
      class="recharge__submit"
      :disabled="submitting || !packages.length || !activeChannel"
      @click="submit"
    >{{ submitting ? '拉起支付中…' : '立即支付' }}</button>

    <section v-if="orders.length" class="pay-orders">
      <h3>到账记录</h3>
      <p v-for="o in orders" :key="o.mch_order_no">{{ o.package_name }} · {{ orderStatus(o) }}</p>
    </section>

    <div v-if="payModal" class="pay-modal" @click.self="closePayModal">
      <div class="pay-modal__box">
        <header class="pay-modal__head">
          <strong>扫码支付 ¥{{ payModal.amount }}</strong>
          <button class="pay-modal__close" @click="closePayModal">×</button>
        </header>
        <p class="pay-modal__sub">{{ payModal.channelName }} · 订单 {{ payModal.mchOrderNo }}</p>
        <div class="pay-modal__frame-wrap">
          <iframe
            v-if="payModal.frameUrl"
            class="pay-modal__frame"
            :src="payModal.frameUrl"
            title="支付二维码"
          />
          <p v-else class="pay-modal__fallback">
            该通道不支持页面内嵌，请点击下方「新窗口打开」扫码支付。
          </p>
        </div>
        <p v-if="pollStatus === 'paid'" class="pay-modal__ok">支付成功，正在返回…</p>
        <p v-else-if="pollHint" class="pay-modal__wait">{{ pollHint }}</p>
        <p v-else-if="pollStatus === 'pending'" class="pay-modal__wait">请使用手机扫码完成支付</p>
        <div class="pay-modal__actions">
          <button class="pay-modal__btn" @click="openPayUrl">新窗口打开</button>
          <button class="pay-modal__btn pay-modal__btn--primary" @click="checkPaid">我已支付</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { fetchPayCatalog, fetchPayOrders } from '../api/pay.js'
import { createNajinOrder, queryNajinOrder, NAJIN_PRODUCTS } from '../api/najin.js'
import { refreshCustomer } from '../composables/useCustomer.js'
import { showToast } from '../composables/useToast.js'

const route = useRoute()
const router = useRouter()
const tabs = [
  { id: 'vip', label: 'VIP会员' },
  { id: 'gold', label: '钻石充值' },
]
const activeTab = ref(route.query.type === 'gold' || route.query.type === 'diamond' ? 'gold' : 'vip')
const packages = ref([])
const selected = ref(0)
const payChannel = ref('ali')
const loading = ref(false)
const submitting = ref(false)
const error = ref('')
const catalog = ref([])
const orders = ref([])
const payModal = ref(null)
const pollStatus = ref('pending')
const pollHint = ref('')
let pollTimer = null
let pollFailToasted = false

const payChannels = [
  { key: 'ali', ...NAJIN_PRODUCTS.ali },
  { key: 'wx', ...NAJIN_PRODUCTS.wx },
]

const pageTitle = computed(() => (activeTab.value === 'gold' ? '钻石充值' : 'VIP会员中心'))
const activeChannel = computed(() => payChannels.find((p) => p.key === payChannel.value))

function channelOk(channel) {
  if (!channel) return false
  const price = Number(packages.value[selected.value]?.price || 0)
  return price >= channel.min && price <= channel.max
}

function orderStatus(o) {
  return o.status === 'paid' ? '已到账' : o.status === 'failed' ? '未完成' : '待支付'
}

async function loadOrders() {
  orders.value = (await fetchPayOrders()).slice(0, 6)
}

async function loadPackages() {
  loading.value = true
  error.value = ''
  selected.value = 0
  try {
    if (!catalog.value.length) catalog.value = (await fetchPayCatalog()).packages
    packages.value = catalog.value.filter((p) => p.kind === activeTab.value)
    if (!packages.value.length) error.value = '暂无可售套餐'
  } catch (e) {
    packages.value = []
    error.value = e?.message || '套餐加载失败'
  } finally {
    loading.value = false
    ensurePayChannel()
  }
}

function ensurePayChannel() {
  const price = Number(packages.value[selected.value]?.price || 0)
  if (channelOk(activeChannel.value)) return
  const alt = payChannels.find((c) => price >= c.min && price <= c.max)
  if (alt) payChannel.value = alt.key
}

function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function closePayModal() {
  stopPoll()
  payModal.value = null
  pollStatus.value = 'pending'
  submitting.value = false
}

async function onPaid() {
  pollStatus.value = 'paid'
  pollHint.value = ''
  stopPoll()
  await refreshCustomer().catch(() => {})
  await loadOrders().catch(() => {})
  showToast('已记入当前身份卡')
  setTimeout(() => {
    closePayModal()
    router.push('/my')
  }, 1200)
}

async function checkPaid() {
  if (!payModal.value?.mchOrderNo) return
  try {
    const res = await queryNajinOrder(payModal.value.mchOrderNo)
    if (res.paid) {
      await onPaid()
    } else {
      pollStatus.value = 'pending'
      pollHint.value = '尚未检测到支付成功，请完成扫码后再试'
      showToast(pollHint.value)
    }
  } catch (e) {
    const msg = e?.message || '查询失败'
    pollHint.value = msg
    error.value = msg
    showToast(msg)
  }
}

function startPoll(mchOrderNo) {
  stopPoll()
  pollFailToasted = false
  pollTimer = setInterval(async () => {
    try {
      const res = await queryNajinOrder(mchOrderNo)
      if (res.paid) await onPaid()
    } catch {
      if (!pollFailToasted) {
        pollFailToasted = true
        pollHint.value = '支付状态查询异常，可点「我已支付」重试'
        showToast(pollHint.value)
      }
    }
  }, 4000)
}

function openPayUrl() {
  const target = payModal.value?.payUrl || payModal.value?.frameUrl || payModal.value?.payDeeplink
  if (target) window.open(target, '_blank')
}

async function submit() {
  const pkg = packages.value[selected.value]
  const channel = activeChannel.value
  if (!pkg || !channel) return
  if (!channelOk(channel)) {
    error.value = `${channel.name} 支持 ¥${channel.min}-${channel.max}，当前套餐 ¥${pkg.price} 不可用`
    return
  }

  submitting.value = true
  error.value = ''
  try {
    const res = await createNajinOrder({ productId: channel.id, packageId: pkg.id })
    // Only https can render inside the frame; an http checkout is mixed content.
    const framable = /^https:/i.test(res.payPageUrl || '') ? res.payPageUrl : ''
    if (res.payDeeplink && /^[a-z][a-z0-9+.-]*:/i.test(res.payDeeplink) && !/^https?:/i.test(res.payDeeplink)) {
      try {
        window.location.href = res.payDeeplink
      } catch {}
    }
    payModal.value = {
      payUrl: res.payUrl,
      payDeeplink: res.payDeeplink || '',
      frameUrl: framable,
      mchOrderNo: res.mchOrderNo,
      amount: res.amount,
      channelName: channel.name,
    }
    pollStatus.value = 'pending'
    pollHint.value = ''
    startPoll(res.mchOrderNo)
    submitting.value = false
  } catch (e) {
    error.value = e?.message || '支付通道暂不可用'
    submitting.value = false
  }
}

watch(activeTab, () => loadPackages())
watch(selected, () => ensurePayChannel())
onMounted(() => {
  loadPackages()
  loadOrders().catch(() => {})
  if (String(route.query.paid || '') === '1') {
    showToast('正在确认支付，请稍后点「我已支付」核对')
  }
})
onBeforeUnmount(() => stopPoll())
</script>

<style scoped>
.recharge {
  background: radial-gradient(ellipse 100% 28% at 50% 0%, rgba(0,212,255,0.07), transparent 60%), var(--bl-bg);
  color: #fff;
  min-height: 100vh;
  padding: 0 0.32rem 0.8rem;
}
.recharge__head {
  align-items: center;
  display: flex;
  gap: 0.16rem;
  padding: 0.24rem 0 0.32rem;
}
.recharge__back {
  background: var(--bl-accent-dim);
  border: 1px solid var(--bl-line);
  border-radius: 50%;
  color: var(--bl-accent-soft);
  font-size: 0.48rem;
  height: 0.72rem;
  line-height: 0.64rem;
  padding: 0;
  width: 0.72rem;
}
.recharge__head h1 { font-size: 0.36rem; font-weight: 600; letter-spacing: 0.04em; }
.recharge__tabs { display: flex; gap: 0.16rem; margin-bottom: 0.24rem; }
.recharge__tab {
  background: var(--bl-surface-2);
  border: none;
  border-radius: 0.8rem;
  color: rgba(255, 255, 255, 0.65);
  flex: 1;
  font-size: 0.3rem;
  padding: 0.16rem;
}
.recharge__tab.is-active { background: var(--bl-grad); box-shadow: var(--bl-glow-shadow); color: #140C26; font-weight: 700; }
.recharge__hint { color: rgba(255, 255, 255, 0.55); font-size: 0.26rem; margin-bottom: 0.16rem; }
.recharge__hint--err { color: #ff8a8a; }
.pkg-grid {
  display: grid;
  gap: 0.16rem;
  grid-template-columns: repeat(3, 1fr);
  margin-bottom: 0.32rem;
}
.pkg {
  background: var(--bl-surface);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 0.16rem;
  color: inherit;
  display: flex;
  flex-direction: column;
  gap: 0.08rem;
  padding: 0.24rem 0.16rem;
  text-align: center;
}
.pkg.is-active { border-color: var(--bl-accent); box-shadow: 0 0 0 1px var(--bl-accent) inset; }
.pkg strong { font-size: 0.28rem; }
.pkg__price { color: var(--bl-accent-soft); font-size: 0.34rem; font-weight: 700; }
.pkg__tip { color: rgba(255, 255, 255, 0.45); font-size: 0.22rem; }
.pay-types h3 { font-size: 0.32rem; margin-bottom: 0.12rem; }
.pay-types { margin-bottom: 0.32rem; }
.pay-type {
  background: var(--bl-surface-2);
  border: 1px solid transparent;
  border-radius: 0.12rem;
  color: #fff;
  display: inline-flex;
  flex-direction: column;
  font-size: 0.28rem;
  margin: 0 0.12rem 0.12rem 0;
  padding: 0.14rem 0.24rem;
  text-align: left;
}
.pay-type.is-active { border-color: var(--bl-accent); color: var(--bl-accent); }
.pay-type.is-disabled { opacity: 0.35; }
.pay-type__range { color: rgba(255,255,255,.45); font-size: 0.22rem; margin-top: 0.04rem; }
.recharge__submit {
  background: var(--bl-grad); box-shadow: var(--bl-glow-shadow);
  border: none;
  border-radius: 0.8rem;
  color: #140C26;
  font-size: 0.34rem;
  font-weight: 700;
  padding: 0.24rem;
  width: 100%;
}
.recharge__submit:disabled { opacity: 0.45; }
.recharge__note {
  color: rgba(255, 255, 255, 0.35);
  font-size: 0.22rem;
  margin-top: 0.16rem;
  text-align: center;
}
.pay-modal {
  align-items: center;
  background: rgba(0, 0, 0, 0.72);
  display: flex;
  inset: 0;
  justify-content: center;
  padding: 0.32rem;
  position: fixed;
  z-index: 1000;
}
.pay-modal__box {
  background: var(--bl-surface);
  border: 1px solid var(--bl-line);
  border-radius: 0.2rem;
  max-width: 420px;
  padding: 0.28rem;
  width: 100%;
}
.pay-modal__head {
  align-items: center;
  display: flex;
  justify-content: space-between;
  margin-bottom: 0.12rem;
}
.pay-modal__close {
  background: none;
  border: none;
  color: #fff;
  font-size: 0.48rem;
  line-height: 1;
}
.pay-modal__sub {
  color: rgba(255, 255, 255, 0.55);
  font-size: 0.24rem;
  margin-bottom: 0.16rem;
  word-break: break-all;
}
.pay-modal__frame-wrap {
  background: #fff;
  border-radius: 0.12rem;
  height: 540px;
  max-height: 62vh;
  overflow: auto;
}
.pay-modal__fallback {
  color: #333;
  font-size: 0.28rem;
  line-height: 1.6;
  padding: 0.4rem;
  text-align: center;
}
.pay-modal__frame {
  border: none;
  height: 100%;
  width: 100%;
}
.pay-modal__wait, .pay-modal__ok {
  font-size: 0.26rem;
  margin-top: 0.16rem;
  text-align: center;
}
.pay-modal__ok { color: #7dff9a; }
.pay-modal__actions {
  display: flex;
  gap: 0.12rem;
  margin-top: 0.2rem;
}
.pay-modal__btn {
  background: var(--bl-surface-2);
  border: none;
  border-radius: 0.8rem;
  color: #fff;
  flex: 1;
  font-size: 0.28rem;
  padding: 0.16rem;
}
.pay-modal__btn--primary { background: var(--bl-grad); box-shadow: var(--bl-glow-shadow); color: #140C26; font-weight: 700; }
.pay-orders { margin-top: 0.28rem; }
.pay-orders h3 { font-size: 0.28rem; margin-bottom: 0.08rem; }
.pay-orders p { color: var(--bl-muted); font-size: 0.24rem; line-height: 1.6; }
</style>

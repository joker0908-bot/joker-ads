<template>
  <SubPage title="福利中心">
    <section class="wallet">
      <div class="wallet__vip">
        <div>
          <strong>{{ customer.vipName }}</strong>
          <p v-if="customer.vipUntil">有效期至 {{ customer.vipUntil }}</p>
        </div>
        <button @click="router.push('/recharge?type=vip')">
          {{ customer.isVip ? '续费' : '开通' }}
        </button>
      </div>
      <div class="wallet__grid">
        <div><strong>{{ customer.diamonds }}</strong><span>钻石</span></div>
        <div><strong>{{ account.points }}</strong><span>积分</span></div>
        <div><strong>{{ account.watchTickets }}</strong><span>观影券</span></div>
        <div><strong>{{ account.downloadTickets }}</strong><span>下载券</span></div>
      </div>
    </section>

    <section class="redeem">
      <h3>钻石兑换会员</h3>
      <p>{{ diamondsPerDay }} 钻 = 1 天</p>
      <div class="redeem__row">
        <label>
          天数
          <input v-model.number="days" type="number" min="1" :max="maxDays" />
        </label>
        <button :disabled="redeeming" @click="redeem">
          {{ redeeming ? '兑换中…' : `用 ${cost} 钻兑换` }}
        </button>
      </div>
    </section>

    <h3 class="sec-title">活动专区</h3>
    <p v-if="loading" class="hint">加载中…</p>
    <p v-else-if="!welfare.length" class="hint">暂无进行中的活动</p>
    <div class="welfare-grid">
      <button v-for="w in welfare" :key="w.id" class="welfare" @click="openWelfare(w)">
        <CebImg class="welfare__img" :path="w.imgUrl" />
        <span>{{ w.name }}</span>
      </button>
    </div>
  </SubPage>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import SubPage from '../components/SubPage.vue'
import CebImg from '../components/CebImg.vue'
import { fetchUserInfo } from '../api/users.js'
import { fetchWelfareConfig } from '../api/activity.js'
import { normalizeAccount } from '../api/normalize.js'
import { showToast } from '../composables/useToast.js'
import { fetchPayCatalog, redeemVip } from '../api/pay.js'
import { customerState, refreshCustomer } from '../composables/useCustomer.js'

const router = useRouter()
const account = ref(normalizeAccount(null))
const welfare = ref([])
const loading = ref(true)
const customer = customerState
const days = ref(1)
const maxDays = ref(30)
const diamondsPerDay = ref(10)
const redeeming = ref(false)
let redeemRequestId = ''

const clampDays = () => Math.min(maxDays.value, Math.max(1, Number(days.value) || 1))
const cost = computed(() => clampDays() * diamondsPerDay.value)

function newRequestId() {
  const raw = (typeof crypto !== 'undefined' && crypto.randomUUID?.()) || `${Date.now()}${Math.random().toString(16).slice(2)}`
  return `rdm_${raw.replace(/-/g, '')}`.slice(0, 64)
}

async function redeem() {
  if (redeeming.value) return
  const n = clampDays()
  days.value = n
  // Reuse the id until the server answers so a retried tap cannot double-spend.
  if (!redeemRequestId) redeemRequestId = newRequestId()
  redeeming.value = true
  try {
    const res = await redeemVip({ days: n, requestId: redeemRequestId })
    redeemRequestId = ''
    await refreshCustomer()
    showToast(res.already ? '这笔兑换已经入账' : `已兑换 ${n} 天会员`)
  } catch (e) {
    showToast(e?.message || '兑换失败')
  } finally {
    redeeming.value = false
  }
}

function openWelfare(w) {
  const url = w?.url || ''
  if (/^https?:/i.test(url)) {
    window.open(url, '_blank', 'noopener,noreferrer')
    return
  }
  if (url.startsWith('/')) {
    router.push(url)
    return
  }
  showToast(`${w.name} 暂未开放`)
}

onMounted(async () => {
  refreshCustomer().catch(() => {})
  try {
    const { redeem: rule } = await fetchPayCatalog()
    if (rule?.diamondsPerDay) diamondsPerDay.value = Number(rule.diamondsPerDay)
    if (rule?.maxDays) maxDays.value = Number(rule.maxDays)
  } catch {}
  try {
    const info = await fetchUserInfo()
    account.value = normalizeAccount(info.data ?? info)
  } catch {}
  try {
    welfare.value = await fetchWelfareConfig()
  } catch {
    welfare.value = []
  } finally {
    loading.value = false
  }
})
</script>

<style scoped>
.wallet {
  background: var(--bl-surface);
  border: 1px solid rgba(0, 212, 255, 0.1);
  border-radius: 0.16rem;
  margin-bottom: 0.32rem;
  padding: 0.28rem;
}
.wallet__vip {
  align-items: center;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  justify-content: space-between;
  padding-bottom: 0.24rem;
}
.wallet__vip strong {
  color: var(--bl-accent-soft);
  font-size: 0.34rem;
}
.wallet__vip p {
  color: rgba(255, 255, 255, 0.5);
  font-size: 0.24rem;
  margin-top: 0.06rem;
}
.wallet__vip button {
  background: var(--bl-grad); box-shadow: var(--bl-glow-shadow);
  border: none;
  border-radius: 0.8rem;
  color: #140C26;
  font-size: 0.28rem;
  font-weight: 700;
  padding: 0.12rem 0.32rem;
}
.wallet__grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  padding-top: 0.24rem;
  text-align: center;
}
.wallet__grid strong {
  display: block;
  font-size: 0.36rem;
}
.wallet__grid span {
  color: rgba(255, 255, 255, 0.5);
  font-size: 0.24rem;
}
.sec-title {
  font-size: 0.34rem;
  margin-bottom: 0.16rem;
}
.hint {
  color: rgba(255, 255, 255, 0.45);
  font-size: 0.26rem;
  padding: 0.24rem 0;
}
.welfare-grid {
  display: grid;
  gap: 0.16rem;
  grid-template-columns: repeat(2, 1fr);
}
.welfare {
  background: var(--bl-surface);
  border: none;
  border-radius: 0.16rem;
  color: #fff;
  overflow: hidden;
  padding: 0;
  text-align: left;
}
.welfare :deep(.welfare__img) {
  aspect-ratio: 16 / 9;
  display: block;
  object-fit: cover;
  width: 100%;
}
.welfare span {
  display: block;
  font-size: 0.28rem;
  padding: 0.16rem;
}
.redeem { background: var(--bl-surface); border: 1px solid var(--bl-hair); border-radius: 0.16rem; margin-bottom: 0.32rem; padding: 0.28rem; }
.redeem h3 { font-size: 0.32rem; margin-bottom: 0.08rem; }
.redeem p { color: var(--bl-muted); font-size: 0.24rem; line-height: 1.5; }
.redeem__row { align-items: center; display: flex; gap: 0.16rem; margin-top: 0.2rem; }
.redeem label { color: var(--bl-muted); font-size: 0.26rem; }
.redeem input { background: var(--bl-surface-2); border: 1px solid var(--bl-line); border-radius: 0.08rem; color: var(--bl-text); font-size: 0.28rem; margin-left: 0.08rem; padding: 0.08rem 0.12rem; width: 1.2rem; }
.redeem button { background: var(--bl-grad); box-shadow: var(--bl-glow-shadow); border: none; border-radius: 0.8rem; color: var(--bl-on-accent); font-size: 0.26rem; font-weight: 700; padding: 0.12rem 0.28rem; }
.redeem button:disabled { opacity: 0.5; }
</style>

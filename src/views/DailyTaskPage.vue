<template>
  <SubPage title="每日任务">
    <section class="balance">
      <div><strong>{{ account.points }}</strong><span>积分</span></div>
      <div><strong>{{ customer.diamonds }}</strong><span>钻石</span></div>
      <div><strong>{{ account.watchTickets }}</strong><span>观影券</span></div>
    </section>

    <button class="signin" :disabled="signing" @click="onSignin">
      {{ signing ? '签到中…' : '每日签到' }}
    </button>

    <h3 class="sec-title">任务列表</h3>
    <ul class="tasks">
      <li v-for="t in tasks" :key="t.id" class="task">
        <div class="task__info">
          <strong>{{ t.name }}</strong>
        </div>
        <span v-if="t.progress" class="task__progress">{{ t.progress }}</span>
        <button class="task__go" @click="router.push(t.to)">去完成</button>
      </li>
    </ul>
  </SubPage>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import SubPage from '../components/SubPage.vue'
import { fetchUserInfo, fetchUserSignin, fetchActionStats } from '../api/users.js'
import { normalizeAccount } from '../api/normalize.js'
import { showToast } from '../composables/useToast.js'
import { customerState, refreshCustomer } from '../composables/useCustomer.js'

const router = useRouter()
const account = ref(normalizeAccount(null))
const actions = ref({ commentCount: 0, downloadCount: 0, aiCreateCount: 0 })
const signing = ref(false)
const customer = customerState

const tasks = computed(() => [
  { id: 'watch', name: '观看影片', to: '/videosPage', progress: '' },
  {
    id: 'comment',
    name: '发表评论',
   
    to: '/videosPage',
    progress: `已评论 ${actions.value.commentCount}`,
  },
  {
    id: 'download',
    name: '下载应用',
   
    to: '/appcenter',
    progress: `已下载 ${actions.value.downloadCount}`,
  },
  { id: 'invite', name: '邀请好友', to: '/my/shareApp', progress: `已邀请 ${account.value.inviteCount}` },
  { id: 'recharge', name: '每日充值', to: '/recharge?type=gold', progress: '' },
])

async function loadAccount() {
  try {
    const info = await fetchUserInfo()
    account.value = normalizeAccount(info.data ?? info)
  } catch {}
}

async function onSignin() {
  signing.value = true
  try {
    const res = await fetchUserSignin()
    showToast(res?.message === 'success' ? '签到成功' : res?.message || '签到成功')
    await loadAccount()
  } catch (e) {
    // Guest tokens cannot sign in; surface whatever the server said.
    showToast(e?.message || '签到失败，请稍后再试')
  } finally {
    signing.value = false
  }
}

onMounted(async () => {
  refreshCustomer().catch(() => {})
  await loadAccount()
  try {
    const s = await fetchActionStats()
    const d = (s.data ?? s)?.data ?? s.data ?? {}
    actions.value = {
      commentCount: d.commentCount ?? 0,
      downloadCount: d.downloadCount ?? 0,
      aiCreateCount: d.aiCreateCount ?? 0,
    }
  } catch {}
})
</script>

<style scoped>
.balance {
  background: var(--bl-surface);
  border: 1px solid rgba(0, 212, 255, 0.1);
  border-radius: 0.16rem;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  margin-bottom: 0.24rem;
  padding: 0.28rem 0;
  text-align: center;
}
.balance strong {
  display: block;
  font-size: 0.4rem;
}
.balance span {
  color: rgba(255, 255, 255, 0.5);
  font-size: 0.24rem;
}
.signin {
  background: var(--bl-grad); box-shadow: var(--bl-glow-shadow);
  border: none;
  border-radius: 0.8rem;
  color: #140C26;
  font-size: 0.32rem;
  font-weight: 700;
  margin-bottom: 0.32rem;
  padding: 0.24rem;
  width: 100%;
}
.signin:disabled {
  opacity: 0.5;
}
.sec-title {
  font-size: 0.34rem;
  margin-bottom: 0.16rem;
}
.tasks {
  list-style: none;
}
.task {
  align-items: center;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  display: flex;
  gap: 0.16rem;
  padding: 0.24rem 0;
}
.task__info {
  flex: 1;
  min-width: 0;
}
.task__info strong {
  font-size: 0.3rem;
}
.task__info p {
  color: rgba(255, 255, 255, 0.45);
  font-size: 0.24rem;
  margin-top: 0.06rem;
}
.task__progress {
  color: rgba(255, 255, 255, 0.5);
  font-size: 0.24rem;
  white-space: nowrap;
}
.task__go {
  background: var(--bl-grad); box-shadow: var(--bl-glow-shadow);
  border: none;
  border-radius: 0.8rem;
  color: #140C26;
  flex-shrink: 0;
  font-size: 0.26rem;
  font-weight: 700;
  padding: 0.12rem 0.26rem;
}
</style>

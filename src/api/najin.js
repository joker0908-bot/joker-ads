const PAY_BFF =
  (import.meta.env.VITE_PAY_BFF_ORIGIN || import.meta.env.VITE_API_PROXY_ORIGIN || '').replace(/\/$/, '')

export const NAJIN_PRODUCTS = {
  wx: { id: 8002, name: '微信原生纯视频', min: 30, max: 500 },
  ali: { id: 8009, name: '支付宝原生纯视频', min: 10, max: 500 },
}

function bffUrl(path) {
  const p = path.startsWith('/') ? path : `/${path}`
  if (PAY_BFF) return `${PAY_BFF}/pay-bff${p}`
  if (typeof window !== 'undefined') {
    const h = window.location.hostname
    if (h === 'localhost' || h === '127.0.0.1') return `/pay-bff${p}`
    if (/(^|\.)b12sl5x\.cn$/i.test(h) || /(^|\.)al-ads\.com$/i.test(h)) return `/pay-bff${p}`
  }
  return `https://al-ads.com/pay-bff${p}`
}

export async function createNajinOrder({ productId, packageId }) {
  // 客户凭据首选 HttpOnly cookie dw_card；这里仅取 localStorage 值作 POST body 的 cardToken 载荷
  let cardToken = ''
  try {
    cardToken = localStorage.getItem('dw_card_token') || ''
  } catch {}
  const res = await fetch(bffUrl('/create'), {
    method: 'POST',
    credentials: 'include',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ productId, packageId, cardToken }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || !json.ok) {
    if (json.code === 'PAYMENT_DISABLED' || res.status === 503) throw new Error(json.message || '支付通道暂未开放，请稍后再试')
    throw new Error(json.message || `支付下单失败 (${res.status})`)
  }
  return json
}

export async function queryNajinOrder(mchOrderNo) {
  const res = await fetch(`${bffUrl('/query')}?mchOrderNo=${encodeURIComponent(mchOrderNo)}`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || !json.ok) {
    throw new Error(json.message || '查询失败')
  }
  return json
}

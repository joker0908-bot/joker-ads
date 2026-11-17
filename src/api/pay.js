// Local wallet: package catalog, diamond→VIP redeem and order history are
// served by the admin service; order creation/query goes through pay-bff.
//
// 凭据说明：后端首选 HttpOnly cookie `dw_card`（随 credentials:'include' 自动携带），
// 其次认 X-Card-Token 请求头；localStorage 里的 dw_card_token 仅作为
// X-Card-Token 头与 claim/redeem 等 POST body 的 cardToken 载荷来源，
// 不再拼进 URL query。
const TOKEN_KEY = 'dw_card_token'

export function cardToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || ''
  } catch {
    return ''
  }
}

async function readJson(res) {
  return res.json().catch(() => ({}))
}

export async function fetchPayCatalog() {
  const res = await fetch('/api/public/pay/catalog', { headers: { Accept: 'application/json' } })
  const json = await readJson(res)
  if (!res.ok || !json.ok) throw new Error(json.message || '套餐加载失败')
  return {
    packages: Array.isArray(json.packages) ? json.packages : [],
    redeem: json.redeem || null,
  }
}

export async function fetchPayOrders() {
  // 客户凭据走 HttpOnly cookie（credentials:'include'）或 X-Card-Token 头，禁止带 ?token= query
  const res = await fetch('/api/public/pay/orders', {
    credentials: 'include',
    headers: { Accept: 'application/json', 'X-Card-Token': cardToken() },
  })
  const json = await readJson(res)
  return res.ok && Array.isArray(json.orders) ? json.orders : []
}

export async function redeemVip({ days, requestId }) {
  const res = await fetch('/api/public/pay/redeem', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ days, requestId, cardToken: cardToken() }),
  })
  const json = await readJson(res)
  if (!res.ok || json.ok === false) throw new Error(json.message || '兑换失败')
  return json
}

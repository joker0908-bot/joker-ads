// Local wallet: package catalog, diamond→VIP redeem and order history are
// served by the admin service; order creation/query goes through pay-bff.
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
  const res = await fetch(`/api/public/pay/orders?token=${encodeURIComponent(cardToken())}`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
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

import crypto from 'node:crypto'
import { getDb, id, now } from './db.mjs'

const CHANNELS = {
  8002: { min: 30, max: 500 },
  8009: { min: 10, max: 500 },
}

export const REDEEM_RULE = { diamondsPerDay: 10, maxDays: 30 }

export const PAY_CATALOG = [
  { id: 'vip-7', kind: 'vip', name: '7天VIP', price: 30, vipDays: 7, diamonds: 0, tip: '' },
  { id: 'vip-30', kind: 'vip', name: '30天VIP', price: 88, vipDays: 30, diamonds: 0, tip: '' },
  { id: 'vip-90', kind: 'vip', name: '90天VIP', price: 198, vipDays: 90, diamonds: 0, tip: '' },
  { id: 'gold-30', kind: 'gold', name: '30钻石', price: 30, vipDays: 0, diamonds: 33, tip: '到账33（含赠送3）' },
  { id: 'gold-50', kind: 'gold', name: '50钻石', price: 50, vipDays: 0, diamonds: 55, tip: '到账55（含赠送5）' },
  { id: 'gold-100', kind: 'gold', name: '100钻石', price: 100, vipDays: 0, diamonds: 115, tip: '到账115（含赠送15）' },
]

function fail(message, status = 400) {
  const err = new Error(message)
  err.status = status
  throw err
}

export function publicCatalog() {
  return PAY_CATALOG.map((row) => ({ ...row }))
}

export function walletView(customerId) {
  const row = getDb().prepare('SELECT diamonds, vip_until FROM customer_wallets WHERE customer_id = ?').get(customerId)
  const vipUntil = row?.vip_until || ''
  const isVip = !!(vipUntil && Date.parse(vipUntil) > Date.now())
  return {
    diamonds: Number(row?.diamonds || 0),
    vipUntil: vipUntil ? String(vipUntil).slice(0, 10) : '',
    isVip,
    vipName: isVip ? 'VIP' : '普通用户',
  }
}

function orderNo(kind) {
  return `FBI${Date.now()}${crypto.randomBytes(3).toString('hex')}${kind === 'gold' ? 'G' : 'V'}`
}

function extendVip(current, days) {
  const parsed = current ? Date.parse(current) : NaN
  const base = Number.isFinite(parsed) && parsed > Date.now() ? parsed : Date.now()
  return new Date(base + days * 86400000).toISOString()
}

export function reserveOrder({ customerId, packageId, productId }) {
  const pkg = PAY_CATALOG.find((row) => row.id === String(packageId || ''))
  if (!pkg) fail('套餐不存在')
  const channel = CHANNELS[Number(productId)]
  if (!channel) fail('不支持的支付通道')
  if (pkg.price < channel.min || pkg.price > channel.max) fail(`金额需在 ${channel.min}-${channel.max} 元之间`)

  const db = getDb()
  const mchOrderNo = orderNo(pkg.kind)
  db.prepare(`
    INSERT INTO pay_orders (
      mch_order_no, customer_id, package_id, kind, package_name, amount_fen, product_id,
      vip_days, diamonds, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    mchOrderNo,
    customerId,
    pkg.id,
    pkg.kind,
    pkg.name,
    Math.round(pkg.price * 100),
    Number(productId),
    pkg.vipDays,
    pkg.diamonds,
    now(),
  )
  return {
    mchOrderNo,
    amountFen: Math.round(pkg.price * 100),
    amount: pkg.price,
    kind: pkg.kind,
    packageName: pkg.name,
    productId: Number(productId),
  }
}

export function attachPayOrder({ mchOrderNo, payOrderId }) {
  const db = getDb()
  const row = db.prepare('SELECT status FROM pay_orders WHERE mch_order_no = ?').get(mchOrderNo)
  if (!row) fail('订单不存在', 404)
  if (row.status === 'paid') return { ok: true, already: true }
  if (row.status !== 'pending') fail('订单已关闭')
  db.prepare('UPDATE pay_orders SET pay_order_id = ? WHERE mch_order_no = ? AND status = ?').run(
    String(payOrderId || ''),
    mchOrderNo,
    'pending',
  )
  return { ok: true }
}

export function failPayOrder({ mchOrderNo, reason = '' }) {
  const db = getDb()
  db.prepare(`
    UPDATE pay_orders SET status = 'failed', pay_order_id = COALESCE(pay_order_id, '')
    WHERE mch_order_no = ? AND status = 'pending'
  `).run(mchOrderNo)
  return { ok: true, reason: String(reason || '').slice(0, 120) }
}

export function creditPaidOrder({ mchOrderNo, payOrderId = '', amountFen = null }) {
  const db = getDb()
  const tx = db.transaction(() => {
    const order = db.prepare('SELECT * FROM pay_orders WHERE mch_order_no = ?').get(mchOrderNo)
    if (!order) fail('订单不存在', 404)
    if (order.status === 'paid') return { already: true, customerId: order.customer_id }
    if (order.status !== 'pending') fail('订单不可入账')
    if (amountFen != null && amountFen !== '' && Number(amountFen) !== Number(order.amount_fen)) {
      fail('支付金额与订单不一致')
    }
    const wallet = db.prepare('SELECT diamonds, vip_until FROM customer_wallets WHERE customer_id = ?').get(order.customer_id)
    const nextDiamonds = Number(wallet?.diamonds || 0) + Number(order.diamonds || 0)
    const nextVip = Number(order.vip_days) > 0 ? extendVip(wallet?.vip_until, Number(order.vip_days)) : (wallet?.vip_until || null)
    const t = now()
    if (wallet) {
      db.prepare('UPDATE customer_wallets SET diamonds = ?, vip_until = ?, updated_at = ? WHERE customer_id = ?').run(
        nextDiamonds,
        nextVip,
        t,
        order.customer_id,
      )
    } else {
      db.prepare('INSERT INTO customer_wallets (customer_id, diamonds, vip_until, updated_at) VALUES (?, ?, ?, ?)').run(
        order.customer_id,
        nextDiamonds,
        nextVip,
        t,
      )
    }
    db.prepare(`
      INSERT INTO wallet_ledger (id, customer_id, mch_order_no, kind, diamonds, vip_days, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id('led'),
      order.customer_id,
      order.mch_order_no,
      order.kind,
      Number(order.diamonds || 0),
      Number(order.vip_days || 0),
      order.package_name,
      t,
    )
    db.prepare(`
      UPDATE pay_orders SET status = 'paid', paid_at = ?, pay_order_id = COALESCE(NULLIF(?, ''), pay_order_id)
      WHERE mch_order_no = ? AND status = 'pending'
    `).run(t, String(payOrderId || ''), order.mch_order_no)
    return { already: false, customerId: order.customer_id }
  })
  const result = tx()
  return { ok: true, ...result, wallet: walletView(result.customerId) }
}

export function redeemVipDays({ customerId, days, requestId }) {
  const n = Number(days)
  if (!Number.isInteger(n) || n < 1 || n > REDEEM_RULE.maxDays) fail(`兑换天数需为 1-${REDEEM_RULE.maxDays} 的整数`)
  const key = String(requestId || '').trim()
  if (!/^[\w-]{8,64}$/.test(key)) fail('缺少兑换单号')
  const cost = n * REDEEM_RULE.diamondsPerDay
  const db = getDb()
  const tx = db.transaction(() => {
    const existing = db.prepare('SELECT customer_id, vip_days FROM wallet_ledger WHERE mch_order_no = ?').get(key)
    if (existing) {
      if (existing.customer_id !== customerId) fail('兑换单号无效')
      return { already: true, customerId }
    }
    const wallet = db.prepare('SELECT diamonds, vip_until FROM customer_wallets WHERE customer_id = ?').get(customerId)
    const balance = Number(wallet?.diamonds || 0)
    if (balance < cost) fail('钻石不足')
    const nextVip = extendVip(wallet?.vip_until, n)
    const t = now()
    db.prepare('UPDATE customer_wallets SET diamonds = ?, vip_until = ?, updated_at = ? WHERE customer_id = ?').run(
      balance - cost,
      nextVip,
      t,
      customerId,
    )
    db.prepare(`
      INSERT INTO wallet_ledger (id, customer_id, mch_order_no, kind, diamonds, vip_days, note, created_at)
      VALUES (?, ?, ?, 'redeem', ?, ?, ?, ?)
    `).run(id('led'), customerId, key, -cost, n, `${n}天VIP`, t)
    return { already: false, customerId, days: n, cost }
  })
  const result = tx()
  return { ok: true, ...result, wallet: walletView(result.customerId) }
}

export function listCustomerOrders(customerId, limit = 20) {
  return getDb().prepare(`
    SELECT mch_order_no, kind, package_name, amount_fen, diamonds, vip_days, status, created_at, paid_at
    FROM pay_orders WHERE customer_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(customerId, limit)
}

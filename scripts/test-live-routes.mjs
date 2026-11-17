// Smoke coverage for the live-only admin routes backported from production
// (pay catalog/redeem/orders, internal pay bridge, public videos, boluo-api,
// drama API keys, wallet fields). Runs against disposable data with no upstream.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const adminDir = process.env.LIVE_ROUTES_ADMIN_DIR || path.join(root, 'admin')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-routes-'))
const dataDir = path.join(tmp, 'site-data')
const mediaDir = path.join(tmp, 'media')
for (const stage of ['live', 'draft']) {
  fs.mkdirSync(path.join(dataDir, stage), { recursive: true })
  for (const [file, value] of Object.entries({ config: { apps: [] }, popups: { afterEnterApp: [] }, tabs: {}, meta: { version: 1 } })) {
    fs.writeFileSync(path.join(dataDir, stage, file + '.json'), JSON.stringify(value))
  }
}
fs.mkdirSync(mediaDir, { recursive: true })
fs.writeFileSync(path.join(mediaDir, 'clip.mp4'), Buffer.from('fixture-mp4-bytes'))
const catalog = path.join(tmp, 'catalog.json')
fs.writeFileSync(catalog, JSON.stringify({
  categories: [{ id: 'c1', name: '分类一' }],
  videos: [{ id: 'v1', title: '样例视频', category: 'c1', file: 'clip.mp4' }, { id: 'v2', title: '隐藏', hidden: true, file: 'clip.mp4' }],
}))
const payToken = crypto.randomBytes(24).toString('hex')
let password = crypto.randomBytes(24).toString('hex')
const port = await new Promise((resolve, reject) => {
  const s = net.createServer(); s.on('error', reject)
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
})
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: adminDir, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ADMIN_HOST: '127.0.0.1', ADMIN_PORT: String(port), SITE_DATA_DIR: dataDir,
    UPLOAD_DIR: path.join(tmp, 'uploads'), ADMIN_DB_PATH: path.join(tmp, 'test.sqlite'),
    ADMIN_BOOTSTRAP_USER: 'live-routes', ADMIN_BOOTSTRAP_PASS: password,
    PAY_INTERNAL_TOKEN: payToken, VIDEO_SOURCE: 'local', VIDEO_CATALOG_PATH: catalog, VIDEO_MEDIA_DIR: mediaDir,
    VIDEO_URL_SECRET: crypto.randomBytes(16).toString('hex'),
    DRAMA_API_KEYS_FILE: path.join(tmp, 'drama-keys.json'), DRAMA_API_KEY_FILE: path.join(tmp, 'missing.env'),
    BOLUO_ORIGIN_BASES: '', BOLUO_DATA_KEY: '', BOLUO_IMG_KEY: '', BOLUO_FETCH_MS: '2000',
    BOLUO_CATALOG_PATH: path.join(tmp, 'boluo-catalog.json'), HUANGGUO_API_BASE: '' },
})
let output = ''
child.stdout.on('data', x => { output += x }); child.stderr.on('data', x => { output += x })
const origin = `http://127.0.0.1:${port}`
let cookie = ''
async function call(url, { method = 'GET', body, headers = {} } = {}) {
  const r = await fetch(origin + url, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: r.status, json, text, headers: r.headers }
}
try {
  let ready = false
  for (let i = 0; i < 100 && !ready; i++) {
    if (child.exitCode !== null) throw new Error('admin exited: ' + output)
    try { ready = (await fetch(origin + '/health')).ok } catch {}
    if (!ready) await new Promise(r => setTimeout(r, 100))
  }
  assert.ok(ready, 'admin started')

  // Pay catalog / redeem / orders
  const cat = await call('/api/public/pay/catalog')
  assert.equal(cat.status, 200)
  assert.ok(Array.isArray(cat.json.packages) && cat.json.packages.length > 0)
  assert.ok(Number.isSafeInteger(cat.json.redeem.diamondsPerDay))
  assert.equal((await call('/api/public/pay/redeem', { method: 'POST', body: { days: 1 } })).status, 401)
  assert.equal((await call('/api/public/pay/orders')).status, 401)
  const claim = await call('/api/public/customers/claim', { method: 'POST', body: { deviceFp: 'fp-live-routes-fixture' } })
  assert.equal(claim.status, 200)
  const cardToken = claim.json.token
  const me = await call('/api/public/customers/me?token=' + encodeURIComponent(cardToken))
  assert.equal(me.status, 200)
  assert.equal(me.json.diamonds, 0, 'wallet fields are part of the customer card')
  assert.equal(me.json.isVip, false)
  const redeem = await call('/api/public/pay/redeem', { method: 'POST', body: { cardToken, days: 1, requestId: 'r1' } })
  assert.ok(redeem.status === 400 && redeem.json.ok === false, 'redeem without diamonds is refused cleanly')
  const orders = await call('/api/public/pay/orders?token=' + encodeURIComponent(cardToken))
  assert.equal(orders.status, 200); assert.deepEqual(orders.json.orders, [])
  console.log('PASS pay catalog, wallet card fields, redeem/orders auth and refusal')

  // Internal pay bridge: closed without the shared token
  for (const p of ['reserve', 'attach', 'fail', 'credit']) {
    assert.equal((await call('/api/internal/pay/' + p, { method: 'POST', body: {} })).status, 403, p)
    assert.equal((await call('/api/internal/pay/' + p, { method: 'POST', body: {}, headers: { 'x-pay-internal': 'x'.repeat(payToken.length) } })).status, 403, p + ' wrong token')
  }
  const pkg = cat.json.packages[0]
  const reserved = await call('/api/internal/pay/reserve', { method: 'POST', body: { cardToken, packageId: pkg.id, productId: 8002 }, headers: { 'x-pay-internal': payToken } })
  assert.ok([200, 400].includes(reserved.status), 'reserve answers with JSON, status ' + reserved.status)
  assert.equal(typeof reserved.json.ok, 'boolean')
  console.log('PASS internal pay bridge rejects missing/wrong token; accepts the configured one')

  // Public videos (local catalog)
  const cats = await call('/api/public/videos/categories')
  assert.equal(cats.status, 200); assert.equal(cats.json.categories[0].name, '分类一')
  const list = await call('/api/public/videos')
  assert.equal(list.status, 200)
  assert.ok(JSON.stringify(list.json).includes('样例视频') && !JSON.stringify(list.json).includes('隐藏'))
  const detail = await call('/api/public/videos/v1')
  assert.equal(detail.status, 200); assert.ok(detail.json.play?.url)
  const media = await fetch(origin + detail.json.play.url)
  assert.equal(media.status, 200); assert.equal(Buffer.from(await media.arrayBuffer()).toString(), 'fixture-mp4-bytes')
  assert.equal((await call('/api/public/videos/v1/media?exp=1&sig=bad')).status, 410, 'unsigned media refused')
  assert.equal((await call('/api/public/videos/missing')).status, 404)
  console.log('PASS public videos list/detail/signed media; bad signature and hidden items refused')

  // boluo-api: CORS preflight, key required
  const pre = await fetch(origin + '/boluo-api/api/videos', { method: 'OPTIONS' })
  assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), '*')
  for (const p of ['/boluo-api/api/videos', '/boluo-api/api/skits', '/boluo-api/api/shows', '/boluo-api/api/videos/categories']) {
    assert.equal((await call(p)).status, 401, p + ' requires a key')
  }

  // Admin: forced password change gates the live-only admin routes too
  const login = await call('/api/admin/login', { method: 'POST', body: { username: 'live-routes', password } })
  assert.equal(login.status, 200)
  cookie = login.headers.get('set-cookie').split(';')[0]
  assert.equal((await call('/api/admin/drama-api-keys')).status, 403, 'must change password first')
  const next = crypto.randomBytes(24).toString('hex')
  assert.equal((await call('/api/admin/change-password', { method: 'POST', body: { oldPassword: password, newPassword: next } })).status, 200)
  password = next
  cookie = (await call('/api/admin/login', { method: 'POST', body: { username: 'live-routes', password } })).headers.get('set-cookie').split(';')[0]
  assert.equal((await call('/api/admin/drama-api-keys')).status, 200)
  const created = await call('/api/admin/drama-api-keys', { method: 'POST', body: { remark: 'smoke', scopes: ['boluo'] } })
  assert.equal(created.status, 200)
  const key = created.json.key
  const customers = await call('/api/admin/customers')
  assert.equal(customers.status, 200)
  assert.ok(JSON.stringify(customers.json).includes('diamonds'), 'admin customer list carries wallet columns')

  // With a valid key the route is reached (upstream is unconfigured here, so a clean JSON error is fine)
  const keyed = await call('/boluo-api/api/videos', { headers: { 'X-Api-Key': key.secret } })
  assert.notEqual(keyed.status, 401); assert.notEqual(keyed.status, 429)
  assert.ok(keyed.json && 'code' in keyed.json, 'boluo-api answers JSON')
  assert.equal((await call('/boluo-api/api/videos', { headers: { Authorization: 'Bearer ' + key.secret } })).status, keyed.status)
  assert.equal((await call('/api/admin/drama-api-keys/' + key.id, { method: 'POST', body: { paused: true } })).status, 200)
  assert.equal((await call('/boluo-api/api/videos', { headers: { 'X-Api-Key': key.secret } })).status, 401, 'paused key refused')
  assert.equal((await call('/api/admin/drama-api-keys/' + key.id, { method: 'DELETE' })).status, 200)
  assert.equal((await call('/boluo-api/api/videos', { headers: { 'X-Api-Key': key.secret } })).status, 401, 'deleted key refused')
  assert.equal((await call('/boluo-api/api/vseg?u=http://127.0.0.1/x&exp=1&sig=bad')).status >= 400, true, 'segment proxy refuses unsigned/loopback')
  console.log('PASS boluo-api CORS + key/pause/delete; forced password change gates drama key admin; wallet columns in admin')
  assert.equal(child.exitCode, null, 'admin still running')
} finally {
  child.kill()
  await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve) })
  fs.rmSync(tmp, { recursive: true, force: true })
}

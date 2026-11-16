// Asserts the Vite build carries the 10-25 live frontend features and no
// user-facing legacy brand. Run after `npm run build`.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const dist = path.resolve(process.argv[2] || 'dist')
const assets = path.join(dist, 'assets')
const files = fs.readdirSync(assets).filter((f) => /\.(js|css)$/.test(f)).map((f) => path.join(assets, f))
files.push(path.join(dist, 'index.html'))
const all = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n')
const entry = files.find((f) => /[\\/]index-[^\\/]+\.js$/.test(f))
assert.ok(entry, 'entry chunk')
const js = fs.readFileSync(entry, 'utf8')

const required = {
  'pay catalog': '/api/public/pay/catalog',
  'pay redeem': '/api/public/pay/redeem',
  'pay orders': '/api/public/pay/orders',
  'pay-bff create': '"/create"',
  'pay-bff query': '"/query"',
  'video categories': '/api/public/videos/categories',
  'video list/detail': '/api/public/videos',
  'route /invite': '"/invite"',
  'route /video': '"/video"',
  'route /video/search': '"/video/search"',
  'route /video/:id': '"/video/:id"',
  'users info': '/users/info',
  'users signin': '/users/signin',
  'users actionStats': '/users/actionStats',
  'signin button': '每日签到',
  'redeem panel': '钻石兑换会员',
  'pay button': '立即支付',
}
for (const [name, needle] of Object.entries(required)) assert.ok(js.includes(needle), `missing ${name}: ${needle}`)
assert.ok(js.includes('菠萝视频'), 'brand present')
assert.equal((all.match(/得污/g) || []).length, 0, 'legacy brand string in build output')
assert.equal(/dewu-hero/.test(all), false, 'legacy hero assets referenced')
assert.equal(/--dw-/.test(all), false, 'legacy --dw-* theme tokens in build output')
console.log(`PASS frontend live build: ${Object.keys(required).length} live features present; 0 legacy brand strings (${path.basename(entry)})`)

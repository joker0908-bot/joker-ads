// A stale published.json (left by an earlier snapshot deploy) must not roll the
// site back when the file-per-part live directory has moved ahead of it.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const adminDir = process.env.AUDIT_ADMIN_DIR || path.join(root, 'admin')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-migration-'))
process.env.SITE_DATA_DIR = tmp
process.env.UPLOAD_DIR = path.join(tmp, 'uploads')
const write = (stage, name, value) => fs.writeFileSync(path.join(tmp, stage, name + '.json'), JSON.stringify(value))
try {
  for (const stage of ['live', 'draft']) fs.mkdirSync(path.join(tmp, stage))
  const stale = { config: { apps: [{ name: 'STALE' }] }, popups: {}, tabs: {}, apiSession: {}, meta: { version: 15 } }
  fs.writeFileSync(path.join(tmp, 'published.json'), JSON.stringify(stale))
  write('live', 'config', { apps: [{ name: 'CURRENT' }] }); write('live', 'popups', { afterEnterApp: [] })
  write('live', 'tabs', { mine: { quickApps: [] } }); write('live', 'meta', { version: 19 })
  write('draft', 'config', { apps: [{ name: 'PENDING DRAFT' }] })
  const store = await import(pathToFileURL(path.join(adminDir, 'lib/jsonStore.mjs')))
  const first = store.readPublished()
  assert.equal(first.config.apps[0].name, 'CURRENT', 'newer live directory wins over stale snapshot')
  assert.equal(first.meta.version, 19)
  assert.ok(fs.readdirSync(path.join(tmp, 'private-backups')).some(n => n.includes('published.json')), 'stale snapshot kept as backup')
  const saved = store.savePublishedPart('config', { apps: [{ name: 'EDITED' }] })
  assert.equal(saved.meta.version, 20)
  assert.equal(store.readPublished().config.apps[0].name, 'EDITED', 'after cut-over the snapshot is the authority')
  write('live', 'meta', { version: 19 })
  assert.equal(store.readPublished().meta.version, 20, 'older live directory never overrides the snapshot')
  console.log('PASS stale snapshot re-imported from newer live directory once; drafts never imported; snapshot authoritative afterwards')
} finally { fs.rmSync(tmp, { recursive: true, force: true }) }

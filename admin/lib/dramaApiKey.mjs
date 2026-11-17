import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const SCOPES = ['dewu', 'huangguo']

function registryFile() {
  return process.env.DRAMA_API_KEYS_FILE || '/etc/juhe-drama-api-keys.json'
}

function legacyFile() {
  return process.env.DRAMA_API_KEY_FILE || '/etc/juhe-drama-api-key.env'
}

function parseEnv(text) {
  const out = {}
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#') || !line.includes('=')) continue
    const idx = line.indexOf('=')
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return out
}

function readEnvFile(file) {
  try {
    if (!file || !fs.existsSync(file)) return {}
    return parseEnv(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

function shareKeyFile(file) {
  try { fs.chmodSync(file, 0o600) } catch {}
}

function keyEquals(got, expected) {
  const a = Buffer.from(String(got || ''))
  const b = Buffer.from(String(expected || ''))
  if (!a.length || a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

function legacyKey() {
  const fromFile = readEnvFile(legacyFile())
  const fileKey = String(fromFile.DEWU_API_KEY || fromFile.HUANGGUO_API_KEY || '').trim()
  if (fileKey) return fileKey
  return String(process.env.DEWU_API_KEY || process.env.HUANGGUO_API_KEY || '').trim()
}

function blankRegistry() {
  return { keys: [] }
}

function readRegistry() {
  const file = registryFile()
  if (!fs.existsSync(file)) return null
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!data || !Array.isArray(data.keys)) return blankRegistry()
    return data
  } catch {
    return blankRegistry()
  }
}

function writeRegistry(data) {
  const file = registryFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify({ keys: data.keys }, null, 2)}\n`, { mode: 0o600 })
  if (fs.existsSync(file)) fs.rmSync(file)
  fs.renameSync(tmp, file)
  shareKeyFile(file)
}

function seedRow(secret) {
  return {
    id: `key_${crypto.randomBytes(6).toString('hex')}`,
    secret,
    remark: 'Allen',
    scopes: [...SCOPES],
    paused: false,
    createdAt: new Date().toISOString(),
  }
}

function loadRegistry() {
  const existing = readRegistry()
  if (existing) return existing
  const legacy = legacyKey()
  if (!legacy) return blankRegistry()
  const data = { keys: [seedRow(legacy)] }
  writeRegistry(data)
  return data
}

export function normalizeScopes(input) {
  if (input === 'both') return [...SCOPES]
  const list = Array.isArray(input) ? input : [input]
  const picked = []
  for (const item of list) {
    const name = String(item || '').trim()
    if (SCOPES.includes(name) && !picked.includes(name)) picked.push(name)
  }
  return picked
}

function activeSecrets(scope) {
  const registry = readRegistry()
  if (!registry) {
    const legacy = legacyKey()
    return legacy ? [legacy] : []
  }
  return registry.keys
    .filter((row) => row && !row.paused && Array.isArray(row.scopes) && row.scopes.includes(scope))
    .map((row) => String(row.secret || '').trim())
    .filter(Boolean)
}

export function dramaKeyAllows(secret, scope) {
  if (!SCOPES.includes(scope)) return false
  return activeSecrets(scope).some((expected) => keyEquals(secret, expected))
}

const touchSeen = new Map()
const TOUCH_INTERVAL_MS = 60_000

export function touchKeyUsed(secret) {
  const key = String(secret || '').trim()
  if (!key) return
  const now = Date.now()
  const prev = touchSeen.get(key) || 0
  if (now - prev < TOUCH_INTERVAL_MS) return
  touchSeen.set(key, now)
  try {
    const data = readRegistry()
    if (!data) return
    const row = data.keys.find((item) => keyEquals(item.secret, key))
    if (!row) return
    row.lastUsedAt = new Date(now).toISOString()
    writeRegistry(data)
  } catch {}
}

export function upstreamPartnerKey() {
  const env = String(process.env.HUANGGUO_API_KEY || '').trim()
  if (env) return env
  return currentDramaApiKey()
}

export function currentDramaApiKey() {
  return activeSecrets('huangguo')[0] || ''
}

export function listDramaApiKeys() {
  return loadRegistry().keys.map((row) => ({ ...row, scopes: [...(row.scopes || [])] }))
}

export function createDramaApiKey({ remark, scopes }) {
  const name = String(remark || '').trim()
  if (!name || name.length > 40) {
    const error = new Error('请填写备注')
    error.status = 400
    throw error
  }
  const picked = normalizeScopes(scopes)
  if (!picked.length) {
    const error = new Error('请选择范围')
    error.status = 400
    throw error
  }
  const data = loadRegistry()
  const row = {
    id: `key_${crypto.randomBytes(6).toString('hex')}`,
    secret: `dw_${crypto.randomBytes(24).toString('hex')}`,
    remark: name,
    scopes: picked,
    paused: false,
    createdAt: new Date().toISOString(),
  }
  data.keys.unshift(row)
  writeRegistry(data)
  return row
}

export function setDramaApiKeyPaused(id, paused) {
  const data = loadRegistry()
  const row = data.keys.find((item) => item.id === id)
  if (!row) return null
  row.paused = Boolean(paused)
  writeRegistry(data)
  return row
}

export function deleteDramaApiKey(id) {
  const data = loadRegistry()
  const row = data.keys.find((item) => item.id === id)
  if (!row) return null
  data.keys = data.keys.filter((item) => item.id !== id)
  writeRegistry(data)
  return row
}

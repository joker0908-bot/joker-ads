function fail(message, code, status) {
  const err = new Error(message)
  err.code = code
  err.status = status || 0
  return err
}

async function getJson(path) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    const res = await fetch(path, { cache: 'no-store', signal: ctrl.signal })
    let data = {}
    try {
      data = await res.json()
    } catch {
      data = {}
    }
    if (!res.ok) {
      throw fail(
        data.error || data.message || '加载失败，请检查网络后重试',
        data.code || (res.status === 404 ? 'not_found' : res.status === 410 ? 'expired' : 'upstream'),
        res.status,
      )
    }
    return data
  } catch (e) {
    if (e.code) throw e
    if (e.name === 'AbortError') throw fail('加载失败，请检查网络后重试', 'network')
    throw fail('加载失败，请检查网络后重试', 'network')
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchSiteVideoCategories() {
  return getJson('/api/public/videos/categories')
}

export async function fetchSiteVideos(params = {}) {
  const q = new URLSearchParams()
  if (params.category) q.set('category', params.category)
  if (params.q) q.set('q', params.q)
  q.set('page', String(params.page || 1))
  q.set('pageSize', String(params.pageSize || 20))
  return getJson(`/api/public/videos?${q}`)
}

export async function fetchSiteVideo(id, params = {}) {
  const q = new URLSearchParams()
  if (params.ep) q.set('ep', String(params.ep))
  const suffix = q.toString() ? `?${q}` : ''
  return getJson(`/api/public/videos/${encodeURIComponent(id)}${suffix}`)
}

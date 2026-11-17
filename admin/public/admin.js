const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]

let user = null
let bundle = null
let currentPage = 'dashboard'
let appsPage = 1
let appsQuery = ''
let toastTimer = null

const NAV = [
  { id: 'dashboard', label: '控制台', read: 'dashboard' },
  { id: 'popups', label: '进站弹窗', read: 'popups' },
  { id: 'grid', label: '网格弹窗', read: 'popups' },
  { id: 'promo', label: '顶部促销', read: 'promo' },
  { id: 'float', label: '悬浮条', read: 'float' },
  { id: 'apps', label: '应用列表', read: 'apps' },
  { id: 'categories', label: '分类映射', read: 'categories' },
  { id: 'featured', label: '精选广告', read: 'tabs' },
  { id: 'mine', label: '我的页应用', read: 'tabs' },
  { id: 'customers', label: '客户身份卡', read: 'customers' },
  { id: 'stats', label: '点击统计', read: 'stats' },
  { id: 'logs', label: '操作日志', read: 'logs' },
  { id: 'security', label: '安全设置', read: 'settings' },
  { id: 'api-session', label: '原站 Token', read: 'settings', superOnly: true },
  { id: 'drama-api-key', label: '短剧 API Key', read: 'settings', superOnly: true },
]

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status })
  return data
}

function toast(msg, result = {}) {
  clearTimeout(toastTimer)
  const el = $('#toast')
  const published = result.published ? `；已同步前台 v${result.meta?.version || ''}` : ''
  el.textContent = msg + published + (result.draftWarning ? '；线上已生效，但兼容草稿备份同步失败' : '') + (result.auditWarning ? '；操作已保存，但审计日志记录失败' : '') + (result.refreshWarning ? '；列表刷新失败，请重新加载核对' : '')
  if (result.meta?.version) $('#version-badge').textContent = `自动同步 · v${result.meta.version}`
  el.classList.add('show')
  toastTimer = setTimeout(() => el.classList.remove('show'), result.keepLong || result.auditWarning || result.refreshWarning || result.draftWarning ? 8000 : 3200)
}

function reportActionError(error) {
  if (error.status === 401) {
    toast('登录已失效，当前输入已保留；请在新标签页登录后重试。', { keepLong: true })
    const link = document.createElement('a')
    link.href = '/'; link.target = '_blank'; link.rel = 'noopener'
    link.textContent = ' 重新登录'
    $('#toast').append(link)
  } else toast(error.message || '操作未确认，请刷新核对后重试')
}

async function runAction(control, action) {
  if (control?.disabled) return
  if (control) control.disabled = true
  try { return await action() }
  catch (error) { reportActionError(error) }
  finally { if (control) control.disabled = false }
}

async function refreshAfterCommit(result) {
  try { await loadBundle(); return result }
  catch { return { ...result, refreshWarning: true } }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function canWrite(scope) {
  if (!user) return false
  if (user.role === 'readonly') return false
  return user.role === 'super' || user.role === 'ad_admin'
}

function showLogin() {
  $('#login-screen').style.display = 'flex'
  $('#admin-screen').style.display = 'none'
}

function showAdmin() {
  $('#login-screen').style.display = 'none'
  $('#admin-screen').style.display = 'flex'
  $('#admin-screen').style.flexDirection = 'column'
  $('#user-badge').textContent = `${user.username} (${user.role})`
  renderSidebar()
  renderPage(currentPage)
}

async function login() {
  $('#login-err').textContent = ''
  try {
    const body = {
      username: $('#login-user').value.trim(),
      password: $('#login-pass').value,
    }
    if ($('#login-totp').style.display !== 'none') body.totp = $('#login-totp').value.trim()
    const data = await api('/api/admin/login', { method: 'POST', body: JSON.stringify(body) })
    user = data.user
    if (user.mustChangePassword) return openPasswordModal({ required: true })
    await loadBundle()
    showAdmin()
    if (user.mustChangePassword) openPasswordModal({ required: true })
  } catch (e) {
    if (e.message.includes('动态验证码')) {
      $('#login-totp').style.display = 'block'
    }
    $('#login-err').textContent = e.message
  }
}

async function logout() {
  try { await api('/api/admin/logout', { method: 'POST', body: '{}' }) } catch {}
  user = null
  showLogin()
}

async function loadBundle() {
  bundle = await api('/api/admin/site-config')
  $('#version-badge').textContent = `自动同步 · v${bundle.meta?.version || 1}`
}

async function publish() {
  if (!canWrite('publish')) return toast('无发布权限')
  return runAction($('#publish-btn'), async () => {
  const data = await api('/api/admin/publish', { method: 'POST', body: '{}' })
  toast('已核对线上版本', await refreshAfterCommit(data))
  })
}

function renderSidebar() {
  const items = NAV.filter((n) => !n.superOnly || user?.role === 'super')
  $('#sidebar').innerHTML = items.map((n) =>
    `<div class="nav-item ${currentPage === n.id ? 'active' : ''}" data-page="${n.id}"><span class="nav-dot"></span>${esc(n.label)}</div>`,
  ).join('')
  $$('#sidebar .nav-item').forEach((el) => {
    el.onclick = () => { currentPage = el.dataset.page; renderSidebar(); renderPage(currentPage) }
  })
}

async function renderPage(page) {
  try { return await renderPageContent(page) }
  catch (error) { reportActionError(error) }
}

function renderPageContent(page) {
  const main = $('#main')
  if (page === 'dashboard') return renderDashboard(main)
  if (page === 'popups') return renderListEditor(main, 'afterEnterApp', '进站弹窗队列')
  if (page === 'grid') return renderListEditor(main, 'gridPopAds', '网格弹窗（精品APP）')
  if (page === 'promo') return renderObjectEditor(main, 'promo', '顶部促销条')
  if (page === 'float') return renderObjectEditor(main, 'floatBanner', '悬浮条')
  if (page === 'apps') return renderApps(main)
  if (page === 'categories') return renderCategories(main)
  if (page === 'featured') return renderObjectEditor(main, 'featuredAd', '精选内嵌广告')
  if (page === 'mine') return renderListEditor(main, 'mineQuickApps', '我的页快捷应用')
  if (page === 'customers') return renderCustomers(main)
  if (page === 'stats') return renderStats(main)
  if (page === 'logs') return renderLogs(main)
  if (page === 'security') return renderSecurity(main)
  if (page === 'api-session') return renderApiSession(main)
  if (page === 'drama-api-key') return renderDramaApiKey(main)
  main.innerHTML = '<div class="card">页面开发中</div>'
}

async function renderDashboard(main) {
  const dash = await api('/api/admin/dashboard')
  main.innerHTML = `
    <div class="page-header"><span class="page-title">控制台</span></div>
    <div class="metric-grid">
      ${metric('应用数', dash.stats.apps, '#f81942')}
      ${metric('进站弹窗', dash.stats.popups, '#2a9d8f')}
      ${metric('网格弹窗', dash.stats.gridPopups, '#7ab3e0')}
      ${metric('今日点击', dash.stats.clicksToday, '#e9c46a')}
      ${metric('客户卡', dash.stats.customersTotal || 0, '#00c8e8')}
      ${metric('累计点击', dash.stats.clicksTotal, '#888')}
      ${metric('线上版本', dash.stats.version, '#aaa')}
    </div>
    <div class="notice">保存、新增或删除成功后自动同步前台，无需另点发布。已打开的前台约 5 秒检查一次更新；切回页面时立即检查。未点击保存的输入不会上线。</div>
    <div class="card"><div style="font-weight:700;margin-bottom:12px;">最近操作</div>
      <table><thead><tr><th>操作人</th><th>动作</th><th>时间</th></tr></thead><tbody>
      ${(dash.logs || []).map((l) => `<tr><td>${esc(l.admin_name)}</td><td>${esc(l.action)}</td><td>${esc(l.created_at?.slice(0, 19))}</td></tr>`).join('') || '<tr><td colspan="3" class="empty-row">暂无日志</td></tr>'}
      </tbody></table></div>`
}

function metric(label, val, color) {
  return `<div class="metric-card" style="--c:${color}"><div class="metric-label">${esc(label)}</div><div class="metric-val">${esc(val)}</div></div>`
}

function renderListEditor(main, slotKey, title) {
  const items = structuredClone(slotKey === 'mineQuickApps'
    ? (bundle.tabs?.mine?.quickApps || [])
    : (bundle.popups?.[slotKey] || []))
  main.innerHTML = `
    <div class="page-header"><span class="page-title">${esc(title)}</span>
      ${canWrite('popups') ? `<button class="btn btn-primary" id="add-item">新增</button>` : ''}</div>
    <div class="card" id="list-editor"></div>`
  const box = $('#list-editor')
  const render = () => {
    box.innerHTML = items.length ? items.map((item, i) => listRow(item, i, slotKey)).join('') : '<div class="empty-row">暂无条目</div>'
    bindListEvents(slotKey, items, render)
  }
  render()
  $('#add-item')?.addEventListener('click', () => {
    openItemModal(slotKey, { name: '新广告', url: '', signUrl: '', coverUrl: '', image: '', icon: '' }, async next => {
      const saved = await saveSlot(slotKey, [next, ...items])
      items.unshift(next)
      render()
      return saved
    })
  })
}

function listRow(item, index, slotKey) {
  const img = item.image || item.icon || item.coverUrl || ''
  return `<div class="list-row" data-i="${index}">
    <div style="flex:1"><div class="list-title">${esc(item.name || '(未命名)')}</div>
      <div class="list-sub link-cell">${esc(item.url || '')}</div></div>
    ${img ? `<img class="img-thumb" src="${esc(img.startsWith('/') ? img : '')}" alt="" onerror="this.style.display='none'" />` : ''}
    <div class="action-btns">
      ${canWrite('popups') ? `<button class="btn btn-blue btn-sm edit">编辑</button><button class="btn btn-danger btn-sm del">删</button>` : ''}
    </div></div>`
}

function bindListEvents(slotKey, items, rerender) {
  $$('.list-row .edit').forEach((btn) => btn.onclick = async (e) => {
    const i = Number(e.target.closest('.list-row').dataset.i)
    openItemModal(slotKey, items[i], async (next) => {
      const updated = items.map((item, idx) => idx === i ? next : item)
      const saved = await saveSlot(slotKey, updated)
      items[i] = next
      rerender()
      return saved
    })
  })
  $$('.list-row .del').forEach((btn) => btn.onclick = async (e) => {
    const i = Number(e.target.closest('.list-row').dataset.i)
    if (!confirm('确认删除？')) return
    return runAction(btn, async () => {
    const saved = await saveSlot(slotKey, items.filter((_, idx) => idx !== i))
    items.splice(i, 1)
    rerender()
    toast('已删除', saved)
    })
  })
}

const OBJECT_EDITORS = {
  promo: {
    fields: [
      { key: 'tag', label: '角标' },
      { key: 'text', label: '文字' },
      { key: 'url', label: '打开的网址' },
      { key: 'image', label: '图片', image: true, kind: 'promo' },
    ],
    more: [{ key: 'signUrl', label: '签名页' }],
  },
  floatBanner: {
    fields: [
      { key: 'title', label: '标题' },
      { key: 'subtitle', label: '副标题' },
      { key: 'btn', label: '按钮文字' },
      { key: 'url', label: '打开的网址' },
    ],
    more: [{ key: 'signUrl', label: '签名页' }],
  },
  featuredAd: {
    fields: [
      { key: 'name', label: '名称' },
      { key: 'viewers', label: '观看人数' },
      { key: 'url', label: '打开的网址' },
    ],
    more: [{ key: 'signUrl', label: '签名页' }],
  },
}

function textField(id, label, value) {
  return `<div class="form-group"><label class="form-label">${esc(label)}</label><input id="${id}" value="${esc(value || '')}" /></div>`
}

function imageField(id, label, value) {
  const src = String(value || '').trim()
  return `<div class="form-group"><label class="form-label">${esc(label)}</label>
    <img class="shot" id="${id}-shot" src="${esc(src)}" alt="" ${src ? '' : 'hidden'} />
    <input type="file" id="${id}-file" accept="image/*" />
    <input type="hidden" id="${id}" value="${esc(src)}" /></div>`
}

function moreFields(fields, data) {
  if (!fields?.length) return ''
  return `<details class="more-fields"><summary>更多</summary>${fields.map((field) => textField(`f-${field.key}`, field.label, data[field.key])).join('')}</details>`
}

async function uploadImage(file, kind) {
  const body = new FormData()
  body.append('file', file)
  const res = await fetch(`/api/admin/upload?kind=${encodeURIComponent(kind)}`, { method: 'POST', body, credentials: 'same-origin' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || '上传失败')
  return data.url
}

function bindImageInput(id, kind) {
  const file = $(`#${id}-file`)
  if (!file) return
  file.onchange = async () => {
    const picked = file.files?.[0]
    if (!picked) return
    try {
      const url = await uploadImage(picked, kind)
      $(`#${id}`).value = url
      const shot = $(`#${id}-shot`)
      shot.hidden = false
      shot.src = url
    } catch (error) {
      toast(error.message || '上传失败')
    }
  }
}

function renderObjectEditor(main, slotKey, title) {
  const spec = OBJECT_EDITORS[slotKey]
  const data = slotKey === 'featuredAd'
    ? (bundle.tabs?.featured?.ad || {})
    : slotKey === 'floatBanner'
      ? (bundle.config?.floatBanner || {})
      : (bundle.config?.promo || {})
  const writable = canWrite('promo') || (slotKey === 'featuredAd' && canWrite('tabs'))
  main.innerHTML = `
    <div class="page-header"><span class="page-title">${esc(title)}</span></div>
    <div class="card"><form id="obj-form">
      ${spec.fields.map((field) => field.image ? imageField(`f-${field.key}`, field.label, data[field.key]) : textField(`f-${field.key}`, field.label, data[field.key])).join('')}
      ${moreFields(spec.more, data)}
      ${writable ? '<button class="btn btn-primary" type="submit">保存</button>' : ''}
    </form></div>`
  spec.fields.filter((field) => field.image).forEach((field) => bindImageInput(`f-${field.key}`, field.kind || 'popup'))
  $('#obj-form')?.addEventListener('submit', async (e) => {
    e.preventDefault()
    const body = { ...data }
    for (const field of [...spec.fields, ...(spec.more || [])]) body[field.key] = $(`#f-${field.key}`)?.value.trim() || ''
    await runAction(e.submitter || e.target.querySelector('button[type="submit"]'), async () => {
      const saved = await api(`/api/admin/slots/${slotKey}`, { method: 'PUT', body: JSON.stringify(body) })
      toast('已保存', await refreshAfterCommit(saved))
    })
  })
}

function openItemModal(slotKey, item, onSave) {
  const pictureKey = slotKey === 'mineQuickApps' ? 'icon' : 'image'
  const picture = item[pictureKey] || item.image || item.icon || item.coverUrl || ''
  const kind = slotKey === 'mineQuickApps' ? 'icon' : 'popup'
  const modal = $('#modal')
  const box = $('#modal-box')
  box.className = 'modal-box'
  box.innerHTML = `
    <div class="modal-header"><div class="modal-title">编辑广告</div><button class="modal-close" id="modal-close" type="button">×</button></div>
    ${textField('f-name', '广告名', item.name)}
    ${textField('f-url', '打开的网址', item.url)}
    ${imageField('f-picture', '图片', picture)}
    ${moreFields([{ key: 'signUrl', label: '签名页' }], item)}
    <div class="modal-footer"><button class="btn btn-gray" id="modal-cancel" type="button">取消</button><button class="btn btn-primary" id="modal-save" type="button">保存</button></div>`
  modal.classList.add('show')
  const close = () => modal.classList.remove('show')
  $('#modal-close').onclick = close
  $('#modal-cancel').onclick = close
  bindImageInput('f-picture', kind)
  $('#modal-save').onclick = () => runAction($('#modal-save'), async () => {
    const next = { ...item }
    next.name = $('#f-name').value.trim()
    next.url = $('#f-url').value.trim()
    next.signUrl = $('#f-signUrl').value.trim()
    const shot = $('#f-picture').value.trim()
    if (pictureKey === 'icon') next.icon = shot
    else {
      next.image = shot
      next.coverUrl = shot
    }
    const saved = await onSave(next)
    close()
    toast('已保存', saved)
  })
}

async function saveSlot(slotKey, items) {
  const saved = await api(`/api/admin/slots/${slotKey}`, { method: 'PUT', body: JSON.stringify({ items }) })
  return refreshAfterCommit(saved)
}

async function renderApps(main) {
  const data = await api(`/api/admin/apps?page=${appsPage}&q=${encodeURIComponent(appsQuery)}`)
  main.innerHTML = `
    <div class="page-header"><span class="page-title">应用列表 (${data.total})</span>
      ${canWrite('apps') ? '<button class="btn btn-primary" id="add-app">新增应用</button>' : ''}</div>
    <div class="page-actions" style="margin-bottom:14px;">
      <input id="apps-q" placeholder="搜索名称/链接" value="${esc(appsQuery)}" style="max-width:280px" />
      <button class="btn btn-gray btn-sm" id="apps-search">搜索</button>
    </div>
    <div class="card" style="padding:0;overflow:auto;"><table>
      <thead><tr><th>图标</th><th>名称</th><th>链接</th><th>操作</th></tr></thead>
      <tbody>${data.apps.map((a) => `<tr>
        <td>${a.icon ? `<img class="img-thumb" src="${esc(a.icon)}" />` : '-'}</td>
        <td>${esc(a.name)}${a.duplicateCount > 1 ? ` <small>同名 ${a.duplicateCount} 条</small>` : ''}</td><td class="link-cell">${esc(a.url)}</td>
        <td class="action-btns">${canWrite('apps') ? `<button class="btn btn-blue btn-sm" data-edit="${esc(a.name)}">编辑</button><button class="btn btn-danger btn-sm" data-del="${esc(a.name)}">删</button>` : ''}</td>
      </tr>`).join('')}</tbody></table></div>
    <div class="page-actions" style="margin-top:12px;">
      <button class="btn btn-gray btn-sm" id="apps-prev" ${appsPage <= 1 ? 'disabled' : ''}>上一页</button>
      <span style="color:#777;font-size:13px;">第 ${data.page} 页</span>
      <button class="btn btn-gray btn-sm" id="apps-next" ${appsPage * data.pageSize >= data.total ? 'disabled' : ''}>下一页</button>
    </div>`
  $('#apps-search').onclick = () => { appsQuery = $('#apps-q').value.trim(); appsPage = 1; void renderApps(main).catch(reportActionError) }
  $('#apps-prev').onclick = () => { appsPage--; void renderApps(main).catch(reportActionError) }
  $('#apps-next').onclick = () => { appsPage++; void renderApps(main).catch(reportActionError) }
  $('#add-app')?.addEventListener('click', () => openAppModal(null))
  $$('[data-edit]').forEach((btn) => btn.onclick = () => {
    const app = data.apps.find((a) => a.name === btn.dataset.edit)
    openAppModal(app)
  })
  $$('[data-del]').forEach((btn) => btn.onclick = async () => {
    const item = data.apps.find(a => a.name === btn.dataset.del)
    if (!confirm(`确认删除此应用及全部 ${item?.duplicateCount || 1} 条同名记录？分类引用也会移除。`)) return
    return runAction(btn, async () => {
      const saved = await api(`/api/admin/apps/${encodeURIComponent(btn.dataset.del)}`, { method: 'DELETE' })
      try { await renderApps(main) } catch { saved.refreshWarning = true }
      toast('已删除', saved)
    })
  })
}

function openAppModal(app) {
  const modal = $('#modal')
  const box = $('#modal-box')
  box.className = 'modal-box'
  box.innerHTML = `
    <div class="modal-header"><div class="modal-title">${app ? '编辑应用' : '新增应用'}</div><button class="modal-close" id="modal-close" type="button">×</button></div>
    ${textField('app-name', '名称', app?.name)}
    ${textField('app-url', '打开的网址', app?.url)}
    ${imageField('app-icon', '图标', app?.icon)}
    ${moreFields([{ key: 'signUrl', label: '签名页' }], { signUrl: app?.signUrl })}
    <div class="modal-footer"><button class="btn btn-gray" id="modal-cancel" type="button">取消</button><button class="btn btn-primary" id="modal-save" type="button">保存</button></div>`
  modal.classList.add('show')
  const close = () => modal.classList.remove('show')
  $('#modal-close').onclick = close
  $('#modal-cancel').onclick = close
  bindImageInput('app-icon', 'icon')
  $('#modal-save').onclick = () => runAction($('#modal-save'), async () => {
    const body = {
      name: $('#app-name').value.trim(),
      url: $('#app-url').value.trim(),
      signUrl: $('#f-signUrl').value.trim(),
      icon: $('#app-icon').value.trim(),
    }
    const saved = app
      ? await api(`/api/admin/apps/${encodeURIComponent(app.name)}`, { method: 'PUT', body: JSON.stringify(body) })
      : await api('/api/admin/apps', { method: 'POST', body: JSON.stringify(body) })
    close()
    const refreshed = await refreshAfterCommit(saved)
    try { await renderApps($('#main')) } catch { refreshed.refreshWarning = true }
    toast('已保存', refreshed)
  })
}

async function renderCategories(main) {
  const data = await api('/api/admin/category-apps')
  const categoryApps = data.categoryApps || {}
  let categories = [...(data.categories || [])]
  const byCategory = { ...(categoryApps.byCategory || {}) }
  for (const name of Object.keys(byCategory)) {
    if (!categories.includes(name)) categories.push(name)
  }
  let recommend = [...(categoryApps.modes?.['站长推荐'] || [])]
  let download = [...(categoryApps.modes?.['热门下载'] || [])]
  const names = [...new Set([
    ...(bundle.config.apps || []).map((app) => app.name),
    ...Object.values(byCategory).flat(),
    ...recommend,
    ...download,
  ].filter(Boolean))]
  const writable = canWrite('categories')

  function checks(selected, group) {
    const on = new Set(selected)
    return names.map((name) => `<label class="check"><input type="checkbox" data-group="${esc(group)}" value="${esc(name)}" ${on.has(name) ? 'checked' : ''} ${writable ? '' : 'disabled'} />${esc(name)}</label>`).join('')
  }

  function paint() {
    main.innerHTML = `
      <div class="page-header"><span class="page-title">分类</span>
        ${writable ? '<button class="btn btn-primary" id="cat-save" type="button">保存</button>' : ''}</div>
      <div class="card">
        ${writable ? `<div class="form-group"><label class="form-label">新分类</label>
          <div class="inline-add"><input id="cat-new" /><button class="btn btn-gray" id="cat-add" type="button">添加</button></div></div>` : ''}
        <input id="cat-filter" placeholder="找应用" />
        ${categories.map((name) => `<section class="cat-block">
          <div class="cat-head"><strong>${esc(name)}</strong>
            ${writable ? `<button class="btn btn-danger btn-sm" type="button" data-remove="${esc(name)}">删除</button>` : ''}</div>
          <div class="checks">${checks(byCategory[name] || [], name)}</div>
        </section>`).join('') || '<div class="empty-row">没有分类</div>'}
      </div>
      <div class="card"><div class="cat-head"><strong>站长推荐</strong></div><div class="checks">${checks(recommend, 'recommend')}</div></div>
      <div class="card"><div class="cat-head"><strong>热门下载</strong></div><div class="checks">${checks(download, 'download')}</div></div>`
    $('#cat-filter').oninput = () => {
      const query = $('#cat-filter').value.trim()
      $$('#main .check').forEach((el) => { el.hidden = Boolean(query) && !el.textContent.includes(query) })
    }
    $('#cat-add')?.addEventListener('click', () => {
      const name = $('#cat-new').value.trim()
      if (!name || categories.includes(name)) return
      categories.push(name)
      byCategory[name] = []
      paint()
    })
    $$('#main [data-remove]').forEach((button) => {
      button.onclick = () => {
        const name = button.dataset.remove
        if (!confirm('删除？')) return
        categories = categories.filter((item) => item !== name)
        delete byCategory[name]
        if (categoryApps.modesByCategory) delete categoryApps.modesByCategory[name]
        paint()
      }
    })
    $$('#main input[type="checkbox"]').forEach((input) => {
      input.onchange = () => {
        const picked = [...main.querySelectorAll('input[type="checkbox"]:checked')]
          .filter((el) => el.dataset.group === input.dataset.group)
          .map((el) => el.value)
        if (input.dataset.group === 'recommend') recommend = picked
        else if (input.dataset.group === 'download') download = picked
        else byCategory[input.dataset.group] = picked
      }
    })
    $('#cat-save')?.addEventListener('click', async () => {
      const next = {
        ...categoryApps,
        byCategory,
        modes: { ...(categoryApps.modes || {}), '站长推荐': recommend, '热门下载': download },
      }
      await runAction($('#cat-save'), async () => {
        const saved = await api('/api/admin/category-apps', { method: 'PUT', body: JSON.stringify({ categoryApps: next, categories }) })
        toast('已保存', await refreshAfterCommit(saved))
      })
    })
  }
  paint()
}

function shot(src, label) {
  const raw = String(src || '').trim()
  const usable = raw.startsWith('/') || /^https?:/i.test(raw)
  if (!usable) return `<div class="shot-miss">${esc(label || '没有图片')}</div>`
  return `<figure class="shot-fig"><img class="shot" src="${esc(raw)}" alt="${esc(label || '')}" /><figcaption>${esc(label || '')}</figcaption></figure>`
}

function openDraftPreview() {
  const config = bundle?.config || {}
  const popups = bundle?.popups || {}
  const promo = config.promo || {}
  const floatBanner = config.floatBanner || {}
  const enter = popups.afterEnterApp || []
  const grid = popups.gridPopAds || []
  const cat = (config.categories || [])[0] || '官方推荐'
  const byName = new Map((config.apps || []).map((app) => [app.name, app]))
  const apps = (config.categoryApps?.byCategory?.[cat] || []).map((name) => byName.get(name)).filter(Boolean).slice(0, 12)
  const box = $('#modal-box')
  box.className = 'modal-box preview-box'
  box.innerHTML = `
    <div class="modal-header"><div class="modal-title">当前线上配置</div><button class="modal-close" id="modal-close" type="button">×</button></div>
    <div class="preview-phone">
      <section><h3>顶部促销</h3>${promo.image ? shot(promo.image, promo.text || promo.tag) : `<div class="promo-fallback"><b>${esc(promo.tag || '')}</b> ${esc(promo.text || '')}</div>`}</section>
      <section><h3>应用 · ${esc(cat)}</h3><div class="preview-apps">${apps.map((app) => `<div class="preview-app">${shot(app.icon, app.name)}</div>`).join('') || '<div class="shot-miss">没有应用</div>'}</div></section>
      <section><h3>悬浮条</h3><div class="preview-float"><div><strong>${esc(floatBanner.title || '')}</strong><span>${esc(floatBanner.subtitle || '')}</span></div><em>${esc(floatBanner.btn || '')}</em></div></section>
      <section><h3>进站弹窗</h3>${enter.map((ad) => shot(ad.image || ad.coverUrl, ad.name)).join('') || '<div class="shot-miss">没有弹窗</div>'}</section>
      <section><h3>网格弹窗</h3><div class="preview-grid">${grid.map((ad) => shot(ad.image || ad.coverUrl, ad.name)).join('') || '<div class="shot-miss">没有网格</div>'}</div></section>
    </div>`
  $('#modal').classList.add('show')
  $('#modal-close').onclick = () => $('#modal').classList.remove('show')
}

async function renderStats(main) {
  const data = await api('/api/admin/stats')
  main.innerHTML = `
    <div class="page-header"><span class="page-title">点击统计</span>
      <a class="btn btn-gray btn-sm" href="/api/admin/logs/export">导出操作日志</a></div>
    <div class="source-grid">
      <div class="card"><div style="font-weight:700;margin-bottom:12px;">按广告位</div>
        ${(data.bySlot || []).map((r) => `<div class="source-item"><span>${esc(r.slot || '(未标记)')}</span><strong>${r.clicks}</strong></div>`).join('') || '<div class="empty-row">暂无数据</div>'}
      </div>
      <div class="card"><div style="font-weight:700;margin-bottom:12px;">近 14 日</div>
        ${(data.daily || []).map((r) => `<div class="source-item"><span>${esc(r.day)}</span><strong>${r.clicks}</strong></div>`).join('') || '<div class="empty-row">暂无数据</div>'}
      </div>
    </div>`
}

async function renderLogs(main) {
  const data = await api('/api/admin/logs?limit=200')
  main.innerHTML = `
    <div class="page-header"><span class="page-title">操作日志</span>
      <a class="btn btn-gray btn-sm" href="/api/admin/logs/export">导出 CSV</a></div>
    <div class="card" style="padding:0;overflow:auto;"><table>
      <thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>目标</th><th>IP</th></tr></thead>
      <tbody>${(data.logs || []).map((l) => `<tr>
        <td>${esc(l.created_at?.slice(0, 19))}</td><td>${esc(l.admin_name)}</td><td>${esc(l.action)}</td>
        <td>${esc(l.target_type)} ${esc(l.target_id)}</td><td>${esc(l.ip)}</td></tr>`).join('')}
      </tbody></table></div>`
}

async function renderCustomers(main) {
  const data = await api('/api/admin/customers?limit=100')
  main.innerHTML = `
    <div class="page-header"><span class="page-title">客户身份卡（${data.total}）</span></div>
    <div class="card" style="padding:0;overflow:auto;"><table>
      <thead><tr><th>客户ID</th><th>身份卡号</th><th>邀请码</th><th>钻石</th><th>会员至</th><th>邀请人</th><th>签发</th></tr></thead>
      <tbody>${(data.customers || []).map((c) => `<tr>
        <td>${esc(c.id)}</td><td>${esc(c.card_no)}</td><td>${esc(c.invite_code)}</td>
        <td>${esc(c.diamonds || 0)}</td><td>${esc((c.vip_until || '').slice(0, 10) || '—')}</td>
        <td>${esc(c.invited_by || '—')}</td><td>${esc((c.issued_at || c.created_at || '').slice(0, 19))}</td>
      </tr>`).join('') || '<tr><td colspan="7" class="empty-row">暂无客户</td></tr>'}
      </tbody></table></div>`
}

async function renderApiSession(main) {
  if (user?.role !== 'super') {
    main.innerHTML = '<div class="card">仅超管可轮换原站 token</div>'
    return
  }
  const data = await api('/api/admin/api-session')
  const live = data.live || {}
  main.innerHTML = `
    <div class="page-header"><span class="page-title">原站 Token</span></div>
    <div class="card" style="max-width:640px;">
      <p class="form-help">线上 uid：<code>${esc(live.uid || '—')}</code></p>
      <p class="form-help">摘要：<code>${esc(live.tokenPreview || '未配置')}</code> · ${live.tokenLen || 0} 位</p>
      <p class="form-help">更新时间：${esc(live.at || '—')}</p>
      <p class="form-help">资源域名：<code>${esc(live.resBase || '—')}</code></p>
      <div class="form-group"><label class="form-label">新 JWT</label>
        <textarea id="api-token" rows="4" placeholder="JWT" style="width:100%;box-sizing:border-box;"></textarea></div>
      <div class="form-group"><label class="form-label">资源域名</label>
        <input id="api-resbase" value="${esc(live.resBase || '')}" /></div>
      <button class="btn btn-primary" id="api-save">保存并立即上线</button>
    </div>`
  $('#api-save').onclick = () => runAction($('#api-save'), async () => {
    const token = $('#api-token').value.trim()
    if (!token) return toast('请粘贴新 token')
    if (!confirm('替换线上 Token？')) return
    const body = { token, resBase: $('#api-resbase').value.trim() }
    const out = await api('/api/admin/api-session', { method: 'PUT', body: JSON.stringify(body) })
    const refreshed = await refreshAfterCommit(out)
    try { await renderApiSession(main) } catch { refreshed.refreshWarning = true }
    toast(`已上线 uid ${out.session?.uid || ''}`, refreshed)
  })
}

async function renderDramaApiKey(main) {
  if (user?.role !== 'super') {
    main.innerHTML = '<div class="card">仅超管可管理短剧 API Key</div>'
    return
  }
  const data = await api('/api/admin/drama-api-keys')
  const keys = data.keys || []
  const scopeText = (scopes) => {
    const names = Array.isArray(scopes) ? scopes : []
    const dewu = names.includes('dewu')
    const huangguo = names.includes('huangguo')
    if (dewu && huangguo) return '黄果 + 得污'
    if (huangguo) return '黄果'
    if (dewu) return '得污'
    return ''
  }
  main.innerHTML = `
    <div class="page-header"><span class="page-title">短剧 API Key</span></div>
    <div class="card" style="max-width:920px;margin-bottom:16px;">
      <div class="form-group"><label class="form-label">备注</label><input id="drama-remark" maxlength="40" /></div>
      <div class="form-group"><label class="form-label">范围</label>
        <select id="drama-scope">
          <option value="both">黄果 + 得污</option>
          <option value="huangguo">黄果</option>
          <option value="dewu">得污</option>
        </select>
      </div>
      <button class="btn btn-primary" id="drama-create" type="button">创建</button>
    </div>
    <div class="card" style="padding:0;overflow:auto;"><table>
      <thead><tr><th>备注</th><th>范围</th><th>状态</th><th>最近使用</th><th>钥匙</th><th></th></tr></thead>
      <tbody>${keys.map((row) => `<tr data-id="${esc(row.id)}">
        <td>${esc(row.remark)}</td>
        <td>${esc(scopeText(row.scopes))}</td>
        <td>${row.paused ? '已暂停' : '使用中'}</td>
        <td>${esc(row.lastUsedAt ? new Date(row.lastUsedAt).toLocaleString() : '—')}</td>
        <td><input class="drama-secret" type="password" readonly value="${esc(row.secret)}" style="width:280px;" /></td>
        <td style="white-space:nowrap;">
          <button class="btn btn-gray btn-sm" data-act="toggle" type="button">显示</button>
          <button class="btn btn-blue btn-sm" data-act="copy" type="button">复制</button>
          <button class="btn btn-gray btn-sm" data-act="pause" type="button">${row.paused ? '恢复' : '暂停'}</button>
          <button class="btn btn-primary btn-sm" data-act="delete" type="button">删除</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="6" class="empty-row">暂无钥匙</td></tr>'}
      </tbody></table></div>`
  $('#drama-create').onclick = async () => {
    const button = $('#drama-create')
    button.disabled = true
    try {
      await api('/api/admin/drama-api-keys', {
        method: 'POST',
        body: JSON.stringify({ remark: $('#drama-remark').value, scopes: $('#drama-scope').value }),
      })
      toast('已创建')
      await renderDramaApiKey(main)
    } catch (error) {
      button.disabled = false
      toast(error.message || '创建失败')
    }
  }
  main.querySelector('tbody').onclick = async (event) => {
    const button = event.target.closest('button[data-act]')
    if (!button) return
    const row = button.closest('tr')
    const id = row?.dataset.id
    const record = keys.find((item) => item.id === id)
    if (!record) return
    const act = button.dataset.act
    if (act === 'toggle') {
      const input = row.querySelector('.drama-secret')
      const shown = input.type === 'text'
      input.type = shown ? 'password' : 'text'
      button.textContent = shown ? '显示' : '隐藏'
      return
    }
    if (act === 'copy') {
      try {
        await navigator.clipboard.writeText(record.secret)
      } catch {
        const input = row.querySelector('.drama-secret')
        input.type = 'text'
        input.select()
        document.execCommand('copy')
      }
      toast('已复制')
      return
    }
    if (act === 'pause') {
      button.disabled = true
      try {
        await api(`/api/admin/drama-api-keys/${encodeURIComponent(id)}`, {
          method: 'POST',
          body: JSON.stringify({ paused: !record.paused }),
        })
        await renderDramaApiKey(main)
      } catch (error) {
        button.disabled = false
        toast(error.message || '操作失败')
      }
      return
    }
    if (act === 'delete') {
      if (!confirm('删除？')) return
      button.disabled = true
      try {
        await api(`/api/admin/drama-api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' })
        toast('已删除')
        await renderDramaApiKey(main)
      } catch (error) {
        button.disabled = false
        toast(error.message || '删除失败')
      }
    }
  }
}

function openPasswordModal(opts = {}) {
  const required = Boolean(opts.required || user?.mustChangePassword)
  const modal = $('#modal')
  const box = $('#modal-box')
  box.className = 'modal-box narrow'
  box.innerHTML = `
    <div class="modal-header"><div class="modal-title">修改密码</div>
      ${required ? '' : '<button class="modal-close" id="modal-close" type="button">×</button>'}</div>
    ${required ? '<div class="notice">当前账号还在用初始密码，必须先改密才能继续。</div>' : ''}
    <div class="form-group"><label class="form-label">原密码</label><input type="password" id="pw-old" autocomplete="current-password" /></div>
    <div class="form-group"><label class="form-label">新密码（至少 10 位）</label><input type="password" id="pw-new" autocomplete="new-password" /></div>
    <div class="form-group"><label class="form-label">确认新密码</label><input type="password" id="pw-confirm" autocomplete="new-password" /></div>
    <div class="err" id="pw-err"></div>
    <div class="modal-footer">
      ${required ? '' : '<button class="btn btn-gray" id="modal-cancel" type="button">取消</button>'}
      <button class="btn btn-primary" id="pw-save" type="button">保存密码</button>
    </div>`
  modal.classList.add('show')
  const close = () => {
    if (required) return
    modal.classList.remove('show')
  }
  $('#modal-close')?.addEventListener('click', close)
  $('#modal-cancel')?.addEventListener('click', close)
  $('#pw-save').onclick = async () => {
    const err = $('#pw-err')
    err.textContent = ''
    const oldPassword = $('#pw-old').value
    const newPassword = $('#pw-new').value
    const confirm = $('#pw-confirm').value
    if (!oldPassword) return (err.textContent = '请填写原密码')
    if (newPassword.length < 10) return (err.textContent = '新密码至少 10 位')
    if (newPassword !== confirm) return (err.textContent = '两次新密码不一致')
    if (newPassword === oldPassword) return (err.textContent = '新密码不能和原密码相同')
    try {
      await api('/api/admin/change-password', {
        method: 'POST',
        body: JSON.stringify({ oldPassword, newPassword }),
      })
      user = null
      modal.classList.remove('show')
      showLogin()
      $('#login-pass').value = ''
      toast('密码已更新，所有旧会话已退出，请重新登录')
    } catch (e) {
      err.textContent = e.message
    }
  }
}

function renderSecurity(main) {
  main.innerHTML = `
    <div class="page-header"><span class="page-title">安全设置</span></div>
    <div class="card" style="max-width:520px;">
      <h3 style="margin-bottom:12px;">修改密码</h3>
      <p class="form-help">任何登录账号都可以改自己的密码，不必找超管。</p>
      <button class="btn btn-primary" id="pw-open">修改我的密码</button>
      <hr style="border-color:#222;margin:22px 0" />
      <h3 style="margin-bottom:12px;">两步验证 (TOTP)</h3>
      <div id="totp-area">${user.totpEnabled ? '<input id="totp-disable-code" placeholder="当前 6 位验证码" /><button class="btn btn-gray" id="totp-disable">关闭 2FA 后重新设置</button>' : '<button class="btn btn-blue" id="totp-setup">生成密钥</button>'}</div>
    </div>`
  $('#pw-open').onclick = () => openPasswordModal()
  if ($('#totp-disable')) $('#totp-disable').onclick = async () => {
    try {
      await api('/api/admin/totp/disable', { method: 'POST', body: JSON.stringify({ code: $('#totp-disable-code').value.trim() }) })
      user.totpEnabled = false
      renderSecurity(main)
      toast('2FA 已关闭，可重新设置')
    } catch (error) { toast(error.message) }
  }
  if ($('#totp-setup')) $('#totp-setup').onclick = async () => {
    try {
    const data = await api('/api/admin/totp/setup', { method: 'POST', body: '{}' })
    $('#totp-area').innerHTML = `
      <p class="form-help">密钥：<code>${esc(data.secret)}</code></p>
      <p class="form-help">otpauth：<a href="${esc(data.otpauth)}" target="_blank">${esc(data.otpauth)}</a></p>
      <div class="form-group"><input id="totp-code" placeholder="输入 6 位验证码启用" /></div>
      <button class="btn btn-primary" id="totp-enable">启用 2FA</button>`
    $('#totp-enable').onclick = async () => {
      try {
      await api('/api/admin/totp/enable', { method: 'POST', body: JSON.stringify({ code: $('#totp-code').value.trim() }) })
      toast('2FA 已启用')
      user.totpEnabled = true
      renderSecurity(main)
      } catch (error) { toast(error.message) }
    }
    } catch (error) { toast(error.message) }
  }
}

$('#login-btn').onclick = login
$('#logout-btn').onclick = logout
$('#publish-btn').onclick = publish
$('#preview-btn').onclick = openDraftPreview
$('#password-btn').onclick = () => openPasswordModal()

;(async function init() {
  try {
    const data = await api('/api/admin/me')
    user = data.user
    if (user.mustChangePassword) return openPasswordModal({ required: true })
    await loadBundle()
    showAdmin()
    if (user.mustChangePassword) openPasswordModal({ required: true })
  } catch {
    showLogin()
  }
})()

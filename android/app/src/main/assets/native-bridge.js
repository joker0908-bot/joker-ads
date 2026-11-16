(() => {
  if (window.top !== window || location.origin !== 'https://b12sl5x.cn' ||
      !window.BoluoNative || window.__boluoNativeReady) return;
  window.__boluoNativeReady = true;
  const pending = new Map();
  let sequence = 0;
  BoluoNative.onmessage = event => {
    let result;
    try { result = JSON.parse(event.data); } catch (_) { return; }
    const task = pending.get(result.id);
    if (!task || !['success', 'error', 'cancelled'].includes(result.status)) return;
    pending.delete(result.id);
    clearTimeout(task.timer);
    if (result.status === 'error') task.reject(new Error(result.error || '原生操作失败'));
    else task.resolve(result);
  };
  const request = (message, timeoutMs) => new Promise((resolve, reject) => {
    const id = 'boluo-' + Date.now().toString(36) + '-' + (++sequence);
    const timer = timeoutMs ? setTimeout(() => {
      if (!pending.delete(id)) return;
      reject(new Error('原生操作超时'));
    }, timeoutMs) : null;
    pending.set(id, { resolve, reject, timer });
    try { BoluoNative.postMessage(JSON.stringify({ ...message, id })); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
  window.BoluoBridge = {
    copyText: text => request({ type: 'copy', text: String(text) }, 5000),
    saveImage: (data, name = 'boluo-card.png') => request({ type: 'saveImage', data, name }, 0),
  };
  const save = anchor => {
    if (!anchor.href.startsWith('data:image/png;base64,')) return false;
    // 仅作兼容。新页面应直接 await BoluoBridge.saveImage。
    void window.BoluoBridge.saveImage(anchor.href, anchor.download || 'boluo-card.png').catch(() => {});
    return true;
  };
  const originalClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (!save(this)) return originalClick.call(this);
  };
  document.addEventListener('click', event => {
    const anchor = event.target.closest?.('a');
    if (anchor && save(anchor)) event.preventDefault();
  }, true);
  try {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: text => window.BoluoBridge.copyText(text).then(result => {
        if (result.status !== 'success') throw new Error('复制已取消');
      })
    }});
  } catch (_) { /* 调用方也可以直接使用 BoluoBridge.copyText。 */ }
})();

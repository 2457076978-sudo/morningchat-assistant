// 盲听助手 · 主世界注入 v2.0 —— MediaSession 接管 + B站字幕捕获
// 隔离世界（content script）注册 setActionHandler 无效，须在主世界操作；事件经 CustomEvent 转发
(() => {
  if (window.__mxMainInstalled) return;
  window.__mxMainInstalled = true;

  // ---------- 耳机线控 / 媒体键 ----------
  const ACTIONS = ['play', 'pause', 'previoustrack', 'nexttrack',
    'seekbackward', 'seekforward', 'seekto', 'stop'];

  function hook() {
    if (!('mediaSession' in navigator)) return;
    for (const a of ACTIONS) {
      try {
        navigator.mediaSession.setActionHandler(a, () => {
          if (a === 'play' || a === 'pause') {
            window.dispatchEvent(new CustomEvent('mx-media-trigger'));
          }
          // 双击（跳曲）/长按（快进）等动作一律吞掉
        });
      } catch (e) {}
    }
  }
  hook();
  setInterval(hook, 2000);
  document.addEventListener('visibilitychange', hook);

  function emitSub(json) {
    try { window.dispatchEvent(new CustomEvent('mx-subtitle', { detail: json })); } catch (e) {}
  }

  // ---------- fetch 捕获字幕（B站 AI/CC 字幕 JSON） ----------
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function () {
      const p = origFetch.apply(this, arguments);
      try {
        const a0 = arguments[0];
        const url = String((a0 && (a0.url || a0)) || '');
        if (/aisubtitle\.hdslb\.com|\/subtitle|subtitle.*\.json|timedtext/.test(url)) {
          p.then(r => r.clone().json().then(emitSub).catch(() => {})).catch(() => {});
        }
      } catch (e) {}
      return p;
    };
  }

  // ---------- XHR 捕获字幕（老播放器路径） ----------
  const oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function () { this.__mxUrl = String(arguments[1] || ''); return oo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    if (/aisubtitle|\/subtitle|timedtext/.test(this.__mxUrl || '')) {
      this.addEventListener('load', () => {
        try { emitSub(JSON.parse(this.responseText)); } catch (e) {}
      });
    }
    return os.apply(this, arguments);
  };
})();

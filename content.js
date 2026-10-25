// 盲听助手 · B站版 v2.0 —— 单击递进降速 + 循环磨耳朵 + 字幕混合分句 + 触发统计
// v2.0：①B站字幕捕获→合并成句（精确分句，静音检测降为兜底）②触发统计（本视频难点Top榜/累计/跳转/清空）
// v1.1：档位完全客制化——数量 1–4 档、每档速度任意设；旧版 speed1/speed2 自动迁移
// v1.0：黑白线条 SVG 图标（告别 emoji）、按钮可拖动+位置记忆、循环层、分句灵敏度可调、触发计数
// v0.5：⚙ 设置面板（回退方式/倍速/回原速时机）持久化
// v0.4：句界判断重写（句中按=本句开头；停顿中按=刚播完那句；新句开头1秒内按=上一句）
// v0.3：耳机线控由 main.js 在页面主世界接管 MediaSession
// 仅限本人本机试用：专利递交前请勿分发、上架、演示录屏外发
(() => {
  // ---------- 可配置项（⚙ 面板可改，localStorage 持久化） ----------
  const DEFAULTS = {
    mode: 'sentence',     // 'sentence'=按句子回退 | 'fixed'=固定秒数回退
    fixedSec: 6,          // 固定模式：回退秒数
    speeds: [0.8, 0.6],   // 档位倍速数组（1–4 档，逐次递进）
    returnMode: 'finish', // 'finish'=复读内容播完自动回 | 'duration'=慢速播满N秒回
    returnSec: 10,        // duration 模式：慢速播放秒数上限
    gapSec: 0.5,          // 分句灵敏度：句间停顿判定秒数
    loop: true,           // 最后一档之后循环磨耳朵
    theme: 'auto'         // auto 跟随站点/系统深浅，可手动 light/dark
  };
  const SILENCE_RMS = 0.012;        // 静音音量阈值
  const EARLY_PRESS_SEC = 1.0;      // 新句开始后 1 秒内按键 = 想回上一句
  const MAX_SENTENCE = 8;           // 找不到句界时的最长回溯秒数
  const RETURN_DELAY_MS = 250;      // 复读结束到回原速的间隔
  const WATCHDOG_GRACE_MS = 2500;   // 看门狗宽限（容忍缓冲卡顿）

  function loadCfg() {
    let c;
    try {
      const raw = localStorage.getItem('mx-settings');
      c = Object.assign({}, DEFAULTS, raw ? JSON.parse(raw) : {});
    } catch (e) { c = Object.assign({}, DEFAULTS); }
    // 迁移旧版 speed1/speed2 → speeds 数组；清洗非法值
    if (!Array.isArray(c.speeds) || !c.speeds.length) {
      const s1 = Number(c.speed1), s2 = Number(c.speed2);
      c.speeds = [isFinite(s1) ? s1 : 0.8, isFinite(s2) ? s2 : 0.6];
    }
    c.speeds = c.speeds.map(v => {
      v = Number(v);
      return isFinite(v) ? Math.min(1.5, Math.max(0.1, v)) : 0.8;
    }).slice(0, 4);
    if (!c.speeds.length) c.speeds = [0.8];
    return c;
  }
  function saveCfg() {
    try { localStorage.setItem('mx-settings', JSON.stringify(cfg)); } catch (e) {}
  }
  let cfg = loadCfg();
  const rateFor = lv => Number(cfg.speeds[lv - 1]) || 0.8;
  const tierMark = lv => ['①', '②', '③', '④'][lv - 1] || ('[' + lv + ']');

  let state = 0;                    // 0=连续播放 1=第一档 2=第二档
  let loopMode = false;             // 第三档：本句无限循环
  let sentenceStart = 0, sentenceEnd = 0;
  let returning = false, guard = false;
  let replayStartedAt = 0;
  let videoTriggers = 0;
  let audioCtx = null, hookedVideo = null, useSilence = true;
  let inSpeech = false, segStart = 0, lastLoud = 0, prevSeg = null;
  let SUBS = null;                        // 字幕句 [{start,end,text}]（来自B站字幕，优先于静音检测）

  // B站页面可能有多个 video：优先正在播放的，再按画面大小
  function findVideo() {
    const cands = Array.from(document.querySelectorAll('video'));
    if (!cands.length) return null;
    const playing = cands.filter(v => !v.paused && !v.ended && v.readyState > 2);
    const pool = playing.length ? playing : cands.filter(v => v.readyState > 2);
    const list = pool.length ? pool : cands;
    return list.sort((a, b) => b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight)[0] || null;
  }

  // ---------- 图标（黑白线条 SVG） ----------
  const ICON_REPLAY =
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<polyline points="1.5 4 1.5 10 7.5 10"/><path d="M3.6 15a9 9 0 1 0 2.1-9.4L1.5 10"/></svg>';
  const ICON_LOOP =
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/>' +
    '<polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>';
  const ICON_SLIDERS =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
    '<line x1="4" y1="7" x2="20" y2="7"/><circle cx="9" cy="7" r="2.4" fill="#fff"/>' +
    '<line x1="4" y1="17" x2="20" y2="17"/><circle cx="15" cy="17" r="2.4" fill="#fff"/></svg>';

  // ---------- UI：容器（可拖动）+ 主按钮 + 设置钮 + HUD + 面板 ----------
  let box = null, mainBtn = null, gearBtn = null, hud = null, panel = null, hudTimer = null;

  function injectStyle() {
    if (document.getElementById('mx-style')) return;
    const st = document.createElement('style');
    st.id = 'mx-style';
    st.textContent = `
      #mx-box{--pbg:#FFFDF8;--pfg:#111;--pfg2:#555;--pfg3:#999;--phair:#E6E6EA;--prow:#F1EADA;--psec:#9A9AA2;--pvh:#f6f6f8;--pbtn:#fff;--pbtnfg:#333;--paccent:#B5541F}
      #mx-box.dark{--pbg:#211E18;--pfg:#EDE6D6;--pfg2:#C4BBA8;--pfg3:#8A8271;--phair:#3C362A;--prow:#2B271F;--psec:#8A8271;--pvh:#2B271F;--pbtn:#2B271F;--pbtnfg:#EDE6D6;--paccent:#E07A4F}
      #mx-box{position:fixed;z-index:999999;width:44px;height:44px;user-select:none;-webkit-user-select:none;touch-action:none}
      #mx-main{width:44px;height:44px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;
        background:rgba(17,17,18,.82);color:#fff;border:1px solid rgba(255,255,255,.22);
        backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);transition:transform .12s,background .15s,color .15s}
      #mx-main:hover{transform:scale(1.07)}
      #mx-main:active{transform:scale(.94)}
      #mx-main.on{background:#fff;color:#111;border-color:#fff}
      #mx-box.loop #mx-main{background:#fff;color:#111;animation:mxpulse 1.1s ease-in-out infinite}
      @keyframes mxpulse{0%,100%{box-shadow:0 0 0 0 rgba(255,255,255,.55)}55%{box-shadow:0 0 0 7px rgba(255,255,255,0)}}
      #mx-gear{position:absolute;top:-32px;right:2px;width:28px;height:28px;border-radius:50%;cursor:pointer;
        display:flex;align-items:center;justify-content:center;background:rgba(17,17,18,.62);color:rgba(255,255,255,.8);
        border:1px solid rgba(255,255,255,.18);opacity:.55;transition:opacity .15s}
      #mx-gear:hover{opacity:1}
      #mx-hud{position:absolute;bottom:calc(100% + 40px);right:0;white-space:nowrap;pointer-events:none;
        background:rgba(17,17,18,.85);color:#fff;padding:6px 12px;border-radius:14px;border:1px solid rgba(255,255,255,.16);
        font:12px/1.4 -apple-system,'PingFang SC',sans-serif;letter-spacing:.02em;opacity:0;transition:opacity .22s}
      #mx-panel{position:absolute;bottom:calc(100% + 10px);right:0;width:272px;display:none;
        background:var(--pbg);color:var(--pfg);border:1px solid var(--phair);border-radius:14px;box-shadow:0 10px 34px rgba(0,0,0,.28);
        padding:0 0 10px;font:12.5px/1.8 -apple-system,'PingFang SC',sans-serif;overflow:hidden}
      #mx-panel h4{margin:0;padding:12px 14px 8px;font-size:13px;font-weight:600;letter-spacing:.06em}
      #mx-tabs{display:flex;border-bottom:1px solid var(--phair);margin:0 0 6px}
      #mx-tabs b{flex:1;text-align:center;padding:7px 0 6px;font-size:12.5px;font-weight:400;color:var(--pfg3);
        cursor:pointer;border-bottom:2px solid transparent}
      #mx-tabs b.on{color:var(--paccent);border-bottom-color:var(--paccent);font-weight:600}
      .mx-tab{display:none;padding:2px 14px 0}
      .mx-tab.on{display:block}
      #mx-panel .row{display:flex;align-items:center;justify-content:space-between;gap:6px;margin:2px 0}
      #mx-panel .row>span:first-child{color:var(--pfg2)}
      #mx-panel input[type=number]{width:52px;border:1px solid var(--phair);border-radius:6px;padding:2px 6px;font:inherit;
        text-align:center;background:var(--pbg);color:var(--pfg)}
      #mx-panel select{font:inherit;border:1px solid var(--phair);border-radius:6px;padding:2px 4px;background:var(--pbg);color:var(--pfg)}
      #mx-panel label{display:inline-flex;align-items:center;gap:3px;cursor:pointer}
      #mx-panel .btns{display:flex;justify-content:flex-end;gap:8px;margin-top:10px}
      #mx-panel button{font:inherit;cursor:pointer;border-radius:7px;padding:4px 13px;border:1px solid var(--phair);
        background:var(--pbtn);color:var(--pbtnfg)}
      #mx-panel button.primary{background:var(--pfg);color:var(--pbg);border-color:var(--pfg)}
      #mx-panel .sub{color:var(--pfg3);font-size:11px;margin-top:6px;line-height:1.7}
      #mx-panel .sec{margin-top:9px;padding-top:7px;border-top:1px solid var(--prow);color:var(--psec);font-size:11px;letter-spacing:.05em}
      #mx-panel .preview{margin-top:10px;background:var(--pvh);border-radius:8px;padding:7px 9px;font-size:12px;color:var(--pfg);letter-spacing:.02em}
      #mx-panel .statline{font-size:12.5px;color:var(--pfg2);margin:4px 0}
      #mx-panel .statline b{color:var(--pfg)}
      #mx-panel .statline.dim{color:var(--pfg3)}
      #mx-panel .statrow{display:flex;align-items:center;gap:8px;padding:5px 8px;margin:3px 0;background:var(--pvh);
        border-radius:8px;font-size:12px;cursor:pointer;color:var(--pfg)}
      #mx-panel .statrow:hover{filter:brightness(.94)}
      #mx-panel .statrow-t{font-variant-numeric:tabular-nums;min-width:38px}
      #mx-panel .statrow-n{color:var(--paccent)}
      #mx-panel .statrow-go{margin-left:auto;color:var(--pfg3)}
      #mx-footer{display:flex;align-items:center;justify-content:space-between;margin-top:8px;padding:8px 14px 0;
        border-top:1px solid var(--phair);font-size:10.5px;color:var(--pfg3)}
      #mx-theme{cursor:pointer;border:1px solid var(--phair);border-radius:6px;padding:1px 8px}
      #mx-box.rec #mx-main{box-shadow:0 0 0 3px rgba(198,40,40,.85) !important}
    `;
    document.head.appendChild(st);
  }

  function buildUI() {
    if (document.getElementById('mx-box')) return;
    injectStyle();

    box = document.createElement('div');
    box.id = 'mx-box';

    mainBtn = document.createElement('div');
    mainBtn.id = 'mx-main';
    mainBtn.title = '没听清就点一下（耳机线控 / S 键等效）· 按住可拖动';
    mainBtn.innerHTML = ICON_REPLAY;
    box.appendChild(mainBtn);

    gearBtn = document.createElement('div');
    gearBtn.id = 'mx-gear';
    gearBtn.title = '盲听助手设置';
    gearBtn.innerHTML = ICON_SLIDERS;
    gearBtn.addEventListener('click', e => { e.stopPropagation(); togglePanel(); });
    box.appendChild(gearBtn);

    hud = document.createElement('div');
    hud.id = 'mx-hud';
    box.appendChild(hud);

    document.body.appendChild(box);

    buildSettingsPanel();
    applySavedPos();
    bindDrag();
  }

  const segSrc = () => SUBS ? '字幕句' : (useSilence ? '静音句' : '固定回退');

  // ---------- 深浅主题（跟随站点/系统，可手动） ----------
  function detectDark() {
    if (cfg.theme === 'dark') return true;
    if (cfg.theme === 'light') return false;
    if (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) return true;
    try {                                    // 站点背景亮度探测（B站夜间/YouTube暗色）
      const m = getComputedStyle(document.body).backgroundColor.match(/\\d+/g);
      if (m && m.length >= 3) return (+m[0] * .299 + +m[1] * .587 + +m[2] * .114) < 60;
    } catch (e) {}
    return false;
  }
  function applyTheme() {
    if (!box) return;
    box.classList.toggle('dark', detectDark());
    const t = panel && panel.querySelector('#mx-theme');
    if (t) t.textContent = '深浅:' + ({ auto: '自动', light: '浅色', dark: '深色' })[cfg.theme || 'auto'];
  }

  function say(text, ms = 1400) {
    if (!hud) return;
    hud.textContent = text;
    hud.style.opacity = '1';
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => { hud.style.opacity = '0'; }, ms);
  }
  const fmt = n => (Math.round(n * 10) / 10).toFixed(1);

  // ---------- 拖动 & 位置记忆 ----------
  function savePos(x, y) {
    try { localStorage.setItem('mx-btn-pos', JSON.stringify({ x, y })); } catch (e) {}
  }
  function applySavedPos() {
    // 无记忆位置时给默认位置：右下角（等效旧版 right:18 / bottom:24）
    const w = window.innerWidth, h = window.innerHeight;
    let x = w - 44 - 18, y = h - 44 - 24;
    try {
      const p = JSON.parse(localStorage.getItem('mx-btn-pos'));
      if (p && isFinite(p.x) && isFinite(p.y)) { x = p.x; y = p.y; }
    } catch (e) {}
    box.style.right = 'auto';
    box.style.bottom = 'auto';
    clampTo(x, y);
  }
  function clampTo(x, y) {
    const w = box.offsetWidth || 44, h = box.offsetHeight || 44;
    const x2 = Math.min(Math.max(4, x), window.innerWidth - w - 4);
    const y2 = Math.min(Math.max(4, y), window.innerHeight - h - 4);
    box.style.left = x2 + 'px';
    box.style.top = y2 + 'px';
  }
  function bindDrag() {
    let sx = 0, sy = 0, ox = 0, oy = 0, moved = false, down = false;
    mainBtn.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      down = true; moved = false;
      sx = e.clientX; sy = e.clientY;
      const r = box.getBoundingClientRect();
      ox = r.left; oy = r.top;
      try { mainBtn.setPointerCapture(e.pointerId); } catch (err) {}
    });
    mainBtn.addEventListener('pointermove', e => {
      if (!down) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 6) return;
      moved = true;
      box.style.right = 'auto'; box.style.bottom = 'auto';
      clampTo(ox + dx, oy + dy);
    });
    mainBtn.addEventListener('pointerup', () => {
      if (!down) return;
      down = false;
      if (moved) {
        const r = box.getBoundingClientRect();
        savePos(r.left, r.top);
        say('✓ 已移动', 700);
      } else {
        trigger();
      }
    });
    mainBtn.addEventListener('pointercancel', () => { down = false; });
  }

  // ---------- ⚙ 设置面板 ----------
  function buildSettingsPanel() {
    panel = document.createElement('div');
    panel.id = 'mx-panel';
    panel.innerHTML = `
      <h4>盲听助手</h4>
      <div id="mx-tabs"><b data-t="tab-set" class="on">交互</b><b data-t="tab-data">数据</b><b data-t="tab-rec">录制</b></div>

      <div class="mx-tab on" id="tab-set">
        <div class="sec" style="border-top:none;padding-top:2px">降速档位</div>
        <div class="row"><span>档位数</span>
          <select id="mx-tiers">
            <option value="1">1 档</option><option value="2">2 档</option>
            <option value="3">3 档</option><option value="4">4 档</option>
          </select></div>
        <div class="row tier"><span>第①档</span><span><input class="mx-sp" type="number" min="0.1" max="1.5" step="0.05"> x</span></div>
        <div class="row tier"><span>第②档</span><span><input class="mx-sp" type="number" min="0.1" max="1.5" step="0.05"> x</span></div>
        <div class="row tier"><span>第③档</span><span><input class="mx-sp" type="number" min="0.1" max="1.5" step="0.05"> x</span></div>
        <div class="row tier"><span>第④档</span><span><input class="mx-sp" type="number" min="0.1" max="1.5" step="0.05"> x</span></div>
        <div class="row"><span>最后一档后</span>
          <span><label><input id="mx-loop" type="checkbox">循环本句</label></span></div>

        <div class="sec">回退到哪里</div>
        <div class="row"><span>方式</span>
          <span><label><input type="radio" name="mx-mode" value="sentence">按句子</label>
          <label><input type="radio" name="mx-mode" value="fixed">固定秒数</label></span></div>
        <div class="row cond-fixed"><span>固定回退</span><span><input id="mx-fixed" type="number" min="1" max="30" step="0.5"> 秒</span></div>

        <div class="sec">分句灵敏度</div>
        <div class="row"><span>句间停顿</span>
          <select id="mx-gap">
            <option value="0.3">灵敏 · 切短句</option>
            <option value="0.5">标准</option>
            <option value="0.8">宽松 · 保留长句</option>
          </select></div>

        <div class="sec">何时回原速</div>
        <div class="row"><span>时机</span>
          <span><label><input type="radio" name="mx-ret" value="finish">复读播完</label>
          <label><input type="radio" name="mx-ret" value="duration">慢速播满</label></span></div>
        <div class="row cond-ret"><span>慢速上限</span><span><input id="mx-retsec" type="number" min="1" max="60" step="1"> 秒</span></div>

        <div class="preview" id="mx-preview"></div>
        <div class="btns">
          <button id="mx-reset">恢复默认</button>
          <button id="mx-save" class="primary">保存</button>
        </div>
      </div>

      <div class="mx-tab" id="tab-data">
        <div class="sec" style="border-top:none;padding-top:2px">触发统计</div>
        <div id="mx-stats"></div>
        <div class="btns" style="justify-content:flex-start">
          <button id="mx-statclear" style="font-size:11px;padding:2px 10px">清空本视频</button>
        </div>
      </div>

      <div class="mx-tab" id="tab-rec">
        <div class="sec" style="border-top:none;padding-top:2px">学习期录制</div>
        <div class="row"><span>内录本节 + 标记导出</span>
          <button id="mx-rec" style="font-size:11px;padding:2px 10px;cursor:pointer">● 开始录制（G）</button></div>
        <div class="sub">分享弹窗选「本标签页」并勾选音频；结束自动导出 音频+标记+复习页</div>

        <div class="sec">快捷键</div>
        <div class="statline" style="line-height:2">
          <b>S</b> 触发降速 · <b>L</b> 进/出循环 · <b>X</b> 结束回原速<br>
          <b>[ ]</b> 上一句 / 下一句 · <b>, .</b> 回退 / 前进 3 秒<br>
          <b>P</b> 本面板 · <b>G</b> 录制开始 / 结束导出
        </div>
      </div>

      <div id="mx-footer">
        <span>S 降速 · L 循环 · [ ] 句 · G 录制</span>
        <span id="mx-theme">深浅:自动</span>
      </div>`;
    box.appendChild(panel);
    syncPanel();
    // 页签切换 + 主题切换
    panel.querySelectorAll('#mx-tabs b').forEach(b => b.addEventListener('click', () => {
      panel.querySelectorAll('#mx-tabs b').forEach(x => x.classList.toggle('on', x === b));
      panel.querySelectorAll('.mx-tab').forEach(t => t.classList.toggle('on', t.id === b.dataset.t));
    }));
    panel.querySelector('#mx-theme').addEventListener('click', () => {
      cfg.theme = { auto: 'light', light: 'dark', dark: 'auto' }[cfg.theme || 'auto'];
      saveCfg(); applyTheme();
    });
    applyTheme();
    panel.querySelector('#mx-statclear').addEventListener('click', () => {
      try {
        const all = statsAll();
        delete all[vid()];
        localStorage.setItem('mx-stats', JSON.stringify(all));
      } catch (e) {}
      renderStats();
      say('✓ 已清空本视频统计', 900);
    });
    panel.querySelector('#mx-rec').addEventListener('click', () => toggleRecord());
    updRecBtn();

    panel.querySelector('#mx-tiers').addEventListener('change', syncTierRows);
    // 面板内任何改动 → 联动显隐 + 实时预览
    const onPanelChange = () => { syncTierRows(); syncConditionalRows(); refreshPreview(); };
    panel.addEventListener('input', onPanelChange);
    panel.addEventListener('change', onPanelChange);
    panel.querySelector('#mx-save').addEventListener('click', () => {
      const clamp = (v, lo, hi, d) => { v = Number(v); return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
      const n = Math.round(clamp(panel.querySelector('#mx-tiers').value, 1, 4, 2));
      cfg.speeds = Array.from(panel.querySelectorAll('.mx-sp')).slice(0, n)
        .map(inp => clamp(inp.value, 0.1, 1.5, 0.8));
      if (!cfg.speeds.length) cfg.speeds = [0.8];
      cfg.mode = (panel.querySelector('input[name=mx-mode]:checked') || {}).value || 'sentence';
      cfg.fixedSec = clamp(panel.querySelector('#mx-fixed').value, 1, 30, 6);
      cfg.returnMode = (panel.querySelector('input[name=mx-ret]:checked') || {}).value || 'finish';
      cfg.returnSec = clamp(panel.querySelector('#mx-retsec').value, 1, 60, 10);
      cfg.gapSec = Number(panel.querySelector('#mx-gap').value) || 0.5;
      cfg.loop = panel.querySelector('#mx-loop').checked;
      saveCfg();
      panel.style.display = 'none';
      say('✓ 已保存 · ' + cfg.speeds.length + ' 档', 1100);
    });
    panel.querySelector('#mx-reset').addEventListener('click', () => {
      cfg = Object.assign({}, DEFAULTS);
      saveCfg();
      syncPanel();
      say('✓ 已恢复默认', 900);
    });
  }
  function syncTierRows() {
    if (!panel) return;
    const n = Math.min(4, Math.max(1, Number(panel.querySelector('#mx-tiers').value) || 2));
    panel.querySelectorAll('.row.tier').forEach((r, i) => {
      r.style.display = i < n ? 'flex' : 'none';
    });
  }
  function syncConditionalRows() {
    if (!panel) return;
    const mode = (panel.querySelector('input[name=mx-mode]:checked') || {}).value;
    const ret = (panel.querySelector('input[name=mx-ret]:checked') || {}).value;
    panel.querySelector('.cond-fixed').style.display = (mode === 'fixed') ? 'flex' : 'none';
    panel.querySelector('.cond-ret').style.display = (ret === 'duration') ? 'flex' : 'none';
  }
  function refreshPreview() {
    if (!panel) return;
    const n = Math.min(4, Math.max(1, Number(panel.querySelector('#mx-tiers').value) || 2));
    const marks = ['①', '②', '③', '④'];
    const parts = ['单击'];
    Array.from(panel.querySelectorAll('.mx-sp')).slice(0, n).forEach((inp, i) => {
      const v = Number(inp.value);
      parts.push(marks[i] + ' ' + (isFinite(v) ? v : '?') + 'x');
    });
    if (panel.querySelector('#mx-loop').checked) parts.push('∞ 循环');
    parts.push('回原速');
    panel.querySelector('#mx-preview').textContent = parts.join(' → ');
  }
  function syncPanel() {
    if (!panel) return;
    const n = Math.min(4, Math.max(1, cfg.speeds.length));
    panel.querySelector('#mx-tiers').value = String(n);
    panel.querySelectorAll('.mx-sp').forEach((inp, i) => {
      inp.value = cfg.speeds[i] ?? [0.8, 0.6, 0.5, 0.4][i];
    });
    panel.querySelectorAll('input[name=mx-mode]').forEach(x => { x.checked = (x.value === cfg.mode); });
    panel.querySelectorAll('input[name=mx-ret]').forEach(x => { x.checked = (x.value === cfg.returnMode); });
    panel.querySelector('#mx-fixed').value = cfg.fixedSec;
    panel.querySelector('#mx-retsec').value = cfg.returnSec;
    panel.querySelector('#mx-gap').value = String(cfg.gapSec);
    panel.querySelector('#mx-loop').checked = !!cfg.loop;
    syncTierRows();
    syncConditionalRows();
    refreshPreview();
  }
  function togglePanel() {
    if (!panel) return;
    const show = panel.style.display !== 'block';
    panel.style.display = show ? 'block' : 'none';
    if (show) {
      applyTheme();
      renderStats();
      // 靠左边缘时面板右对齐会出屏，改左对齐
      const r = box.getBoundingClientRect();
      panel.style.right = (r.left > 290) ? '0' : 'auto';
      panel.style.left = (r.left > 290) ? 'auto' : '0';
      syncPanel();
    }
  }

  // ---------- 耳机线控 / 媒体键 ----------
  // 媒体键由 main.js 在页面主世界接管（隔离世界注册 MediaSession 无效），事件转发到这里
  window.addEventListener('mx-media-trigger', () => trigger());

  // ---------- 字幕捕获（B站 body[] / YouTube json3 events[] → 合并成句） ----------
  window.addEventListener('mx-subtitle', ev => {
    try {
      const d = ev.detail || {};
      let lines = null;
      if (Array.isArray(d.body) && d.body.length >= 3) {
        lines = d.body;                                        // B站格式
      } else if (Array.isArray(d.events)) {                    // YouTube timedtext json3
        lines = d.events
          .filter(e => e && e.segs && e.tStartMs != null)
          .map(e => ({
            from: e.tStartMs / 1000,
            to: (e.tStartMs + (e.dDurationMs || 2000)) / 1000,
            content: e.segs.map(s => (s && s.utf8) || '').join('').replace(/\n/g, ' ')
          }));
      }
      if (!lines || lines.length < 3) return;
      const merged = (window.mxMergeSubs || (v => v))(lines, 0.45);
      if (Array.isArray(merged) && merged.length >= 2) {
        SUBS = merged;
        say('✓ 字幕分句就绪 · 共 ' + merged.length + ' 句', 1600);
      }
    } catch (e) {}
  });

  // ---------- 触发统计（按视频存 localStorage） ----------
  const vid = () => location.pathname.split('/').slice(0, 3).join('/');
  function statsAll() {
    try { return JSON.parse(localStorage.getItem('mx-stats') || '{}'); } catch (e) { return {}; }
  }
  function bumpStats() {
    try {
      const all = statsAll(), k = vid();
      const v = all[k] || { total: 0, hits: {} };
      v.total += 1;
      const key = Math.round(sentenceStart);
      v.hits[key] = (v.hits[key] || 0) + 1;
      all[k] = v;
      localStorage.setItem('mx-stats', JSON.stringify(all));
      if (panel && panel.style.display === 'block') renderStats();
    } catch (e) {}
  }
  function fmtTs(s) {
    return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  }
  function renderStats() {
    if (!panel) return;
    const box = panel.querySelector('#mx-stats');
    if (!box) return;
    const all = statsAll(), v = all[vid()];
    const grand = Object.values(all).reduce((a, b) => a + (b.total || 0), 0);
    if (!v || !v.total) {
      box.innerHTML = '<div class="statline dim">本视频还没有触发记录</div>';
      return;
    }
    const top = Object.entries(v.hits).sort((a, b) => b[1] - a[1]).slice(0, 3);
    box.innerHTML = '<div class="statline">本视频触发 <b>' + v.total + '</b> 次 · 全站累计 <b>' + grand + '</b> 次</div>' +
      top.map(([t, n]) =>
        '<div class="statrow" data-t="' + t + '"><span class="statrow-t">' + fmtTs(+t) + '</span>' +
        '<span class="statrow-n">×' + n + '</span><span class="statrow-go">跳到这句 ↵</span></div>').join('');
    box.querySelectorAll('.statrow').forEach(r => r.addEventListener('click', () => {
      const v2 = findVideo();
      if (v2) { v2.currentTime = +r.dataset.t; v2.play(); }
      panel.style.display = 'none';
    }));
  }

  // ---------- 句界跟踪：静音检测（失败退化为固定回溯窗口） ----------
  function hookAudio(video) {
    // 多站安全预检：DRM(EME) 或跨域不可分析的源不接管音频图
    // （createMediaElementSource 一旦接上跨域无CORS的源，视频会静音到刷新为止，必须先探后接）
    if (video.mediaKeys) { useSilence = false; return; }
    const src = video.currentSrc || video.src || '';
    const sameOrigin = !src || src.charAt(0) === '/' || src.indexOf(location.origin) === 0;
    if (sameOrigin) { startSilenceHook(video); return; }
    fetch(src, { method: 'HEAD', mode: 'cors' })
      .then(() => startSilenceHook(video))
      .catch(() => { useSilence = false; });
  }
  function startSilenceHook(video) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = audioCtx.createMediaElementSource(video);
      const an = audioCtx.createAnalyser();
      an.fftSize = 1024;
      src.connect(an);
      an.connect(audioCtx.destination);
      const buf = new Float32Array(an.fftSize);
      const hookedAt = performance.now();
      let everLoud = false, lastT = -1;
      setInterval(() => {
        // 复读/循环期间冻结句界跟踪；字幕模式下无需静音检测
        if (video.paused || !useSilence || state > 0 || returning || SUBS) return;
        an.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        if (rms >= SILENCE_RMS) everLoud = true;
        // 接管后8秒仍在播放却从未见过声波 → 源被跨域污染，弃用静音分句（保底固定回退）
        if (!everLoud && performance.now() - hookedAt > 8000 && video.currentTime !== lastT) {
          useSilence = false;
          say('⚠ 该站音频不可分析 · 已切固定回退（若无声请刷新）', 2600);
        }
        lastT = video.currentTime;
        if (!useSilence) return;
        const now = video.currentTime;
        if (rms >= SILENCE_RMS) {
          if (!inSpeech) { inSpeech = true; segStart = now; }
          lastLoud = now;
        } else if (inSpeech && now - lastLoud >= Number(cfg.gapSec)) {
          // 静音满设定秒数：确认"这句话说完了"，归档
          prevSeg = { start: segStart, end: lastLoud };
          inSpeech = false;
        }
      }, 50);
    } catch (e) {
      useSilence = false;
    }
  }

  // 选目标句：句中按=本句；停顿中按=刚播完那句；新句开头1秒内按=上一句
  function targetSeg(now) {
    // 字幕模式：精确句界（字幕句优先于静音检测）
    if (SUBS) {
      let idx = -1;
      for (let k = 0; k < SUBS.length; k++) if (now >= SUBS[k].start && now < SUBS[k].end) idx = k;
      if (idx === -1) {
        for (let k = 0; k < SUBS.length; k++) if (now >= SUBS[k].end && (k === SUBS.length - 1 || now < SUBS[k + 1].start)) { idx = k; break; }
      }
      if (idx >= 1 && now - SUBS[idx].start < EARLY_PRESS_SEC && now - SUBS[idx - 1].end <= 5) idx -= 1;
      if (idx >= 0) return { start: SUBS[idx].start, end: SUBS[idx].end };
    }
    if (useSilence && lastLoud > 0) {
      if (inSpeech) {
        if (now - segStart < EARLY_PRESS_SEC && prevSeg && now - prevSeg.end <= 5) {
          return prevSeg;
        }
        if (now - segStart <= MAX_SENTENCE) return { start: segStart, end: now };
      } else if (prevSeg && now - prevSeg.end <= 5) {
        return prevSeg;
      }
    }
    return { start: Math.max(0, now - MAX_SENTENCE), end: now };
  }

  // ---------- 状态机 ----------
  function setMainIcon() {
    if (!mainBtn) return;
    mainBtn.innerHTML = loopMode ? ICON_LOOP : ICON_REPLAY;
    mainBtn.classList.toggle('on', state > 0 && !loopMode);
    box.classList.toggle('loop', loopMode);
  }

  function trigger() {
    const v = findVideo();
    if (!v) return say('未找到视频');
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    if (v.paused) { v.play(); return; }

    if (loopMode) {                 // 循环中点按 → 结束循环，回原速继续
      backToNormal();
      return;
    }
    const now = v.currentTime;
    if (state === 0) {
      videoTriggers += 1;
      const seg = cfg.mode === 'fixed'
        ? { start: Math.max(0, now - Number(cfg.fixedSec)), end: now }
        : targetSeg(now);
      sentenceStart = seg.start;
      sentenceEnd = seg.end;
      bumpStats();
      logRecEvent(1);
      enterLevel(1);
    } else if (state < cfg.speeds.length) {
      logRecEvent(state + 1);
      enterLevel(state + 1);
    } else if (cfg.loop) {
      // 最后一档之后再点：本句无限循环磨耳朵
      loopMode = true;
      logRecEvent('loop');
      v.currentTime = sentenceStart;
      replayStartedAt = performance.now();
      setRate(rateFor(cfg.speeds.length));
      setMainIcon();
      say('∞ 循环本句 · 再点一下结束', 1800);
    } else {
      // 未启用循环：最后一档再点 = 再读一遍
      v.currentTime = sentenceStart;
      replayStartedAt = performance.now();
      say(tierMark(cfg.speeds.length) + ' ' + rateFor(cfg.speeds.length) + 'x 重读 · ' +
          fmt(sentenceEnd - sentenceStart) + 's', 1400);
    }
  }

  function enterLevel(lv) {
    const v = findVideo();
    if (!v) return;
    state = lv;
    v.currentTime = sentenceStart;
    replayStartedAt = performance.now();
    setRate(rateFor(lv));
    setMainIcon();
    say(tierMark(lv) + ' ' + rateFor(lv) + 'x 重听 · ' +
        fmt(sentenceEnd - sentenceStart) + 's · ×' + videoTriggers +
        (lv === 1 ? ' · ' + segSrc() : ''), 1400);
  }

  function setRate(r) {
    const v = findVideo();
    if (!v) return;
    guard = true;
    try {
      v.playbackRate = r;
      try { v.preservesPitch = true; } catch (e) {}
    } finally {
      setTimeout(() => { guard = false; }, 0);
    }
  }

  function backToNormal() {
    returning = true;
    setTimeout(() => {
      setRate(1.0);
      state = 0;
      loopMode = false;
      returning = false;
      setMainIcon();
      // 句界跟踪复位，从当前位置重新学习
      inSpeech = false; lastLoud = 0; prevSeg = null;
      say('✓ 回到原速', 900);
    }, RETURN_DELAY_MS);
  }

  // 复读播到句末 → 自动回原速；看门狗兜底；循环层只负责回跳
  setInterval(() => {
    const v = findVideo();
    if (!v) return;
    if (loopMode && !returning) {
      if (v.currentTime >= sentenceEnd - 0.05 || v.ended) v.currentTime = sentenceStart;
      return;
    }
    if (state === 0 || returning) return;
    if (cfg.returnMode === 'duration') {
      if (performance.now() - replayStartedAt >= cfg.returnSec * 1000 || v.ended) {
        backToNormal();
      }
      return;
    }
    const expectMs = (sentenceEnd - sentenceStart) / rateFor(state) * 1000;
    const overdue = performance.now() - replayStartedAt > expectMs + WATCHDOG_GRACE_MS;
    if (v.currentTime >= sentenceEnd - 0.05 || overdue || v.ended) {
      backToNormal();
    }
  }, 60);

  // B站自带速度菜单若把速度改回去，复读期间纠正一次
  document.addEventListener('ratechange', () => {
    if (state > 0 && !guard) {
      const v = findVideo();
      if (v && Math.abs(v.playbackRate - rateFor(state)) > 0.01) {
        setRate(rateFor(state));
      }
    }
  }, true);

  // ---------- 学习期录制（v2.2：内录音频 + 触发标记 + 复习页导出） ----------
  let rec = null;   // {stream, recorder, chunks, events, t0}
  function toggleRecord() {
    if (rec) { stopRecord(); return; }
    navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
      .then(stream => {
        if (!stream.getAudioTracks().length) {
          stream.getTracks().forEach(t => t.stop());
          say('✗ 没拿到音频：分享弹窗要选「本标签页」并勾选"同时分享音频"', 4000);
          return;
        }
        stream.getVideoTracks().forEach(t => t.stop());      // 只要音频
        rec = { stream, chunks: [], events: [], t0: performance.now() };
        const mr = new MediaRecorder(stream, { mimeType: 'audio/webm', audioBitsPerSecond: 48000 });
        mr.ondataavailable = e => { if (e.data && e.data.size) rec.chunks.push(e.data); };
        mr.onstop = () => { exportSession().catch(e => { say('✗ 导出失败：' + (e && e.message), 2500); rec = null; }); };
        mr.start(1000);
        rec.recorder = mr;
        box && box.classList.add('rec');
        updRecBtn();
        say('● 录制中 · 再按 G 结束并导出', 2200);
      })
      .catch(() => say('✗ 已取消分享', 1200));
  }
  function stopRecord() {
    if (!rec) return;
    rec.dur = (performance.now() - rec.t0) / 1000;
    try { rec.recorder.stop(); } catch (e) {}
    rec.stream.getTracks().forEach(t => t.stop());
    box && box.classList.remove('rec');
    updRecBtn();
  }
  function updRecBtn() {
    const b = panel && panel.querySelector('#mx-rec');
    if (b) b.textContent = rec ? '■ 结束并导出（G）' : '● 开始录制（G）';
  }
  // 每次触发时记录：录音墙钟时刻 + 该句在录音里的起止区间 + 层级 + 字幕文本
  function logRecEvent(level) {
    if (!rec) return;
    const v = findVideo();
    const wall = (performance.now() - rec.t0) / 1000;
    let ws = wall, we = wall, text = '';
    if (v) {
      const mt = v.currentTime;
      ws = Math.max(0, wall - Math.max(0, mt - sentenceStart));
      we = wall + Math.max(0, sentenceEnd - mt);
      if (SUBS) { const s = SUBS.find(x => mt >= x.start && mt < x.end); if (s) text = s.text; }
    }
    rec.events.push({
      wall: Math.round(wall * 10) / 10, ws: Math.round(ws * 10) / 10, we: Math.round(we * 10) / 10,
      mediaT: v ? Math.round(v.currentTime * 10) / 10 : null,
      level: level, text: text
    });
  }
  function dl(url, name) {
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function blobToB64(blob) {
    return new Promise(res => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.readAsDataURL(blob);
    });
  }
  async function exportSession() {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const base = '盲听期-' + location.host.replace(/\./g, '_') + '-' + stamp;
    const blob = new Blob(rec.chunks, { type: 'audio/webm' });
    const meta = { site: location.host, url: location.href, title: document.title,
                   date: new Date().toISOString(), durSec: Math.round(rec.dur || 0),
                   events: rec.events };
    const embedded = blob.size <= 28 * 1024 * 1024 ? await blobToB64(blob) : '';
    dl(URL.createObjectURL(blob), base + '.webm');
    dl(URL.createObjectURL(new Blob([JSON.stringify(meta, null, 1)], { type: 'application/json' })), base + '.标记.json');
    dl(URL.createObjectURL(new Blob([buildReviewPage(meta, embedded)],
      { type: 'text/html' })), base + '.复习页.html');
    say(embedded ? '✓ 已导出 3 件：音频 / 标记 / 复习页（音频已内嵌，双击即用）'
                 : '✓ 已导出 3 件（本节较长，复习页需手动载入同名 .webm）', 4000);
    rec = null;
  }
  function buildReviewPage(meta, embedded) {
    const evs = JSON.stringify(meta.events || []);
    const info = JSON.stringify({ title: meta.title, site: meta.site, url: meta.url, dur: meta.durSec });
    const emb = embedded || '';
    return '<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1"><title>盲听复习页</title><style>' +
      ':root{--bg:#F7F2E9;--card:#FFFDF8;--fg:#3B342A;--fg2:#8C8271;--hair:#E9E0CE;--ac:#B5541F;--deep:#A8873C;--ink2:#3B342A}' +
      '@media(prefers-color-scheme:dark){:root{--bg:#1E1B15;--card:#262218;--fg:#EDE6D6;--fg2:#8A8271;--hair:#3C362A;--ac:#E07A4F;--deep:#C9A85C;--ink2:#EDE6D6}}' +
      '*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,"PingFang SC",sans-serif;background:var(--bg);color:var(--fg);padding:28px 20px 90px;max-width:760px;margin:0 auto}' +
      'h1{font-size:22px;letter-spacing:.06em}.serif{font-family:"Songti SC",serif}' +
      '.cap{font-size:12px;color:var(--fg2);margin:8px 0 18px;line-height:1.8;word-break:break-all}' +
      '#wave{width:100%;height:74px;border-radius:12px;background:var(--card);border:1px solid var(--hair);display:block;cursor:pointer}' +
      '.bar{display:flex;gap:10px;align-items:center;margin:14px 0 6px;flex-wrap:wrap}' +
      '.btn{padding:8px 16px;border-radius:12px;border:1px solid var(--hair);background:var(--card);cursor:pointer;font-size:13.5px;color:var(--fg)}' +
      '.btn.main{background:var(--ink2);color:var(--bg);border:none}' +
      '.tier{font-size:14px;letter-spacing:.08em;color:var(--fg2);min-height:22px;margin:10px 0 4px}' +
      '.mark{border:1px solid var(--hair);background:var(--card);border-radius:14px;padding:11px 14px;margin:9px 0;cursor:pointer}' +
      '.mark.on{border-color:var(--ac);box-shadow:0 0 0 1px var(--ac)}' +
      '.mk-t{font-size:12px;color:var(--fg2);font-variant-numeric:tabular-nums}' +
      '.mk-lv{float:right;font-size:11px;color:#fff;border-radius:8px;padding:1px 8px;background:var(--ac)}' +
      '.mk-lv.loop{background:var(--ink2)}.mk-lv.deep{background:var(--deep)}' +
      '.mk-x{font-size:13.5px;line-height:1.7;margin-top:6px}' +
      '.hint{font-size:12px;color:var(--fg2);margin-top:16px;line-height:1.9}' +
      '#drop{border:2px dashed var(--hair);border-radius:14px;padding:26px;text-align:center;color:var(--fg2);margin:12px 0;cursor:pointer;font-size:14px}' +
      '</style></head><body>' +
      '<h1 class="serif">盲听复习页</h1><div class="cap" id="info"></div>' +
      '<div id="drop" style="display:none">点击选择 或 拖入本节音频（同名 .webm）<br><span style="font-size:11px">本节较长未内嵌音频</span></div>' +
      '<input id="f" type="file" accept="audio/*" style="display:none">' +
      '<canvas id="wave" width="1400" height="148"></canvas>' +
      '<div class="bar">' +
      '<button class="btn main" id="bp">播放 / 暂停</button>' +
      '<button class="btn" id="b1">① 降速精听（空格）</button>' +
      '<button class="btn" id="bx">回原速（X）</button>' +
      '<button class="btn" id="bprev">上一处</button>' +
      '<button class="btn" id="bnext">下一处</button></div>' +
      '<div class="tier serif" id="tier">点下面的标记句开始精听</div>' +
      '<div id="list"></div>' +
      '<div class="hint">空格=递进降速（0.8x→0.6x→∞循环本句）· X=回原速 · [ ]=上一处/下一处 · 点波形任意处跳转</div>' +
      '<script>var EVS=' + evs + ',INFO=' + info + ',EMB=' + JSON.stringify(emb) + ';' +
      'var au=new Audio(EMB||""),cur=-1,st=0,rates=[0.8,0.6];' +
      'var $=function(i){return document.getElementById(i)};' +
      '$("info").textContent=INFO.title+" · "+INFO.site+" · 全长 "+Math.round(INFO.dur)+"s · 难点 "+EVS.length+" 处";' +
      'if(!EMB){$("drop").style.display="block";$("wave").style.display="none";}' +
      '$("drop").onclick=function(){$("f").click()};' +
      '$("f").onchange=function(e){var f=e.target.files[0];if(f){au.src=URL.createObjectURL(f);$("drop").style.display="none";$("wave").style.display="block";au.onloadedmetadata=init;}};' +
      'if(EMB){au.onloadedmetadata=init;au.play().catch(function(){})}' +
      'var peaks=null,ctx=$("wave").getContext("2d");' +
      'function init(){draw();setInterval(tick,80);au.addEventListener("play",draw);}' +
      'function draw(){var W=1400,H=148;ctx.clearRect(0,0,W,H);' +
      ' if(!peaks||!au.duration)return;' +
      ' var n=peaks.length;for(var i=0;i<n;i++){var h=peaks[i]*(H-26);ctx.fillStyle="#C9BFA8";ctx.fillRect(i*W/n,H-h-12,W/n-0.5,h)}' +
      ' for(var k=0;k<EVS.length;k++){var x=EVS[k].ws/au.duration*W;ctx.fillStyle=(k===cur?"#B5541F":"rgba(181,84,31,.45)");ctx.fillRect(x-1,4,2,H-20)}' +
      ' if(EVS[cur]){var m=EVS[cur];ctx.fillStyle="rgba(181,84,31,.12)";ctx.fillRect(m.ws/au.duration*W,0,(m.we-m.ws)/au.duration*W,H)}' +
      ' ctx.fillStyle="#B5541F";ctx.fillRect(au.currentTime/au.duration*W,0,2,H);}' +
      'function tick(){if(au.duration){if(!peaks&&au.buffered&&au.buffered.length){}draw();' +
      ' if(cur>=0&&st>0){var m=EVS[cur],end=Math.min(m.we,au.duration-0.05);' +
      '   if(au.currentTime>=end){if(st>rates.length){au.currentTime=m.ws}else{st=0;au.playbackRate=1;$("tier").textContent="本句听完 · 已回原速继续"}}}}}' +
      'au.addEventListener("timeupdate",draw);' +
      'if(EMB){fetch(EMB).then(function(r){return r.arrayBuffer()}).then(function(b){return new AudioContext().decodeAudioData(b)}).then(function(buf){' +
      ' var d=buf.getChannelData(0),N=560,p=new Array(N),step=Math.floor(d.length/N);' +
      ' for(var i=0;i<N;i++){var mx=0;for(var j=0;j<step;j+=37){var v=Math.abs(d[i*step+j]);if(v>mx)mx=v}p[i]=mx}peaks=p;draw();}).catch(function(){})}' +
      'function mkRow(m,i){var d=document.createElement("div");d.className="mark";' +
      ' var cls=m.level==="loop"?"loop":((m.level===2||m.level===3)?"deep":"");' +
      ' d.innerHTML="<span class=mk-t>\\u25B6 "+m.ws+"s \\u00B7 \\u539F\\u89C6\\u9891 "+m.mediaT+"s</span>"+' +
      ' "<span class=\\"mk-lv "+cls+"\\">"+badge(m.level)+"</span>"+(m.text?"<div class=mk-x>"+m.text+"</div>":"");' +
      ' d.onclick=function(){pick(i)};return d}' +
      'function badge(l){return l==="loop"? "\\u221E" : l==="replay" ? "\\u518D" : (l===1?"\\u2460":"\\u2461")}' +
      'var list=$("list");EVS.forEach(function(m,i){list.appendChild(mkRow(m,i))});' +
      'function pick(i){cur=i;st=0;au.playbackRate=1;au.currentTime=EVS[i].ws;au.play();' +
      ' var ms=document.querySelectorAll(".mark");for(var k=0;k<ms.length;k++)ms[k].classList.toggle("on",k===i);' +
      ' $("tier").textContent="\\u6807\\u8BB0 "+(i+1)+"/"+EVS.length+" \\u00B7 \\u7A7A\\u683C=\\u964D\\u901F\\u7CBE\\u542C";draw();}' +
      'function step2(d){if(!EVS.length)return;var i=(cur<0?0:cur+d);i=Math.max(0,Math.min(EVS.length-1,i));pick(i)}' +
      'function trig(){if(cur<0){step2(0);return}var m=EVS[cur];' +
      ' if(st<rates.length){st++;au.playbackRate=rates[st-1];au.currentTime=m.ws;au.play();' +
      '  $("tier").textContent=(st===1?"\\u2460 ":"\\u2461 ")+rates[st-1]+"x \\u7CBE\\u542C\\u6807\\u8BB0 "+(cur+1)+"\\uFF08\\u542C\\u5B8C\\u81EA\\u52A8\\u56DE\\u539F\\u901F\\uFF09"}' +
      ' else{st=rates.length+1;au.playbackRate=rates[rates.length-1];au.currentTime=m.ws;au.play();' +
      '  $("tier").textContent="\\u221E \\u5FAA\\u73AF\\u6807\\u8BB0 "+(cur+1)+" \\u00B7 X \\u9000\\u51FA"}}' +
      'function exit(){st=0;au.playbackRate=1;$("tier").textContent="\\u5DF2\\u56DE\\u539F\\u901F \\u00B7 \\u70B9\\u4E0B\\u4E00\\u4E2A\\u6807\\u8BB0"}' +
      '$("bp").onclick=function(){au.paused?au.play():au.pause()};' +
      '$("b1").onclick=trig;$("bx").onclick=exit;$("bprev").onclick=function(){step2(-1)};$("bnext").onclick=function(){step2(1)};' +
      '$("wave").onclick=function(e){if(!au.duration)return;var r=e.target.getBoundingClientRect();' +
      ' au.currentTime=(e.clientX-r.left)/r.width*au.duration;draw();};' +
      'document.addEventListener("keydown",function(e){if(e.code==="Space"){e.preventDefault();trig()}' +
      ' else if(e.key==="x"||e.key==="X"){exit()}else if(e.key==="["){step2(-1)}else if(e.key==="]"){step2(1)}});' +
      '<\/script></body></html>';
  }
  // S 触发递进 · L 循环 · X 结束回原速 · [ ] 上下句 · , . 微调3秒 · P 面板
  function toggleLoop() {
    const v = findVideo();
    if (!v) return;
    if (loopMode) { trigger(); return; }                 // 循环中再按 = 退出
    if (state === 0) {                                   // 连续播放中直接进循环：先选句
      const now = v.currentTime;
      const seg = cfg.mode === 'fixed'
        ? { start: Math.max(0, now - Number(cfg.fixedSec)), end: now }
        : targetSeg(now);
      sentenceStart = seg.start; sentenceEnd = seg.end;
      videoTriggers += 1; bumpStats();
    }
    state = cfg.speeds.length;
    loopMode = true;
    v.currentTime = sentenceStart;
    replayStartedAt = performance.now();
    setRate(rateFor(cfg.speeds.length));
    setMainIcon();
    say('∞ 循环本句 · 再按一下结束', 1600);
  }
  function stepSentence(dir) {
    const v = findVideo();
    if (!v) return;
    if (SUBS) {
      const t = v.currentTime;
      let idx = -1;
      for (let k = 0; k < SUBS.length; k++) if (t >= SUBS[k].start && t < SUBS[k].end) idx = k;
      if (idx === -1) idx = dir > 0 ? SUBS.length - 1 : 0;
      const n = Math.min(SUBS.length - 1, Math.max(0, idx + dir));
      v.currentTime = SUBS[n].start + 0.01;
      say('第 ' + (n + 1) + '/' + SUBS.length + ' 句', 900);
      return;
    }
    v.currentTime = Math.max(0, v.currentTime + dir * MAX_SENTENCE);
    say(dir > 0 ? '前进 8s' : '回退 8s', 800);
  }
  document.addEventListener('keydown', e => {
    const k = (e.key || '').toLowerCase();
    if (!'slx[],.pg'.includes(k) || k.length !== 1) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const v = findVideo();
    switch (k) {
      case 's': e.preventDefault(); trigger(); break;
      case 'l': e.preventDefault(); toggleLoop(); break;
      case 'x': e.preventDefault();
        if (loopMode || state > 0) backToNormal(); else say('已在原速播放', 800);
        break;
      case '[': e.preventDefault(); stepSentence(-1); break;
      case ']': e.preventDefault(); stepSentence(1); break;
      case ',': if (v) { e.preventDefault(); v.currentTime = Math.max(0, v.currentTime - 3); say('−3s', 700); } break;
      case '.': if (v) { e.preventDefault(); v.currentTime += 3; say('+3s', 700); } break;
      case 'p': e.preventDefault(); togglePanel(); break;
      case 'g': e.preventDefault(); toggleRecord(); break;
    }
  }, true);

  // ---------- 启动 & B站 SPA 换页重绑 ----------
  function boot() {
    buildUI();
    const v = findVideo();
    if (v && v !== hookedVideo) {
      hookedVideo = v;
      hookAudio(v);
    }
  }
  boot();
  setInterval(boot, 2000);

  // 窗口尺寸变化时把按钮拉回可视区
  window.addEventListener('resize', () => {
    if (!box) return;
    const r = box.getBoundingClientRect();
    if (r.left < 0 || r.top < 0 || r.left > window.innerWidth - 20 || r.top > window.innerHeight - 20) {
      box.style.right = 'auto'; box.style.bottom = 'auto';
      clampTo(window.innerWidth - 44 - 18, window.innerHeight - 44 - 24);
    }
  });

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      state = 0;
      loopMode = false;
      videoTriggers = 0;
      inSpeech = false; lastLoud = 0; prevSeg = null;
      setMainIcon();
    }
  }, 1000);
})();

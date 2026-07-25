// 主题引擎：把主题配置编译成页面内执行的注入载荷
// 核心思路（与 Codex-Dream-Skin 一致）：原生控件不动，只在底层铺壁纸 + 让面板半透明
// 机制：
//   1) 壁纸层 + 亮度自适应遮罩层（保证文字可读）
//   2) 内联重定义 ZCode 的 Tailwind CSS 变量（--color-card / --color-background 等）
//      —— 变量级透明化，工具类、组件样式、Shadow DOM 全部级联跟随
//   3) 向代码块 Shadow DOM（diffs-container）注入透明化样式，让卡片底色透出
// 自愈：MutationObserver 监听 ZCode 深/浅主题切换与新出现的代码块，自动重建/补注。

const WALL_ID = 'zds-wall';
const SCRIM_ID = 'zds-scrim';
const STYLE_ID = 'zds-style';
const SHADOW_STYLE_ID = 'zds-shadow-style';

const DEFAULT_THEME = {
  name: 'dream-void',
  panelOpacity: 62,    // 窗口/侧栏面板不透明度 0-100（越高越实）
  cardOpacity: null,   // 卡片/代码块不透明度；null = 由 panelOpacity 推导（-8，区间 25-90）
  scrim: 'auto',       // 'auto' | 0-100，壁纸遮罩强度
  focus: 'center',     // background-position
  blur: 0,             // 壁纸高斯模糊 px
};

function buildInjectPayload(theme, imgUri) {
  const t = { ...DEFAULT_THEME, ...theme };
  delete t.image;
  const themeJSON = JSON.stringify(t);
  const imgJSON = JSON.stringify(imgUri);

  return `(async () => {
  const WALL='${WALL_ID}', SCRIM='${SCRIM_ID}', STYLE='${STYLE_ID}', SHADOW='${SHADOW_STYLE_ID}';
  const theme = ${themeJSON};
  const imgUri = ${imgJSON};
  const $ = (id) => document.getElementById(id);
  // 需要透明化的 Tailwind 变量 → 不透明度映射（相对 op/cop 计算）
  const VAR_KEYS = ['--color-background-win-alt','--color-background','--color-sidebar','--color-card','--color-input','--color-popover','--color-secondary'];

  // ---- 工具函数 ----
  const parseColor = (c) => {
    c = (c || '').trim();
    let m = /^#([0-9a-f]{3,8})$/i.exec(c);
    if (m) {
      let h = m[1];
      if (h.length === 3 || h.length === 4) h = h.split('').map(x => x + x).join('');
      const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
      const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
      return [r, g, b, a];
    }
    m = /^rgba?\\(([^)]+)\\)/.exec(c);
    if (m) { const p = m[1].split(',').map(s => parseFloat(s)); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
    return null;
  };
  const rgba = (p, a) => 'rgba(' + p[0] + ',' + p[1] + ',' + p[2] + ',' + Math.max(0, Math.min(1, a)).toFixed(3) + ')';
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  async function luminance() {
    try {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = imgUri; });
      const n = 8, cv = document.createElement('canvas'); cv.width = n; cv.height = n;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, n, n);
      const d = ctx.getImageData(0, 0, n, n).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      return sum / (d.length / 4) / 255;
    } catch { return null; }
  }
  const L = await luminance();

  // ---- Shadow DOM 透明化（代码块等） ----
  function pierceShadows() {
    document.querySelectorAll('diffs-container').forEach((host) => {
      const sr = host.shadowRoot;
      if (!sr || sr.getElementById(SHADOW)) return;
      const s = document.createElement('style');
      s.id = SHADOW;
      s.textContent = 'pre, code, .cm-editor, .cm-content, .cm-gutters { background: transparent !important; }';
      sr.appendChild(s);
    });
  }

  let busy = false;
  function build() {
    if (busy) return; busy = true;
    try {
      // 1) 清理旧实例（含内联变量，确保采样到官方原色）
      $(WALL)?.remove(); $(SCRIM)?.remove(); $(STYLE)?.remove();
      const htmlStyle = document.documentElement.style;
      VAR_KEYS.forEach((v) => htmlStyle.removeProperty(v));
      void document.documentElement.offsetHeight; // 强制 reflow

      // 2) 采样官方变量原色
      const cs = getComputedStyle(document.documentElement);
      const base = {};
      VAR_KEYS.forEach((v) => { base[v] = cs.getPropertyValue(v).trim(); });

      const isDark = document.documentElement.classList.contains('dark');
      const op = clamp(Number(theme.panelOpacity), 0, 100) / 100;
      const cop = theme.cardOpacity == null
        ? clamp(op - 0.08, 0.25, 0.90)
        : clamp(Number(theme.cardOpacity), 0, 100) / 100;

      // 3) 内联重定义变量（inline style 优先级最高；CSS 变量可穿透 Shadow DOM 继承）
      const alphaMap = {
        '--color-background-win-alt': op,
        '--color-background': clamp(op - 0.06, 0.25, 1),
        '--color-sidebar': clamp(op - 0.06, 0.25, 1),
        '--color-card': cop,
        '--color-input': clamp(op + 0.06, 0, 1),
        '--color-popover': clamp(cop + 0.25, 0, 1),
        '--color-secondary': clamp(op - 0.10, 0.30, 1),
      };
      for (const v of VAR_KEYS) {
        const p = parseColor(base[v]);
        if (p) htmlStyle.setProperty(v, rgba(p, alphaMap[v] ?? op));
      }

      // 4) 壁纸层
      const wall = document.createElement('div');
      wall.id = WALL;
      wall.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:-2', 'pointer-events:none',
        'background:url(' + imgUri + ') ' + (theme.focus || 'center') + '/cover no-repeat',
        Number(theme.blur) > 0 ? 'filter:blur(' + Number(theme.blur) + 'px)' : '',
        Number(theme.blur) > 0 ? 'transform:scale(1.05)' : '',
      ].filter(Boolean).join(';');
      document.documentElement.prepend(wall);

      // 5) 遮罩层
      let scrimAlpha, scrimColor;
      if (theme.scrim === 'auto') {
        scrimAlpha = isDark
          ? clamp(0.34 + (L == null ? 0.35 : L) * 0.5, 0.30, 0.78)
          : clamp(0.30 + (L == null ? 0.65 : 1 - L) * 0.45, 0.25, 0.72);
        scrimColor = isDark ? '10,10,14' : '250,250,252';
      } else {
        scrimAlpha = clamp(Number(theme.scrim), 0, 100) / 100;
        scrimColor = isDark ? '10,10,14' : '250,250,252';
      }
      const scrim = document.createElement('div');
      scrim.id = SCRIM;
      scrim.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:-1', 'pointer-events:none',
        'background:linear-gradient(180deg, rgba(' + scrimColor + ',' + (scrimAlpha * 0.72).toFixed(3) + ') 0%, rgba(' + scrimColor + ',' + scrimAlpha.toFixed(3) + ') 60%, rgba(' + scrimColor + ',' + Math.min(1, scrimAlpha * 1.12).toFixed(3) + ') 100%)',
      ].join(';');
      document.documentElement.prepend(scrim);

      // 6) 残余兜底样式（根容器透明）
      const st = document.createElement('style');
      st.id = STYLE;
      st.textContent = 'html,body,#root{background:transparent!important}';
      document.head.append(st);

      // 7) Shadow DOM 透明化
      pierceShadows();

      window.__zdsApplied = { ver: theme.name, at: Date.now(), dark: isDark, lum: L, scrimAlpha, op, cop };
    } finally { busy = false; }
  }

  // ---- 清理旧观察者 ----
  if (window.__zdsObserver) { try { window.__zdsObserver.disconnect(); } catch {} }
  if (window.__zdsDomObserver) { try { window.__zdsDomObserver.disconnect(); } catch {} }

  // 主题（深/浅）切换 → 重建
  let themeTimer = null;
  window.__zdsObserver = new MutationObserver(() => {
    const dark = document.documentElement.classList.contains('dark');
    if (window.__zdsApplied && dark !== window.__zdsApplied.dark) {
      clearTimeout(themeTimer); themeTimer = setTimeout(build, 150);
    }
  });
  window.__zdsObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

  // 新出现的代码块（diffs-container）→ 补注 shadow 样式
  let domTimer = null;
  window.__zdsDomObserver = new MutationObserver((muts) => {
    for (const mu of muts) {
      for (const node of mu.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'DIFFS-CONTAINER' || (node.querySelector && node.querySelector('diffs-container'))) {
          clearTimeout(domTimer); domTimer = setTimeout(pierceShadows, 200);
          return;
        }
      }
    }
  });
  if (document.body) window.__zdsDomObserver.observe(document.body, { childList: true, subtree: true });

  window.__zdsRebuild = build;
  build();
  const s = window.__zdsApplied;
  return 'applied:' + theme.name + ' dark=' + s.dark + ' lum=' + (L == null ? 'n/a' : L.toFixed(2)) + ' scrim=' + s.scrimAlpha.toFixed(2) + ' op=' + s.op.toFixed(2) + ' cop=' + s.cop.toFixed(2);
})()`;
}

// 移除皮肤，恢复官方外观
function buildRemovePayload() {
  return `(() => {
    if (window.__zdsObserver) { try { window.__zdsObserver.disconnect(); } catch {} window.__zdsObserver = null; }
    if (window.__zdsDomObserver) { try { window.__zdsDomObserver.disconnect(); } catch {} window.__zdsDomObserver = null; }
    ['${WALL_ID}','${SCRIM_ID}','${STYLE_ID}'].forEach(id => document.getElementById(id)?.remove());
    ['--color-background-win-alt','--color-background','--color-sidebar','--color-card','--color-input','--color-popover','--color-secondary']
      .forEach(v => document.documentElement.style.removeProperty(v));
    document.querySelectorAll('diffs-container').forEach(h => h.shadowRoot && h.shadowRoot.getElementById('${SHADOW_STYLE_ID}')?.remove());
    delete window.__zdsApplied;
    delete window.__zdsRebuild;
    return 'removed';
  })()`;
}

// 查询当前皮肤状态
function buildStatusPayload() {
  return `(() => window.__zdsApplied || null)()`;
}

module.exports = { DEFAULT_THEME, buildInjectPayload, buildRemovePayload, buildStatusPayload, WALL_ID, SCRIM_ID, STYLE_ID };

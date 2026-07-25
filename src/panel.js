// Web 控制面板：127.0.0.1 回环 HTTP 服务，提供主题管理 GUI
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadState, saveState } = require('./paths');
const { listThemes, getTheme, saveTheme, deleteTheme, importImage, resolveActiveTheme } = require('./theme');
const { applyActiveTheme, removeSkin } = require('./injector');

const PANEL_PORT_START = 9470;

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZCode Dream Skin</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; background: #101014; color: #e8e8ec; min-height: 100vh; padding: 28px 20px 60px; }
  .wrap { max-width: 920px; margin: 0 auto; }
  h1 { font-size: 20px; font-weight: 600; letter-spacing: .5px; display: flex; align-items: center; gap: 10px; }
  h1 .dot { width: 10px; height: 10px; border-radius: 50%; background: #7c6cf0; box-shadow: 0 0 12px #7c6cf0; }
  .sub { color: #8b8b96; font-size: 13px; margin: 6px 0 24px; }
  .card { background: #18181f; border: 1px solid #26262f; border-radius: 14px; padding: 18px; margin-bottom: 18px; }
  .card h2 { font-size: 14px; color: #b9b9c4; margin-bottom: 14px; font-weight: 600; }
  .themes { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; }
  .theme { border: 2px solid #26262f; border-radius: 10px; overflow: hidden; cursor: pointer; transition: border-color .15s, transform .15s; background: #101014; }
  .theme:hover { transform: translateY(-2px); }
  .theme.active { border-color: #7c6cf0; }
  .theme img { width: 100%; aspect-ratio: 16/10; object-fit: cover; display: block; }
  .theme .name { padding: 8px 10px; font-size: 12.5px; display: flex; justify-content: space-between; align-items: center; }
  .theme .del { color: #666; cursor: pointer; padding: 0 4px; } .theme .del:hover { color: #e05c5c; }
  .row { display: flex; align-items: center; gap: 14px; margin: 12px 0; }
  .row label { width: 110px; font-size: 13px; color: #b9b9c4; flex-shrink: 0; }
  input[type=range] { flex: 1; accent-color: #7c6cf0; }
  .val { width: 46px; text-align: right; font-variant-numeric: tabular-nums; font-size: 13px; color: #e8e8ec; }
  .btns { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 4px; }
  button { background: #7c6cf0; color: #fff; border: 0; border-radius: 9px; padding: 9px 18px; font-size: 13px; cursor: pointer; font-family: inherit; }
  button:hover { background: #8d7df5; }
  button.ghost { background: #26262f; } button.ghost:hover { background: #30303b; }
  button.danger { background: #4a2626; color: #e8a0a0; } button.danger:hover { background: #5a2e2e; }
  #status { font-size: 12.5px; color: #8b8b96; margin-top: 14px; white-space: pre-wrap; }
  .filebtn { position: relative; overflow: hidden; }
  .filebtn input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
  .hint { font-size: 12px; color: #666; margin-top: 8px; }
</style>
</head>
<body>
<div class="wrap">
  <h1><span class="dot"></span>ZCode Dream Skin</h1>
  <p class="sub">本机回环 CDP 注入 · 不修改官方安装包 · 换肤与模型配置互不影响</p>

  <div class="card">
    <h2>已保存主题</h2>
    <div class="themes" id="themes"></div>
    <div class="btns" style="margin-top:14px">
      <button class="filebtn ghost">导入背景图…<input type="file" id="file" accept="image/png,image/jpeg,image/webp"></button>
      <button class="ghost" onclick="saveTheme()">保存当前为主题</button>
    </div>
    <p class="hint">请导入纯背景图（不要含窗口/侧栏/文字按钮的截图），≤16MB。</p>
  </div>

  <div class="card">
    <h2>外观调节</h2>
    <div class="row"><label>面板不透明度</label><input type="range" id="opacity" min="10" max="100" step="1"><span class="val" id="opacityVal"></span></div>
    <div class="row"><label>卡片/代码块</label><input type="range" id="cards" min="10" max="100" step="1"><span class="val" id="cardsVal"></span></div>
    <div class="row"><label>遮罩强度</label><input type="range" id="scrim" min="0" max="100" step="1"><span class="val" id="scrimVal"></span></div>
    <div class="row"><label>壁纸模糊</label><input type="range" id="blur" min="0" max="40" step="1"><span class="val" id="blurVal"></span></div>
  </div>

  <div class="card">
    <h2>操作</h2>
    <div class="btns">
      <button onclick="act('apply')">重新应用</button>
      <button class="ghost" id="pauseBtn" onclick="act('toggle-pause')">暂停皮肤</button>
      <button class="ghost" onclick="act('shot')">截图预览</button>
      <button class="danger" onclick="if(confirm('恢复官方外观并结束换肤会话？'))act('restore')">还原官方外观</button>
    </div>
    <div id="status">加载中…</div>
  </div>
</div>
<script>
let state = {};
async function api(p, opt) { const r = await fetch('/api/' + p, opt); return r.json(); }
async function refresh() {
  state = await api('state');
  document.getElementById('opacity').value = state.panelOpacity;
  document.getElementById('cards').value = state.cardOpacity;
  document.getElementById('scrim').value = state.scrim;
  document.getElementById('blur').value = state.blur;
  document.getElementById('opacityVal').textContent = state.panelOpacity;
  document.getElementById('cardsVal').textContent = state.cardOpacity;
  document.getElementById('scrimVal').textContent = state.scrim;
  document.getElementById('blurVal').textContent = state.blur + 'px';
  document.getElementById('pauseBtn').textContent = state.paused ? '恢复皮肤' : '暂停皮肤';
  const box = document.getElementById('themes');
  box.replaceChildren();
  for (const t of state.themes) {
    const d = document.createElement('div');
    d.className = 'theme' + (t.name === state.activeTheme ? ' active' : '');
    const img = document.createElement('img');
    img.src = '/img?name=' + encodeURIComponent(t.name);
    img.loading = 'lazy';
    img.alt = t.name;
    const nameBar = document.createElement('div');
    nameBar.className = 'name';
    const label = document.createElement('span');
    label.textContent = t.name; // textContent 防注入
    nameBar.appendChild(label);
    if (!t.builtin) {
      const del = document.createElement('span');
      del.className = 'del'; del.title = '删除'; del.textContent = '×';
      nameBar.appendChild(del);
    }
    d.appendChild(img); d.appendChild(nameBar);
    d.onclick = (e) => { if (e.target.classList.contains('del')) { if (confirm('删除主题 ' + t.name + '？')) api('delete?name=' + encodeURIComponent(t.name)).then(refresh); } else api('use?name=' + encodeURIComponent(t.name)).then(refresh); };
    box.appendChild(d);
  }
  document.getElementById('status').textContent = state.statusText;
}
for (const k of ['opacity', 'cards', 'scrim', 'blur']) {
  document.getElementById(k).addEventListener('change', (e) => api('set?key=' + k + '&value=' + e.target.value).then(refresh));
  document.getElementById(k).addEventListener('input', (e) => { document.getElementById(k + 'Val').textContent = e.target.value + (k === 'blur' ? 'px' : ''); });
}
async function act(a) {
  const r = await api(a);
  if (a === 'shot' && r.ok) window.open('/shot', '_blank');
  if (a === 'restore') { document.getElementById('status').textContent = r.message; return; }
  refresh();
}
function saveTheme() {
  const name = prompt('主题名称：');
  if (name) api('save?name=' + encodeURIComponent(name)).then(refresh);
}
document.getElementById('file').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const fd = new FormData(); fd.append('file', f);
  const r = await fetch('/api/import', { method: 'POST', body: fd });
  const j = await r.json();
  if (!j.ok) alert(j.message);
  e.target.value = '';
  refresh();
});
refresh();
</script>
</body>
</html>`;

function json(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function readBody(req, limit = 20 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function startPanel({ resolveSessionPort }) {
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      const p = u.pathname;

      if (p === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(HTML);
      }

      if (p === '/api/state') {
        const st = loadState();
        const theme = resolveActiveTheme();
        const port = await resolveSessionPort();
        return json(res, {
          activeTheme: st.activeTheme || 'dream-void',
          paused: !!st.paused,
          panelOpacity: theme.panelOpacity,
          cardOpacity: theme.cardOpacity == null ? Math.max(25, theme.panelOpacity - 8) : theme.cardOpacity,
          scrim: theme.scrim === 'auto' ? 50 : theme.scrim,
          blur: theme.blur || 0,
          themes: listThemes().map((t) => ({ name: t.name, builtin: !!t.builtin })),
          statusText: `会话端口: ${port || '无（ZCode 未以换肤模式运行）'} · 当前主题: ${theme.name}`,
        });
      }

      if (p === '/api/use') {
        const name = u.searchParams.get('name');
        if (!getTheme(name)) return json(res, { ok: false, message: '主题不存在' }, 404);
        saveState({ ...loadState(), activeTheme: name, paused: false, panelOpacity: undefined, cardOpacity: undefined, scrim: undefined, blur: undefined });
        const port = await resolveSessionPort();
        if (port) await applyActiveTheme(port);
        return json(res, { ok: true });
      }

      if (p === '/api/set') {
        const key = u.searchParams.get('key');
        const value = Number(u.searchParams.get('value'));
        const st = loadState();
        if (key === 'opacity') st.panelOpacity = Math.max(10, Math.min(100, value));
        if (key === 'cards') st.cardOpacity = Math.max(10, Math.min(100, value));
        if (key === 'scrim') st.scrim = Math.max(0, Math.min(100, value));
        if (key === 'blur') st.blur = Math.max(0, Math.min(40, value));
        st.paused = false;
        saveState(st);
        const port = await resolveSessionPort();
        if (port) await applyActiveTheme(port);
        return json(res, { ok: true });
      }

      if (p === '/api/save') {
        const name = u.searchParams.get('name');
        if (!name) return json(res, { ok: false, message: '缺少名称' }, 400);
        saveTheme(name, resolveActiveTheme());
        saveState({ ...loadState(), activeTheme: name });
        return json(res, { ok: true });
      }

      if (p === '/api/delete') {
        const name = u.searchParams.get('name');
        return json(res, { ok: deleteTheme(name) });
      }

      if (p === '/api/apply') {
        const port = await resolveSessionPort();
        if (!port) return json(res, { ok: false, message: '无换肤会话' }, 409);
        await applyActiveTheme(port);
        return json(res, { ok: true });
      }

      if (p === '/api/toggle-pause') {
        const st = loadState();
        const paused = !st.paused;
        saveState({ ...st, paused });
        const port = await resolveSessionPort();
        if (port) { if (paused) await removeSkin(port); else await applyActiveTheme(port); }
        return json(res, { ok: true });
      }

      if (p === '/api/restore') {
        const st = loadState();
        const port = await resolveSessionPort();
        if (port) { try { await removeSkin(port); } catch { /* ignore */ } }
        if (st.daemonPid) { try { process.kill(st.daemonPid); } catch { /* ignore */ } }
        saveState({ skinActive: false });
        return json(res, { ok: true, message: '已恢复官方外观（守护进程已停止）。ZCode 重启后调试端口将关闭。' });
      }

      if (p === '/api/shot') {
        const port = await resolveSessionPort();
        if (!port) return json(res, { ok: false, message: '无换肤会话' }, 409);
        const { connectRenderer } = require('./cdp');
        const session = await connectRenderer(port);
        try {
          await session.send('Page.enable');
          const r = await session.send('Page.captureScreenshot', { format: 'png' });
          panelCache.shot = Buffer.from(r.data, 'base64');
        } finally { session.close(); }
        return json(res, { ok: true });
      }

      if (p === '/shot' && panelCache.shot) {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        return res.end(panelCache.shot);
      }

      if (p === '/img') {
        const name = u.searchParams.get('name');
        const t = getTheme(name);
        if (!t || !t.image || !fs.existsSync(t.image)) { res.writeHead(404); return res.end(); }
        const ext = path.extname(t.image).toLowerCase();
        const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'max-age=60' });
        return res.end(fs.readFileSync(t.image));
      }

      if (p === '/api/import' && req.method === 'POST') {
        const body = await readBody(req);
        // 极简 multipart 解析（单文件）
        const boundary = (req.headers['content-type'] || '').split('boundary=')[1];
        if (!boundary) return json(res, { ok: false, message: '非法请求' }, 400);
        const bBuf = Buffer.from('--' + boundary);
        const start = body.indexOf(bBuf);
        const headerEnd = body.indexOf('\r\n\r\n', start);
        const head = body.toString('latin1', start, headerEnd);
        const fnMatch = /filename="([^"]+)"/.exec(head);
        let end = body.indexOf(bBuf, headerEnd);
        if (end < 0) end = body.length;
        let data = body.subarray(headerEnd + 4, end - 2);
        const fname = fnMatch ? fnMatch[1] : 'upload.png';
        const ext = path.extname(fname).toLowerCase() || '.png';
        const tmp = path.join(require('os').tmpdir(), `zds-upload-${Date.now()}${ext}`);
        fs.writeFileSync(tmp, data);
        try {
          const archived = importImage(tmp);
          const st = loadState();
          const cur = resolveActiveTheme();
          const name = getTheme(st.activeTheme || 'dream-void')?.builtin ? 'custom' : (st.activeTheme || 'custom');
          saveTheme(name, { ...cur, image: archived });
          saveState({ ...st, activeTheme: name, paused: false });
          const port = await resolveSessionPort();
          if (port) await applyActiveTheme(port);
          return json(res, { ok: true });
        } finally {
          fs.rmSync(tmp, { force: true });
        }
      }

      res.writeHead(404);
      res.end('not found');
    } catch (e) {
      json(res, { ok: false, message: e.message }, 500);
    }
  });

  const panelCache = { shot: null };

  // 找空闲端口
  for (let port = PANEL_PORT_START; port < PANEL_PORT_START + 20; port++) {
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      return `http://127.0.0.1:${port}`;
    } catch { /* 占用则试下一个 */ }
  }
  throw new Error('控制面板端口不可用');
}

module.exports = { startPanel };

if (require.main === module) {
  const { resolveSessionPort } = require('./session');
  startPanel({ resolveSessionPort }).then((url) => console.log('panel:', url));
}

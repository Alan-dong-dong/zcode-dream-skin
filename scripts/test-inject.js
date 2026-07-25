// 注入原型验证：注入壁纸层 + 半透明化关键容器，并截图
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2] || 9335);
const IMAGE = process.argv[3] || String.raw`C:\Users\S\.qoder\vibe_images\zcode-default-wallpaper_1784882250.png`;
const SHOT = process.argv[4] || path.join(__dirname, 'shot-injected.png');

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && t.url.includes('renderer/index.html'));
  if (!page) throw new Error('未找到渲染页');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const mid = ++id; pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evaljs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800));
    return r.result?.result?.value;
  };

  await send('Page.enable');

  const imgB64 = fs.readFileSync(IMAGE).toString('base64');
  const payload = `(() => {
    const W = 'zds-wallpaper', S = 'zds-style';
    document.getElementById(W)?.remove();
    document.getElementById(S)?.remove();
    const wall = document.createElement('div');
    wall.id = W;
    wall.style.cssText = 'position:fixed;inset:0;z-index:-1;pointer-events:none;background:url(data:image/png;base64,${imgB64}) center/cover no-repeat;';
    document.documentElement.prepend(wall);
    const st = document.createElement('style');
    st.id = S;
    st.textContent = [
      'html,body,#root,#root>.relative,#root .h-dvh.h-full{background:transparent!important}',
      '.bg-background-win-alt{background-color:rgba(43,43,43,0.60)!important}',
      '.bg-background{background-color:rgba(22,22,22,0.55)!important}',
      '.bg-input,.bg-input-focused{background-color:rgba(43,43,43,0.65)!important}',
      '.bg-surface{background-color:rgba(255,255,255,0.04)!important}',
    ].join('\\n');
    document.head.append(st);
    return 'injected';
  })()`;
  console.log(await evaljs(payload));

  await new Promise((r) => setTimeout(r, 1200));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));
  console.log('screenshot ->', SHOT);
  ws.close();
  process.exit(0);
}
main().catch((e) => { console.error(e.message); process.exit(1); });

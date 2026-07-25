// 临时探针：连接 ZCode CDP，dump 渲染页 DOM 骨架，为注入 CSS 选择器提供依据
// 用法: node scripts/probe.js [port]
const PORT = Number(process.argv[2] || 9335);

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && t.url.includes('renderer/index.html'));
  if (!page) throw new Error('未找到 ZCode 渲染页 target');
  console.log('page:', page.title, page.url.slice(0, 80));

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
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');

  const domInfo = await evaljs(`(() => {
    const out = { rootChildren: [], candidates: [] };
    const roots = [document.documentElement, document.body, ...document.body.children];
    const seen = new Set();
    for (const el of roots) {
      if (!el || seen.has(el)) continue; seen.add(el);
      const cs = getComputedStyle(el);
      out.rootChildren.push({
        tag: el.tagName.toLowerCase(), id: el.id || null,
        cls: (el.className && typeof el.className === 'string') ? el.className.slice(0, 120) : null,
        bg: cs.backgroundColor, w: el.clientWidth, h: el.clientHeight,
      });
    }
    // 找全屏大小的容器（它们决定背景遮挡关系）
    const vw = innerWidth, vh = innerHeight;
    const all = document.querySelectorAll('body *');
    let count = 0;
    for (const el of all) {
      if (count++ > 4000) break;
      const r = el.getBoundingClientRect();
      if (r.width >= vw * 0.95 && r.height >= vh * 0.9) {
        const cs = getComputedStyle(el);
        out.candidates.push({
          tag: el.tagName.toLowerCase(), id: el.id || null,
          cls: (typeof el.className === 'string' ? el.className : '').slice(0, 140),
          bg: cs.backgroundColor, z: cs.zIndex, pos: cs.position,
          w: Math.round(r.width), h: Math.round(r.height),
        });
      }
    }
    out.bodyBg = getComputedStyle(document.body).backgroundColor;
    out.htmlBg = getComputedStyle(document.documentElement).backgroundColor;
    return out;
  })()`);

  console.log(JSON.stringify(domInfo, null, 2));
  ws.close();
  process.exit(0);
}

main().catch((e) => { console.error(e.message); process.exit(1); });

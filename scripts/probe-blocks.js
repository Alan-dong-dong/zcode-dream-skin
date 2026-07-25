// 探针3：找出会话视图里所有「不透明色块」容器（代码块/卡片/消息气泡），按类名聚合
const PORT = Number(process.argv[2] || 9335);

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
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
    return r.result?.result?.value;
  };

  const info = await evaljs(`(() => {
    const groups = new Map();
    const els = document.querySelectorAll('body *');
    const vw = innerWidth, vh = innerHeight;
    let n = 0;
    for (const el of els) {
      if (n++ > 8000) break;
      const r = el.getBoundingClientRect();
      if (r.width < 120 || r.height < 28) continue;
      if (r.width * r.height < vw * vh * 0.003) continue; // 忽略小块
      const bg = getComputedStyle(el).backgroundColor;
      const m = /rgba?\\(([^)]+)\\)/.exec(bg);
      if (!m) continue;
      const parts = m[1].split(',').map(s => parseFloat(s));
      const alpha = parts.length === 4 ? parts[3] : 1;
      if (alpha < 0.9) continue; // 只看不透明
      const cls = (typeof el.className === 'string' ? el.className : '').trim();
      const key = el.tagName.toLowerCase() + '|' + cls.slice(0, 90);
      const g = groups.get(key) || { count: 0, bg, sample: null };
      g.count++;
      if (!g.sample) g.sample = { w: Math.round(r.width), h: Math.round(r.height), id: el.id || null };
      groups.set(key, g);
    }
    return [...groups.entries()]
      .map(([k, v]) => ({ key: k, ...v }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 40);
  })()`);
  console.log(JSON.stringify(info, null, 2));
  ws.close();
  process.exit(0);
}
main().catch((e) => { console.error(e.message); process.exit(1); });

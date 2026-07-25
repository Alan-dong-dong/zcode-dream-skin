// 探针5：CSS 变量位置 + diffs-container 是否 shadow DOM
const PORT = Number(process.argv[2] || 9335);

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && t.url.includes('renderer/index.html'));
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
    const out = { vars: {}, adoptedCount: 0, diffs: null, varUsedBy: {} };
    const cs = getComputedStyle(document.documentElement);
    for (const v of ['--color-card','--color-background','--color-background-win-alt','--color-input','--color-surface','--color-popover','--color-sidebar','--background','--card','--color-muted','--color-secondary']) {
      out.vars[v] = cs.getPropertyValue(v).trim() || null;
    }
    out.adoptedCount = document.adoptedStyleSheets ? document.adoptedStyleSheets.length : 0;
    // diffs-container 结构
    const d = document.querySelector('diffs-container');
    if (d) {
      out.diffs = {
        hasShadow: !!d.shadowRoot,
        hostBg: getComputedStyle(d).backgroundColor,
        innerSample: null,
      };
      // 看它第一个不透明后代是谁（shadow 或 light DOM）
      const root = d.shadowRoot || d;
      const kids = root.querySelectorAll('*');
      for (const k of kids) {
        const bg = getComputedStyle(k).backgroundColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && !bg.endsWith(', 0)')) {
          out.diffs.innerSample = { tag: k.tagName.toLowerCase(), cls: (typeof k.className === 'string' ? k.className : '').slice(0, 100), bg, inShadow: !!d.shadowRoot };
          break;
        }
      }
    }
    // bg-card 的实际声明值（是否 var）
    const probe = document.querySelector('.bg-card');
    if (probe) out.varUsedBy.bgCard = getComputedStyle(probe).backgroundColor;
    return out;
  })()`);
  console.log(JSON.stringify(info, null, 2));
  ws.close();
  process.exit(0);
}
main().catch((e) => { console.error(e.message); process.exit(1); });

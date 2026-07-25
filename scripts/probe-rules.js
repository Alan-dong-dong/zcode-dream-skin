// 探针4：找出具体是哪些 CSS 规则给色块容器上色的（为覆盖提供选择器依据）
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
    // 收集目标元素
    const targets = [];
    const card = document.querySelector('div.group.relative.my-4.border.border-border')
      || [...document.querySelectorAll('div.my-4.border')][0];
    if (card) targets.push(['artifact-card', card]);
    const diffs = document.querySelector('diffs-container');
    if (diffs) targets.push(['diffs-container', diffs]);
    const composer = document.querySelector('[class*="chat-composer"]');
    if (composer) targets.push(['composer', composer]);
    const bgCard = document.querySelector('.bg-card');
    if (bgCard) targets.push(['bg-card', bgCard]);

    const result = [];
    for (const [label, el] of targets) {
      const matched = [];
      for (const sheet of document.styleSheets) {
        let rules; try { rules = sheet.cssRules; } catch { continue; }
        const walk = (list, mediaCtx) => {
          for (const rule of list) {
            if (rule.cssRules) { walk(rule.cssRules, rule); continue; }
            if (!rule.style || !rule.selectorText) continue;
            const hasBg = rule.style.backgroundColor || (rule.style.background && rule.style.background !== 'none');
            if (!hasBg) continue;
            let ok = false;
            try { ok = el.matches(rule.selectorText); } catch { /* 非法选择器跳过 */ }
            if (ok) matched.push({
              sel: rule.selectorText.slice(0, 110),
              bg: rule.style.backgroundColor || rule.style.background.slice(0, 60),
              spec: rule.style.getPropertyPriority('background-color') || '',
            });
          }
        };
        walk(rules, null);
      }
      result.push({
        label,
        cls: (typeof el.className === 'string' ? el.className : '').slice(0, 160),
        computed: getComputedStyle(el).backgroundColor,
        matched,
      });
    }
    return result;
  })()`);
  console.log(JSON.stringify(info, null, 2));
  ws.close();
  process.exit(0);
}
main().catch((e) => { console.error(e.message); process.exit(1); });

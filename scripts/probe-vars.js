// 探针2: dump CSS 变量与实际使用的背景类，为主题引擎提供映射依据
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
    const out = { rootVars: {}, darkVars: {}, bgClasses: {}, themeClasses: [] };
    // 1) 收集样式表里定义在 :root / .dark / .theme-* 下的 --* 变量
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch { continue; }
      const walk = (list) => {
        for (const rule of list) {
          if (rule.cssRules) { walk(rule.cssRules); continue; }
          if (!rule.style || !rule.selectorText) continue;
          const sel = rule.selectorText;
          if (!/(:root|\\.dark|theme-|html|body)/.test(sel)) continue;
          const bucket = sel.includes('.dark') ? 'darkVars' : 'rootVars';
          for (let i = 0; i < rule.style.length; i++) {
            const prop = rule.style[i];
            if (prop.startsWith('--')) out[bucket][prop] = rule.style.getPropertyValue(prop).trim().slice(0, 80);
          }
        }
      };
      walk(rules);
    }
    // 2) 统计 DOM 中实际出现的 bg-* 类及 computed 背景色
    const els = document.querySelectorAll('[class]');
    let n = 0;
    for (const el of els) {
      if (n++ > 6000) break;
      const cls = typeof el.className === 'string' ? el.className : '';
      const m = cls.match(/bg-[a-zA-Z0-9_\\-\\/\\[\\]%().]+/g);
      if (!m) continue;
      const bg = getComputedStyle(el).backgroundColor;
      for (const c of m) {
        if (/\\/(\\d+)/.test(c)) continue; // 带透明度的单独看
        out.bgClasses[c] = bg;
      }
    }
    // 3) html 上的主题类
    out.themeClasses = Array.from(document.documentElement.classList);
    return out;
  })()`);
  console.log(JSON.stringify(info, null, 2));
  ws.close();
  process.exit(0);
}
main().catch((e) => { console.error(e.message); process.exit(1); });

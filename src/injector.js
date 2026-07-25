// 注入器：把主题应用到运行中的 ZCode；守护进程模式负责换肤会话保活
// - 页面重载/路由跳转后自动补注
// - state.json 变化（切主题/调透明度/暂停）时自动响应
// - ZCode 退出后自动退出，不留孤儿进程
const fs = require('fs');
const crypto = require('crypto');
const { connectRenderer, findRendererTarget } = require('./cdp');
const { buildInjectPayload, buildRemovePayload, buildStatusPayload } = require('./skin');
const { resolveActiveTheme, themeToDataUri } = require('./theme');
const { FILES, loadState, log, readJSON } = require('./paths');

// 主题指纹：变了才重注，避免无谓刷新
function themeFingerprint(theme, state) {
  return crypto.createHash('sha1').update(JSON.stringify({
    n: theme.name, i: theme.image, o: theme.panelOpacity, c: theme.cardOpacity, s: theme.scrim, b: theme.blur, f: theme.focus,
    p: !!state.paused,
  })).digest('hex');
}

// 连接渲染页并应用当前主题（CLI apply / panel / daemon 共用）
async function applyActiveTheme(port) {
  const state = loadState();
  if (state.paused) return removeSkin(port);
  const theme = resolveActiveTheme();
  const uri = themeToDataUri(theme);
  const session = await connectRenderer(port);
  try {
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    const result = await session.evaluate(buildInjectPayload(theme, uri), { awaitPromise: true });
    return result;
  } finally {
    session.close();
  }
}

async function removeSkin(port) {
  const session = await connectRenderer(port);
  try {
    const result = await session.evaluate(buildRemovePayload());
    return result;
  } finally {
    session.close();
  }
}

async function skinStatus(port) {
  const session = await connectRenderer(port);
  try {
    return await session.evaluate(buildStatusPayload());
  } finally {
    session.close();
  }
}

// ---- 守护进程 ----
async function runDaemon(port) {
  log(`daemon start, port=${port}, pid=${process.pid}`);
  let session = null;
  let lastFingerprint = null;
  let aliveMisses = 0;
  let needApply = true;

  const connect = async () => {
    if (session && !session.closed) return session;
    session = await connectRenderer(port, 4000);
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    session.on('Page.frameNavigated', (p) => {
      if (p.frame && !p.frame.parentId) needApply = true; // 主框架导航 → 补注
    });
    session.on('__close__', () => { session = null; });
    needApply = true;
    log('daemon connected to renderer');
    return session;
  };

  const tick = async () => {
    try {
      // 1) ZCode 是否还活着（渲染页 target 消失 N 次后退出）
      const target = await findRendererTarget(port).catch(() => null);
      if (!target) {
        if (++aliveMisses >= 6) { log('renderer gone, daemon exit'); process.exit(0); }
      } else {
        aliveMisses = 0;
      }

      // 2) 主题/状态变更检测（指纹比对）
      const st = readJSON(FILES.state, {}) || {};
      const theme = resolveActiveTheme();
      const fp = themeFingerprint(theme, st);
      if (fp !== lastFingerprint) needApply = true;

      // 3) 应用 / 移除
      if (needApply || fp !== lastFingerprint) {
        const s = await connect();
        if (st.paused) {
          await s.evaluate(buildRemovePayload());
          log('skin paused (removed)');
        } else {
          const uri = themeToDataUri(theme);
          const r = await s.evaluate(buildInjectPayload(theme, uri), { awaitPromise: true });
          log(`apply ok: ${r}`);
        }
        lastFingerprint = fp;
        needApply = false;
      } else if (session && !session.closed) {
        // 4) 心跳校验：皮肤被意外清掉（如强刷）则补注
        const cur = await session.evaluate(buildStatusPayload()).catch(() => null);
        if (!st.paused && cur === null) { needApply = true; }
      }
    } catch (e) {
      log(`daemon tick error: ${e.message}`);
      try { session?.close(); } catch { /* ignore */ }
      session = null;
      await new Promise((r) => setTimeout(r, 2000));
    }
  };

  // 等渲染页起来
  for (let i = 0; i < 40; i++) {
    const t = await findRendererTarget(port).catch(() => null);
    if (t) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  setInterval(tick, 1500); // 保持事件循环存活，直至 ZCode 退出
  await tick();
}

module.exports = { applyActiveTheme, removeSkin, skinStatus, runDaemon };

// 直接以 daemon 模式运行：node src/injector.js --daemon --port 9335
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--daemon')) {
    const port = Number(args[args.indexOf('--port') + 1] || 9335);
    runDaemon(port).catch((e) => { log(`daemon fatal: ${e.stack || e.message}`); process.exit(1); });
  }
}

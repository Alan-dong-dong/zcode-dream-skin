#!/usr/bin/env node
// ZCode Dream Skin CLI
// 换肤工具主入口：start / apply / use / save / list / set-bg / opacity / scrim / blur / pause / resume / restore / panel / status
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const {
  ensureDirs, FILES, DIRS, loadState, saveState, loadConfig, saveConfig, findZCodeExe,
} = require('../src/paths');
const {
  isZCodeRunning, closeZCode, findFreePort, launchZCode, waitForCDP, killProcessTree, sleep,
} = require('../src/launcher');
const { applyActiveTheme, removeSkin, skinStatus } = require('../src/injector');
const { listThemes, getTheme, saveTheme, deleteTheme, importImage, resolveActiveTheme } = require('../src/theme');
const { resolveSessionPort, spawnDaemon } = require('../src/session');

const PROJECT_ROOT = path.join(__dirname, '..');

function out(...a) { console.log(...a); }
function err(...a) { console.error(...a); }

async function askYesNo(question, def = false) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise((res) => rl.question(`${question} ${def ? '[Y/n]' : '[y/N]'} `, res));
  rl.close();
  const s = String(ans).trim().toLowerCase();
  if (!s) return def;
  return s === 'y' || s === 'yes' || s === '是';
}


async function cmdStart(args) {
  ensureDirs();
  const cfg = loadConfig();
  const exe = findZCodeExe(cfg);
  if (!exe) {
    err('未找到 ZCode.exe。请编辑', FILES.config, '添加 {"zcodeExe": "D:\\\\path\\\\to\\\\ZCode.exe"}');
    process.exit(1);
  }
  saveConfig({ ...cfg, zcodeExe: exe });

  // 已有换肤会话？直接应用
  let port = await resolveSessionPort();
  if (port) {
    out(`检测到运行中的换肤会话 (端口 ${port})，重新应用主题…`);
    spawnDaemon(port);
    out(await applyActiveTheme(port));
    return;
  }

  // ZCode 在跑但没有 CDP → 需要重启
  if (isZCodeRunning()) {
    const yes = args.includes('--yes') || args.includes('-y')
      || await askYesNo('ZCode 正在运行但未开启换肤会话，需要重启 ZCode（请先保存工作）。现在重启？');
    if (!yes) { out('已取消。'); return; }
    out('正在关闭 ZCode…');
    const ok = await closeZCode();
    if (!ok) { err('ZCode 未能完全退出，请手动关闭后重试。'); process.exit(1); }
    await sleep(800);
  }

  port = await findFreePort(9335);
  out(`以换肤模式启动 ZCode（CDP 端口 ${port}，仅绑定 127.0.0.1）…`);
  launchZCode(port);
  saveState({ ...loadState(), port, skinActive: true, startedAt: Date.now() });
  await waitForCDP(port, 25000);
  spawnDaemon(port);
  out('等待渲染页就绪…');
  await sleep(2500);
  out(await applyActiveTheme(port));
  out('换肤完成。使用 zds panel 打开控制面板，zds restore 还原官方外观。');
}

async function cmdApply() {
  const port = await resolveSessionPort();
  if (!port) { err('没有运行中的换肤会话，请先 zds start'); process.exit(1); }
  out(await applyActiveTheme(port));
}

async function cmdUse(name) {
  if (!name) { err('用法: zds use <主题名>'); process.exit(1); }
  if (!getTheme(name)) { err(`主题不存在: ${name}（zds list 查看全部）`); process.exit(1); }
  const st = loadState();
  saveState({ ...st, activeTheme: name, paused: false, panelOpacity: undefined, cardOpacity: undefined, scrim: undefined, blur: undefined });
  const port = await resolveSessionPort();
  if (port) out(await applyActiveTheme(port));
  else out(`已切换到主题 ${name}（ZCode 未运行，下次 zds start 生效）`);
}

async function cmdSave(name) {
  if (!name) { err('用法: zds save <主题名>'); process.exit(1); }
  const cur = resolveActiveTheme();
  const t = saveTheme(name, cur);
  const st = loadState();
  saveState({ ...st, activeTheme: name });
  out(`已保存主题 ${name} → ${path.join(DIRS.themes, name)}`);
}

async function cmdList() {
  const st = loadState();
  const active = st.activeTheme || 'dream-void';
  const themes = listThemes();
  if (!themes.length) { out('暂无主题'); return; }
  for (const t of themes) {
    const mark = t.name === active ? '●' : '○';
    out(`${mark} ${t.name}${t.builtin ? '（内置）' : ''}  面板不透明度=${t.panelOpacity}  遮罩=${t.scrim}  模糊=${t.blur || 0}`);
  }
}

async function cmdSetBg(imagePath) {
  if (!imagePath) { err('用法: zds set-bg <图片路径>'); process.exit(1); }
  const abs = path.resolve(imagePath);
  const archived = importImage(abs);
  // 更新当前激活主题的图片（内置主题则另存为 custom）
  const st = loadState();
  const cur = resolveActiveTheme();
  const name = getTheme(st.activeTheme || 'dream-void')?.builtin ? 'custom' : (st.activeTheme || 'custom');
  saveTheme(name, { ...cur, image: archived });
  saveState({ ...st, activeTheme: name, paused: false });
  out(`已导入背景图并应用到主题 ${name}`);
  const port = await resolveSessionPort();
  if (port) out(await applyActiveTheme(port));
}

async function cmdAdjust(key, raw) {
  const st = loadState();
  const patch = { ...st };
  if (key === 'scrim' && raw === 'auto') patch.scrim = 'auto';
  else {
    const n = Number(raw);
    if (!Number.isFinite(n)) { err(`数值无效: ${raw}`); process.exit(1); }
    if (key === 'opacity') patch.panelOpacity = Math.max(0, Math.min(100, n));
    if (key === 'cards') patch.cardOpacity = Math.max(0, Math.min(100, n));
    if (key === 'scrim') patch.scrim = Math.max(0, Math.min(100, n));
    if (key === 'blur') patch.blur = Math.max(0, Math.min(40, n));
  }
  patch.paused = false;
  saveState(patch);
  const port = await resolveSessionPort();
  if (port) out(await applyActiveTheme(port));
  else out('已记录，下次启动生效');
}

async function cmdPause() {
  const st = loadState();
  saveState({ ...st, paused: true });
  const port = await resolveSessionPort();
  if (port) out(await removeSkin(port));
  out('皮肤已暂停（会话保持，随时 zds resume 恢复）');
}

async function cmdResume() {
  const st = loadState();
  saveState({ ...st, paused: false });
  const port = await resolveSessionPort();
  if (!port) { err('没有运行中的换肤会话'); process.exit(1); }
  out(await applyActiveTheme(port));
}

async function cmdRestore(args) {
  const st = loadState();
  const port = await resolveSessionPort();
  if (port) { try { await removeSkin(port); } catch { /* 忽略 */ } }
  if (st.daemonPid) { await killProcessTree(st.daemonPid); }
  saveState({ skinActive: false });
  out('已恢复官方外观。');
  if (isZCodeRunning()) {
    const yes = args.includes('--yes') || args.includes('-y')
      || await askYesNo('是否重启 ZCode 回到完全官方状态（关闭调试端口）？', true);
    if (yes) {
      await closeZCode();
      await sleep(800);
      const cfg = loadConfig();
      spawn(findZCodeExe(cfg), [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      out('ZCode 已以官方模式重启。');
    }
  }
}

async function cmdStatus() {
  const st = loadState();
  const port = await resolveSessionPort();
  out('状态目录:', DIRS.root);
  out('ZCode 运行中:', isZCodeRunning() ? '是' : '否');
  out('换肤会话端口:', port || '无');
  out('当前主题:', st.activeTheme || 'dream-void', st.paused ? '(已暂停)' : '');
  if (port) {
    try { out('页面内状态:', JSON.stringify(await skinStatus(port))); } catch (e) { out('页面内状态读取失败:', e.message); }
  }
}

async function cmdShot(file) {
  const port = await resolveSessionPort();
  if (!port) { err('没有运行中的换肤会话'); process.exit(1); }
  const { connectRenderer } = require('../src/cdp');
  const session = await connectRenderer(port);
  try {
    await session.send('Page.enable');
    const r = await session.send('Page.captureScreenshot', { format: 'png' });
    const dest = path.resolve(file || `zds-shot-${Date.now()}.png`);
    fs.writeFileSync(dest, Buffer.from(r.data, 'base64'));
    out('截图 →', dest);
  } finally { session.close(); }
}

async function cmdPanel() {
  // 以分离进程运行面板服务，避免占用当前终端
  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'src', 'panel.js')], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  child.unref();
  // 读第一行输出拿面板地址，再打开浏览器
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('面板启动超时')), 10000);
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/panel:\s*(http:\/\/\S+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
  child.stdout.destroy();
  child.stderr.destroy();
  out('控制面板:', url);
  spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

function usage() {
  out(`ZCode Dream Skin — ZCode 桌面端换肤工具（CDP 注入，不改官方安装包）

用法: zds <命令> [参数]

  start [--yes]        以换肤模式启动 ZCode（必要时先优雅关闭）
  apply                重新应用当前主题
  use <主题名>         切换主题
  save <主题名>        把当前外观保存为主题
  list                 列出全部主题
  set-bg <图片>        导入背景图并应用（PNG/JPEG/WebP，≤16MB）
  opacity <0-100>      面板不透明度（越大越实）
  cards <0-100>        卡片/代码块不透明度（默认随面板-8）
  scrim <0-100|auto>   壁纸遮罩强度
  blur <0-40>          壁纸模糊 px
  pause                暂停皮肤（保持会话）
  resume               恢复皮肤
  restore [--yes]      一键还原官方外观（可选重启 ZCode）
  panel                打开 Web 控制面板
  status               查看状态
  shot [文件]          截图（调试用）
`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  ensureDirs();
  switch (cmd) {
    case 'start': return cmdStart(args);
    case 'apply': return cmdApply();
    case 'use': return cmdUse(args[0]);
    case 'save': return cmdSave(args[0]);
    case 'list': return cmdList();
    case 'set-bg': return cmdSetBg(args[0]);
    case 'opacity': return cmdAdjust('opacity', args[0]);
    case 'cards': return cmdAdjust('cards', args[0]);
    case 'scrim': return cmdAdjust('scrim', args[0]);
    case 'blur': return cmdAdjust('blur', args[0]);
    case 'pause': return cmdPause();
    case 'resume': return cmdResume();
    case 'restore': return cmdRestore(args);
    case 'status': return cmdStatus();
    case 'shot': return cmdShot(args[0]);
    case 'panel': return cmdPanel();
    case 'delete': {
      if (!args[0]) { err('用法: zds delete <主题名>'); process.exit(1); }
      out(deleteTheme(args[0]) ? '已删除' : '主题不存在');
      return;
    }
    default: usage();
  }
}

main().catch((e) => { err('错误:', e.message); process.exit(1); });

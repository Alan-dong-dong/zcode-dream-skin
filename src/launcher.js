// 启动器：ZCode 进程发现、优雅关闭、以 CDP 调试模式拉起
const fs = require('fs');
const net = require('net');
const { spawn, execFileSync, execFile } = require('child_process');
const { findZCodeExe, zcodeUserDataDir, loadConfig, log } = require('./paths');

// 列出 ZCode 进程（含命令行），基于 wmic；失败时退化为 tasklist
function listZCodeProcesses() {
  try {
    const out = execFileSync('wmic', ['process', 'where', "name='ZCode.exe'", 'get', 'ProcessId,CommandLine', '/format:csv'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const procs = [];
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/,(.*),(\d+)\s*$/);
      if (!m) continue;
      const [, cmdline, pid] = m;
      procs.push({ pid: Number(pid), cmdline: cmdline || '', isHelper: /--type=/.test(cmdline) });
    }
    return procs;
  } catch {
    try {
      const out = execFileSync('tasklist', ['/fi', 'imagename eq ZCode.exe', '/fo', 'csv', '/nh'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      return out.split(/\r?\n/).filter(Boolean).map((line) => {
        const cols = line.split('","').map((s) => s.replace(/^"|"$/g, ''));
        return { pid: Number(cols[1]), cmdline: '', isHelper: false };
      }).filter((p) => p.pid);
    } catch { return []; }
  }
}

function isZCodeRunning() {
  return listZCodeProcesses().some((p) => !p.isHelper);
}

// 优雅关闭主进程（taskkill 不带 /F = 发送 WM_CLOSE），等待退出，必要时 /F 兜底
async function closeZCode({ forceAfterMs = 10000 } = {}) {
  const mains = listZCodeProcesses().filter((p) => !p.isHelper);
  for (const p of mains) {
    try { execFileSync('taskkill', ['/pid', String(p.pid), '/t'], { stdio: 'pipe' }); } catch { /* 已在退出 */ }
  }
  const deadline = Date.now() + forceAfterMs;
  while (Date.now() < deadline) {
    await sleep(500);
    if (!isZCodeRunning()) return true;
  }
  // 兜底强杀
  for (const p of listZCodeProcesses()) {
    try { execFileSync('taskkill', ['/pid', String(p.pid), '/t', '/f'], { stdio: 'pipe' }); } catch { /* ignore */ }
  }
  await sleep(1000);
  return !isZCodeRunning();
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function findFreePort(start = 9335, end = 9399) {
  for (let p = start; p <= end; p++) {
    if (await isPortFree(p)) return p;
  }
  throw new Error(`端口 ${start}-${end} 均被占用`);
}

// 以换肤模式启动 ZCode：显式 user-data-dir（Chromium M136+ 要求，否则忽略调试端口）
function launchZCode(port, extraArgs = []) {
  const cfg = loadConfig();
  const exe = findZCodeExe(cfg);
  if (!exe) throw new Error('未找到 ZCode.exe，请先在 config.json 配置 zcodeExe 路径');
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${zcodeUserDataDir(cfg)}`,
    ...extraArgs,
  ];
  log(`launch: "${exe}" ${args.join(' ')}`);
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return { exe, pid: child.pid, args };
}

// 等待 CDP 端点就绪
async function waitForCDP(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200) });
      if (res.ok) return await res.json();
    } catch { /* 未就绪 */ }
    await sleep(600);
  }
  throw new Error(`等待 CDP 端点超时（:${port}）`);
}

// 检查某端口是不是 ZCode 的 CDP
async function probeCDP(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200) });
    if (!res.ok) return null;
    const v = await res.json();
    return /ZCode|Electron/i.test(v['User-Agent'] || '') ? v : null;
  } catch { return null; }
}

function killProcessTree(pid) {
  return new Promise((resolve) => {
    execFile('taskkill', ['/pid', String(pid), '/t', '/f'], () => resolve());
  });
}

module.exports = { listZCodeProcesses, isZCodeRunning, closeZCode, findFreePort, launchZCode, waitForCDP, probeCDP, killProcessTree, sleep };

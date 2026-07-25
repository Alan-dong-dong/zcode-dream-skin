// 会话管理：定位当前换肤会话的 CDP 端口、拉起守护进程
const path = require('path');
const { spawn } = require('child_process');
const { loadState, saveState } = require('./paths');
const { probeCDP } = require('./launcher');

// 解析当前换肤会话端口：state 记录优先，其次扫描默认段
async function resolveSessionPort() {
  const st = loadState();
  if (st.port && await probeCDP(st.port)) return st.port;
  for (let p = 9335; p <= 9345; p++) {
    if (await probeCDP(p)) { saveState({ ...loadState(), port: p }); return p; }
  }
  return null;
}

// 启动注入守护进程（分离、无窗口），已存活则复用
function spawnDaemon(port) {
  const st = loadState();
  if (st.daemonPid) {
    try { process.kill(st.daemonPid, 0); return st.daemonPid; } catch { /* 已退出，拉起新的 */ }
  }
  const child = spawn(process.execPath, [path.join(__dirname, 'injector.js'), '--daemon', '--port', String(port)], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
  saveState({ ...loadState(), daemonPid: child.pid, port });
  return child.pid;
}

module.exports = { resolveSessionPort, spawnDaemon };

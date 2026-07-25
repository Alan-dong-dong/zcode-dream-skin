// 路径解析：ZCode 可执行文件发现、用户数据目录、皮肤工具自身状态目录
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const APP_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ZCodeDreamSkin');

const DIRS = {
  root: APP_DIR,
  themes: path.join(APP_DIR, 'themes'),
  images: path.join(APP_DIR, 'images'),
  presets: path.join(__dirname, '..', 'presets'),
};

const FILES = {
  state: path.join(APP_DIR, 'state.json'),
  config: path.join(APP_DIR, 'config.json'),
  log: path.join(APP_DIR, 'injector.log'),
};

function ensureDirs() {
  for (const d of [DIRS.root, DIRS.themes, DIRS.images]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

// 从注册表卸载项查找 ZCode 安装位置
function findZCodeFromRegistry() {
  const roots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  for (const root of roots) {
    try {
      // root 来自上方固定白名单数组，不接受外部输入
      const out = execFileSync('reg', ['query', root, '/s', '/f', 'ZCode', '/d'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      const m = out.match(/InstallLocation\s+REG_SZ\s+(.+)/i) || out.match(/DisplayIcon\s+REG_SZ\s+(.+ZCode\.exe)/i);
      if (m) {
        const p = m[1].trim().replace(/^"|"$/g, '');
        const exe = p.toLowerCase().endsWith('.exe') ? p : path.join(p, 'ZCode.exe');
        if (fs.existsSync(exe)) return exe;
      }
    } catch { /* 未命中继续 */ }
  }
  return null;
}

// 从运行中的进程路径推断
function findZCodeFromProcesses() {
  try {
    const out = execFileSync('wmic', ['process', 'where', "name='ZCode.exe'", 'get', 'ExecutablePath', '/value'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const m = out.match(/ExecutablePath=(.+\.exe)/i);
    if (m && fs.existsSync(m[1].trim())) return m[1].trim();
  } catch { /* ignore */ }
  return null;
}

function findZCodeExe(config = {}) {
  if (config.zcodeExe && fs.existsSync(config.zcodeExe)) return config.zcodeExe;
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ZCode', 'ZCode.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ZCode', 'ZCode.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'ZCode', 'ZCode.exe'),
    'D:\\MyFiles\\ZCode\\ZCode.exe',
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return findZCodeFromRegistry() || findZCodeFromProcesses() || null;
}

function zcodeUserDataDir(config = {}) {
  return config.userDataDir || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ZCode');
}

function readJSON(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function loadConfig() {
  return readJSON(FILES.config, {}) || {};
}

function saveConfig(cfg) {
  writeJSON(FILES.config, cfg);
}

function loadState() {
  return readJSON(FILES.state, {}) || {};
}

function saveState(s) {
  writeJSON(FILES.state, s);
}

function log(line) {
  const ts = new Date().toISOString();
  try { fs.appendFileSync(FILES.log, `[${ts}] ${line}\n`); } catch { /* ignore */ }
}

module.exports = { DIRS, FILES, ensureDirs, findZCodeExe, zcodeUserDataDir, loadConfig, saveConfig, loadState, saveState, log, readJSON, writeJSON };

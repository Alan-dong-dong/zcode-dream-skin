// 主题仓库：主题的增删查改、当前主题解析、图片导入与校验
const fs = require('fs');
const path = require('path');
const { DIRS, loadState, saveState, readJSON, writeJSON } = require('./paths');
const { DEFAULT_THEME } = require('./skin');

const MAX_IMAGE_BYTES = 16 * 1024 * 1024; // 16 MB，与参考项目一致
const MAX_DIMENSION = 16384;
const MAX_PIXELS = 50_000_000;

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

// ---- 无依赖图片尺寸嗅探 ----
function sniffSize(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(64);
    fs.readSync(fd, head, 0, 64, 0);
    // PNG: 89 50 4E 47 ... IHDR width/height (big endian, offset 16/20)
    if (head.readUInt32BE(0) === 0x89504e47) {
      return { width: head.readUInt32BE(16), height: head.readUInt32BE(20), mime: 'image/png' };
    }
    // JPEG: FF D8，逐段找 SOF0-SOF15（排除 DHT/DAC/RST）
    if (head[0] === 0xff && head[1] === 0xd8) {
      let off = 2;
      const buf = Buffer.alloc(2);
      while (true) {
        fs.readSync(fd, buf, 0, 2, off);
        const marker = buf.readUInt16BE(0);
        if ((marker >= 0xffc0 && marker <= 0xffcf) && marker !== 0xffc4 && marker !== 0xffc8 && marker !== 0xffcc) {
          const seg = Buffer.alloc(7);
          fs.readSync(fd, seg, 0, 7, off + 2);
          return { height: seg.readUInt16BE(1), width: seg.readUInt16BE(3), mime: 'image/jpeg' };
        }
        const lenBuf = Buffer.alloc(2);
        fs.readSync(fd, lenBuf, 0, 2, off + 2);
        off += 2 + lenBuf.readUInt16BE(0);
        if (off > 1024 * 1024) break;
      }
      return { width: 0, height: 0, mime: 'image/jpeg' };
    }
    // WebP: RIFF....WEBP VP8/VP8L/VP8X
    if (head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') {
      const fmt = head.toString('ascii', 12, 16);
      if (fmt === 'VP8X') return { width: 1 + head.readUIntLE(24, 3), height: 1 + head.readUIntLE(27, 3), mime: 'image/webp' };
      if (fmt === 'VP8 ') return { width: head.readUInt16LE(26) & 0x3fff, height: head.readUInt16LE(28) & 0x3fff, mime: 'image/webp' };
      if (fmt === 'VP8L') {
        const b = head.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1, mime: 'image/webp' };
      }
      return { width: 0, height: 0, mime: 'image/webp' };
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function validateImage(file) {
  const ext = path.extname(file).toLowerCase();
  if (!MIME[ext]) throw new Error(`不支持的图片格式 ${ext}（仅支持 PNG/JPEG/WebP）`);
  const size = fs.statSync(file).size;
  if (size > MAX_IMAGE_BYTES) throw new Error(`图片超过 16 MB 上限（${(size / 1024 / 1024).toFixed(1)} MB）`);
  const dim = sniffSize(file);
  if (!dim) throw new Error('无法识别的图片文件（文件头校验失败）');
  if (dim.width > MAX_DIMENSION || dim.height > MAX_DIMENSION) throw new Error(`图片边长超过 ${MAX_DIMENSION}px`);
  if (dim.width * dim.height > MAX_PIXELS) throw new Error('图片总像素超过 5000 万');
  return dim;
}

// ---- 主题 CRUD ----
function themeDir(name) {
  const safe = String(name).replace(/[\\/:*?"<>|]/g, '-');
  return path.join(DIRS.themes, safe);
}

function listThemes() {
  const out = [];
  // 内置预设
  const presetImg = path.join(DIRS.presets, 'dream-void.png');
  if (fs.existsSync(presetImg)) {
    out.push({ name: 'dream-void', builtin: true, image: presetImg, ...DEFAULT_THEME });
  }
  if (fs.existsSync(DIRS.themes)) {
    for (const name of fs.readdirSync(DIRS.themes)) {
      const tj = path.join(DIRS.themes, name, 'theme.json');
      if (!fs.existsSync(tj)) continue;
      const t = readJSON(tj, null);
      if (t) out.push({ ...t, name, builtin: false });
    }
  }
  return out;
}

function getTheme(name) {
  return listThemes().find((t) => t.name === name) || null;
}

function saveTheme(name, data) {
  const dir = themeDir(name);
  fs.mkdirSync(dir, { recursive: true });
  // 把图片复制进主题目录，主题自包含
  let image = data.image;
  if (image && !String(image).startsWith(dir)) {
    const ext = path.extname(image).toLowerCase() || '.png';
    const dest = path.join(dir, 'background' + ext);
    fs.copyFileSync(image, dest);
    image = dest;
  }
  const { builtin, ...clean } = data || {}; // builtin 是运行态标记，不落盘
  const theme = { ...DEFAULT_THEME, ...clean, name, image };
  writeJSON(path.join(dir, 'theme.json'), theme);
  return theme;
}

function deleteTheme(name) {
  const dir = themeDir(name);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  const st = loadState();
  if (st.activeTheme === name) { st.activeTheme = 'dream-void'; saveState(st); }
  return true;
}

// 解析当前生效主题：state.activeTheme → 主题配置（含图片绝对路径）
function resolveActiveTheme() {
  const st = loadState();
  const name = st.activeTheme || 'dream-void';
  let theme = getTheme(name) || getTheme('dream-void');
  if (!theme) throw new Error('没有可用主题（连内置预设都缺失）');
  // 会话内覆盖项（临时调过的透明度等，不污染已存主题）
  if (typeof st.panelOpacity === 'number') theme = { ...theme, panelOpacity: st.panelOpacity };
  if (typeof st.cardOpacity === 'number') theme = { ...theme, cardOpacity: st.cardOpacity };
  if (st.scrim !== undefined) theme = { ...theme, scrim: st.scrim };
  if (typeof st.blur === 'number') theme = { ...theme, blur: st.blur };
  return theme;
}

// 导入外部图片到 images/ 归档，返回归档路径
function importImage(src) {
  if (!fs.existsSync(src)) throw new Error(`文件不存在: ${src}`);
  validateImage(src);
  const ext = path.extname(src).toLowerCase();
  const dest = path.join(DIRS.images, `img-${Date.now()}${ext}`);
  fs.copyFileSync(src, dest);
  return dest;
}

// 主题 → data URI（供注入）
function themeToDataUri(theme) {
  const ext = path.extname(theme.image).toLowerCase();
  const mime = MIME[ext] || 'image/png';
  const b64 = fs.readFileSync(theme.image).toString('base64');
  return `data:${mime};base64,${b64}`;
}

module.exports = { listThemes, getTheme, saveTheme, deleteTheme, resolveActiveTheme, importImage, validateImage, themeToDataUri, MAX_IMAGE_BYTES };

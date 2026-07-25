// 极简 CDP 客户端：基于 Node 22 原生 WebSocket，零依赖
// 只绑定 127.0.0.1，符合「本机回环注入、不改官方安装包」的安全边界

class CDPError extends Error {}

async function httpJSON(url, timeoutMs = 3000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new CDPError(`HTTP ${res.status} ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getVersion(port) {
  return httpJSON(`http://127.0.0.1:${port}/json/version`);
}

async function listTargets(port) {
  return httpJSON(`http://127.0.0.1:${port}/json/list`);
}

// 找到 ZCode 主渲染页 target
async function findRendererTarget(port) {
  const targets = await listTargets(port);
  return targets.find((t) => t.type === 'page' && /renderer[\\/]index\.html/.test(t.url)) || null;
}

class CDPSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
  }

  connect(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new CDPError('CDP WebSocket 连接超时')), timeoutMs);
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => { clearTimeout(timer); resolve(); };
      this.ws.onerror = (e) => { clearTimeout(timer); reject(new CDPError('CDP WebSocket 连接失败')); };
      this.ws.onclose = () => this._onClose();
      this.ws.onmessage = (ev) => this._onMessage(ev);
    });
  }

  _onClose() {
    this.closed = true;
    for (const { reject } of this.pending.values()) reject(new CDPError('CDP 连接已关闭'));
    this.pending.clear();
    this._emit('__close__', {});
  }

  _onMessage(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new CDPError(`${msg.error.message} (code ${msg.error.code})`));
      else resolve(msg.result || {});
      return;
    }
    if (msg.method) this._emit(msg.method, msg.params || {});
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  _emit(method, params) {
    const fns = this.listeners.get(method);
    if (fns) for (const fn of fns) { try { fn(params); } catch { /* ignore */ } }
  }

  send(method, params = {}, timeoutMs = 15000) {
    if (this.closed) return Promise.reject(new CDPError('CDP 连接已关闭'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new CDPError(`${method} 超时`)); }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  // 在页面上下文执行 JS，返回 byValue 结果
  async evaluate(expression, { awaitPromise = false } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise, userGesture: true,
    });
    if (r.exceptionDetails) {
      const desc = r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'unknown';
      throw new CDPError(`页面脚本异常: ${String(desc).slice(0, 400)}`);
    }
    return r.result?.value;
  }

  close() {
    try { this.ws?.close(); } catch { /* ignore */ }
    this._onClose();
  }
}

async function connectRenderer(port, timeoutMs = 5000) {
  const target = await findRendererTarget(port);
  if (!target) throw new CDPError(`端口 ${port} 上未找到 ZCode 渲染页（ZCode 是否以换肤模式启动？）`);
  const session = new CDPSession(target.webSocketDebuggerUrl);
  await session.connect(timeoutMs);
  return session;
}

module.exports = { CDPError, getVersion, listTargets, findRendererTarget, CDPSession, connectRenderer };

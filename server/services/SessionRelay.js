/**
 * SessionRelay - 会话级 API 本地反代（"显示即转发"，让面板 API 地址 100% 真实）
 *
 * 背景：Claude Code 不从任何渠道（statusline/OTEL/transcript/hooks）暴露实际生效的
 * base URL，外部只能靠"复刻配置优先级"去猜，且 v2.0.1 起 settings.json env 块会覆盖
 * 进程 env（官方 issue #8500），猜测极易与实际不符。
 *
 * 方案：会话选定供应商后，把 ANTHROPIC_BASE_URL 指到本服务
 * http://127.0.0.1:<port>/relay/<sessionId>，由这里按会话映射流式转发到真实供应商。
 * 面板显示的目标 = 转发的目标，物理上同一份数据；真实密钥只存服务端，
 * 终端 env 里只有占位符。附带记录最近转发时间/目标/次数供面板展示"实测"。
 */
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import os from 'os';

const PERSIST_FILE = path.join(os.homedir(), '.webtmux', 'session-relay.json');

class SessionRelay {
  constructor(log = console.log) {
    this.log = (m) => log(`[SessionRelay] ${m}`);
    this.map = new Map();   // sessionId -> { url, key, keyMode, providerId, providerName, updatedAt }
    this.stats = new Map(); // sessionId -> { lastAt, lastTarget, lastStatus, lastModel, count }
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(PERSIST_FILE)) {
        const data = JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf-8'));
        for (const [sid, v] of Object.entries(data)) this.map.set(sid, v);
        this.log(`已恢复 ${this.map.size} 个会话映射`);
      }
    } catch (e) {
      this.log(`恢复映射失败: ${e.message}`);
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(PERSIST_FILE), { recursive: true });
      fs.writeFileSync(PERSIST_FILE, JSON.stringify(Object.fromEntries(this.map), null, 2), 'utf-8');
    } catch (e) {
      this.log(`持久化失败: ${e.message}`);
    }
  }

  /**
   * 设置/更新会话的真实供应商（热切换：改映射即可，无需重启 CLI）
   * @param {string} sessionId
   * @param {object} p { url, key, keyMode: 'bearer'|'x-api-key', providerId, providerName }
   */
  setProvider(sessionId, p) {
    if (!p?.url) return false;
    this.map.set(sessionId, { ...p, url: p.url.replace(/\/+$/, ''), updatedAt: Date.now() });
    this._save();
    this.log(`会话 ${sessionId} → ${p.providerName || ''} ${p.url}`);
    return true;
  }

  clear(sessionId) {
    if (this.map.delete(sessionId)) this._save();
    this.stats.delete(sessionId);
  }

  get(sessionId) {
    return this.map.get(sessionId) || null;
  }

  getStats(sessionId) {
    return this.stats.get(sessionId) || null;
  }

  /**
   * Express/http 处理器。必须注册在 body parser 之前（原始流透传，支持 SSE）。
   * 路径格式：/relay/<sessionId>/v1/messages...
   */
  handle(req, res) {
    const m = req.url.match(/^\/relay\/([^/]+)(\/.*)?$/);
    if (!m) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'bad relay path' }));
    }
    const sessionId = m[1];
    const rest = m[2] || '/';
    const target = this.map.get(sessionId);
    if (!target) {
      res.writeHead(502, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { type: 'relay_error', message: `WebTmux relay: 会话 ${sessionId} 无供应商映射（可能服务重启丢失，请在面板重选供应商）` } }));
    }

    let upstream;
    try {
      upstream = new URL(target.url);
    } catch {
      res.writeHead(502, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { type: 'relay_error', message: 'bad upstream url' } }));
    }

    // 供应商 URL 可能自带路径前缀（如 https://host/api），与请求路径拼接
    const basePath = upstream.pathname.replace(/\/+$/, '');
    const outPath = basePath + rest;

    // 透传请求头：改写 host，剥掉入站占位密钥，注入真实密钥
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    delete headers.authorization;
    delete headers['x-api-key'];
    if (target.keyMode === 'x-api-key') {
      headers['x-api-key'] = target.key;
    } else {
      headers.authorization = `Bearer ${target.key}`;
    }

    const mod = upstream.protocol === 'https:' ? https : http;
    const preq = mod.request({
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
      path: outPath,
      method: req.method,
      headers,
      timeout: 600000, // LLM 长流式响应
    }, (pres) => {
      // 记录实测转发（面板"代理·实测"数据源）
      const s = this.stats.get(sessionId) || { count: 0 };
      s.lastAt = Date.now();
      s.lastTarget = upstream.host;
      s.lastStatus = pres.statusCode;
      s.count += 1;
      this.stats.set(sessionId, s);

      res.writeHead(pres.statusCode, pres.headers);
      pres.pipe(res);
    });

    // 嗅探请求体开头的 model 字段（实测模型，供面板显示）；只看前 4KB，不影响透传
    let sniffBuf = '';
    const sniff = (chunk) => {
      sniffBuf += chunk.toString('utf-8', 0, Math.min(chunk.length, 4096));
      const mm = sniffBuf.match(/"model"\s*:\s*"([^"]+)"/);
      if (mm || sniffBuf.length >= 4096) {
        req.off('data', sniff);
        if (mm) {
          const s = this.stats.get(sessionId) || { count: 0 };
          s.lastModel = mm[1];
          this.stats.set(sessionId, s);
        }
      }
    };
    req.on('data', sniff);

    preq.on('timeout', () => preq.destroy(new Error('upstream timeout')));
    preq.on('error', (e) => {
      this.log(`转发失败 ${sessionId} → ${upstream.host}: ${e.message}`);
      const s = this.stats.get(sessionId) || { count: 0 };
      s.lastAt = Date.now();
      s.lastTarget = upstream.host;
      s.lastStatus = 0;
      s.count += 1;
      this.stats.set(sessionId, s);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'relay_error', message: `WebTmux relay 转发失败: ${e.message}` } }));
      } else {
        res.destroy();
      }
    });
    req.on('aborted', () => preq.destroy());
    req.pipe(preq);
  }
}

export default SessionRelay;

/**
 * PuppeteerReaper - 自动回收失控/孤儿的 puppeteer "Chrome for Testing" 进程
 *
 * 背景：claude/grok 会话经 puppeteer-mcp-claude(MCP) 启动的 Chrome for Testing
 * 偶发渲染进程自旋卡死(单进程数百% CPU)，或会话退出后 Chrome 变孤儿堆积吃内存，
 * 拖垮整机导致 WhatyTerm 终端输入卡顿。本服务只处置这两类，且**只碰 puppeteer 缓存目录
 * 下的 Chrome**，绝不触碰用户真实 Chrome / 其它应用。
 */
import { execSync } from 'child_process';

const PUPPETEER_MARK = '.cache/puppeteer/chrome/'; // 硬安全过滤：只认此路径下的 Chrome
const MCP_MARK = 'puppeteer-mcp-claude';
const CPU_THRESHOLD = 250;   // 单进程 CPU% 超此视为疑似失控
const CONFIRM_MS = 45000;    // 持续超阈值这么久才确认失控（避免误杀短暂繁忙）
const INTERVAL_MS = 30000;   // 扫描周期

class PuppeteerReaper {
  constructor(log = console.log) {
    this.log = (m) => log(`[PuppeteerReaper] ${m}`);
    this.timer = null;
    this.hotSince = new Map(); // pid -> 首次超阈值时间戳
  }

  start() {
    if (this.timer) return;
    if (process.platform === 'win32') {
      this.log('Windows 平台跳过（依赖 ps/pgrep）');
      return;
    }
    this.timer = setInterval(() => {
      try { this._tick(); } catch (e) { this.log(`扫描异常: ${e.message}`); }
    }, INTERVAL_MS);
    if (this.timer.unref) this.timer.unref();
    this.log(`已启动，每 ${INTERVAL_MS / 1000}s 扫描一次（失控阈值 ${CPU_THRESHOLD}% 持续 ${CONFIRM_MS / 1000}s）`);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  // 读取进程表：pid ppid cpu% command
  _procTable() {
    const out = execSync('ps -axo pid=,ppid=,pcpu=,command=', { encoding: 'utf-8', timeout: 5000 });
    const map = new Map();
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/);
      if (m) map.set(+m[1], { pid: +m[1], ppid: +m[2], cpu: parseFloat(m[3]), cmd: m[4] });
    }
    return map;
  }

  // 祖先链（从直接父进程往上）
  _ancestors(pid, table) {
    const chain = [];
    let cur = table.get(pid);
    const seen = new Set([pid]);
    while (cur && cur.ppid && cur.ppid !== 0 && !seen.has(cur.ppid)) {
      seen.add(cur.ppid);
      const parent = table.get(cur.ppid);
      if (!parent) break;
      chain.push(parent);
      cur = parent;
    }
    return chain;
  }

  // 子孙 pid（含各层）
  _descendants(pid, table) {
    const result = [];
    const queue = [pid];
    while (queue.length) {
      const cur = queue.shift();
      for (const p of table.values()) {
        if (p.ppid === cur && !result.includes(p.pid)) { result.push(p.pid); queue.push(p.pid); }
      }
    }
    return result;
  }

  _isPuppeteerChrome(p) {
    return p && p.cmd.includes(PUPPETEER_MARK) && /Chrome for Testing|chrome-mac|chrome\.exe|\/chrome\b/i.test(p.cmd);
  }

  // 该 Chrome 是否由一个「还活着」的 claude/grok 会话拥有（祖先里首 token basename 为 claude/grok）
  _ownedByLiveCli(pid, table) {
    for (const a of this._ancestors(pid, table)) {
      if (a.cmd.includes(MCP_MARK)) continue; // 排除 puppeteer-mcp-claude 自身（名字含 claude）
      const first = a.cmd.trim().split(/\s+/)[0].split('/').pop();
      if (first === 'claude' || first === 'grok') return true;
    }
    return false;
  }

  // 从任一 puppeteer chrome 进程向上找到该浏览器实例的主进程（父不再是 puppeteer chrome）
  _browserRoot(pid, table) {
    let cur = table.get(pid);
    while (cur) {
      const parent = table.get(cur.ppid);
      if (this._isPuppeteerChrome(parent)) cur = parent; else break;
    }
    return cur ? cur.pid : pid;
  }

  _kill(pids, table, reason) {
    const set = new Set();
    for (const pid of pids) {
      set.add(pid);
      for (const d of this._descendants(pid, table)) set.add(d);
    }
    // 最终安全闸：只允许击杀 puppeteer chrome 或 puppeteer-mcp-claude 进程
    const safe = [...set].filter((pid) => {
      const p = table.get(pid);
      return p && (this._isPuppeteerChrome(p) || p.cmd.includes(MCP_MARK));
    });
    if (!safe.length) return;
    try { execSync(`kill ${safe.join(' ')} 2>/dev/null; sleep 1; kill -9 ${safe.join(' ')} 2>/dev/null || true`, { timeout: 5000 }); } catch {}
    this.log(`${reason}：已回收 ${safe.length} 个进程 [${safe.join(',')}]`);
  }

  _tick() {
    const table = this._procTable();
    const chromes = [...table.values()].filter((p) => this._isPuppeteerChrome(p));
    if (!chromes.length) { this.hotSince.clear(); return; }

    const now = Date.now();
    const killRoots = new Map(); // 浏览器主进程 pid -> 原因
    const liveHot = new Set();

    for (const p of chromes) {
      // 规则一：孤儿——所属 claude/grok 会话已退出（浏览器主进程判定，避免重复）
      const root = this._browserRoot(p.pid, table);
      if (root === p.pid && !this._ownedByLiveCli(p.pid, table)) {
        killRoots.set(root, '孤儿(上游会话已退出)');
      }
      // 规则二：确认失控——单进程 CPU 持续超阈值
      if (p.cpu >= CPU_THRESHOLD) {
        liveHot.add(p.pid);
        if (!this.hotSince.has(p.pid)) this.hotSince.set(p.pid, now);
        if (now - this.hotSince.get(p.pid) >= CONFIRM_MS) {
          killRoots.set(this._browserRoot(p.pid, table), `失控自旋(CPU ${p.cpu}% 持续 ${Math.round((now - this.hotSince.get(p.pid)) / 1000)}s)`);
        }
      }
    }
    // 清理已降温/消失的 hot 记录
    for (const pid of [...this.hotSince.keys()]) if (!liveHot.has(pid)) this.hotSince.delete(pid);

    for (const [root, reason] of killRoots) {
      // 孤儿场景连带回收其 puppeteer-mcp-claude 节点父进程
      const extra = this._ancestors(root, table).filter((a) => a.cmd.includes(MCP_MARK)).map((a) => a.pid);
      this._kill([root, ...extra], table, reason);
    }
  }
}

export default PuppeteerReaper;

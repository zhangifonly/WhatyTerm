/**
 * 服务子进程登记表 + 启动时清理上一次异常退出留下的孤儿。
 *
 * 为什么只能在启动时清：SIGKILL / OOM / 被上层进程连坐杀掉时，任何退出钩子都跑不到
 * （2026-09-26 00:37 实测：日志戛然而止、signal-forensics 无记录），子进程被 launchd 收养继续跑。
 * 那次留下一个 `caffeinate -dis`，让 Mac 一直不能休眠，且每异常退出一次就多一个。
 *
 * 为什么必须按登记表逐条核对、不能按命令名扫：每个 Claude CLI 自己也开着 `caffeinate -i -t 300`，
 * 用户也可能自己跑 frpc。只杀「pid 存活 + 命令对得上 + 启动时间对得上」的 —— 三样都对才是我们的；
 * 只看 pid 会撞 PID 复用，只看命令会误杀别人的进程。
 *
 * 文件 ~/.webtmux/run/server.json：{ pid, startedAt, cleanExit, children: [{pid, kind, match, startedAt}] }
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { spawnSync } from 'child_process';
import os from 'os';
import path from 'path';

/** ps 的秒级启动时间与 spawn 时记下的毫秒时间允许的误差 */
export const START_TOLERANCE_MS = 3000;
export const RUN_FILE = () => path.join(os.homedir(), '.webtmux', 'run', 'server.json');

/**
 * 一条登记记录现在是什么状态（纯函数）。
 * @param {{pid:number, match:string, startedAt:number}} rec
 * @param {{pid:number, ppid:number, startedAt:number, command:string}|null} live  ps 查到的该 pid 现状
 * @returns {'gone'|'reused'|'ours'}
 */
export function classifyRecorded(rec, live) {
  if (!live) return 'gone';
  const sameStart = Math.abs(live.startedAt - rec.startedAt) <= START_TOLERANCE_MS;
  const sameCmd = !!rec.match && String(live.command).includes(rec.match);
  return sameStart && sameCmd ? 'ours' : 'reused';
}

/**
 * ps 查一组 pid 的现状。
 * ⚠ 必须 LC_ALL=C：本机 ps 默认输出中文日期（「五 9月/25」），Date 解析不了。
 * ⚠ 不能用 `ps -p a,b,c`：macOS 上列表里只要有一个 pid 不存在，整条命令一行都不输出（退出码 1）——
 *   而恢复时上一个服务的 pid 必然已死，那样一个孤儿都认不出来（端到端测试实测踩到）。改为 -A 全列再过滤。
 */
export function psInfo(pids) {
  const want = new Set([...pids].filter((p) => Number.isInteger(p) && p > 0));
  if (!want.size || process.platform === 'win32') return new Map();
  const r = spawnSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,lstart=,command='],
    { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 });
  const out = new Map();
  for (const line of String(r.stdout || '').split('\n')) {
    // lstart 固定 5 段：Sat Sep 26 01:04:55 2026
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]{8}\s+\d{4})\s+(.*)$/);
    if (m && want.has(+m[1])) out.set(+m[1], { pid: +m[1], ppid: +m[2], startedAt: new Date(m[3]).getTime(), command: m[4] });
  }
  return out;
}

export class ChildRegistry {
  constructor({ file = RUN_FILE(), ps = psInfo, kill = (pid, sig) => process.kill(pid, sig), now = Date.now } = {}) {
    Object.assign(this, { file, ps, kill, now });
    // 进程真实启动时间，不是模块加载时刻：负载高时 Node 启动到加载完模块可能超过容差，
    // 那样下一个实例会把「还活着的我」判成已死、误杀我的子进程
    this.state = { pid: process.pid, startedAt: now() - Math.round(process.uptime() * 1000), cleanExit: false, children: [] };
    this.disabled = false;
  }

  _save() {
    if (this.disabled) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state));
      renameSync(tmp, this.file);   // 原子替换：写到一半被杀也不会留下坏文件
    } catch { /* 登记失败不能影响服务本身 */ }
  }

  /**
   * 启动时调用（必须早于任何会 spawn 子进程的代码）：上一次没正常退出就清掉它留下的孤儿，再登记本次。
   * @returns {{abnormal:boolean, prevPid?:number, prevStartedAt?:number, cleaned:Array<{pid,kind}>, skipped?:string}}
   */
  recoverAtStartup() {
    let prev = null;
    try { prev = JSON.parse(readFileSync(this.file, 'utf8')); } catch { /* 首次或文件坏了 */ }
    const report = { abnormal: false, cleaned: [] };
    if (prev && !prev.cleanExit && prev.pid !== process.pid) {
      const live = this.ps([prev.pid, ...(prev.children || []).map((c) => c.pid)]);
      // 上一个服务其实还活着（重复启动）：它的子进程不是孤儿，一个都不能动
      if (classifyRecorded({ pid: prev.pid, match: 'server', startedAt: prev.startedAt }, live.get(prev.pid)) === 'ours') {
        report.skipped = `上一个服务（pid ${prev.pid}）仍在运行，不清理`;
        this.disabled = true;   // 重复启动（多半马上因端口占用退出）：别覆盖正在运行那个的登记
        return report;
      } else {
        Object.assign(report, { abnormal: true, prevPid: prev.pid, prevStartedAt: prev.startedAt });
        for (const c of prev.children || []) {
          if (classifyRecorded(c, live.get(c.pid)) !== 'ours') continue;
          try { this.kill(c.pid, 'SIGTERM'); report.cleaned.push({ pid: c.pid, kind: c.kind }); } catch { /* 刚好自己退了 */ }
        }
      }
    }
    this._save();
    return report;
  }

  /** 登记一个子进程；它退出时自动注销。match：它命令行里必有的一段（用于核对身份） */
  track(proc, kind, match) {
    if (!proc?.pid) return proc;
    this.state.children.push({ pid: proc.pid, kind, match, startedAt: this.now() });
    this._save();
    proc.once?.('exit', () => {
      this.state.children = this.state.children.filter((c) => c.pid !== proc.pid);
      this._save();
    });
    return proc;
  }

  /** 正常退出（收到 SIGTERM/SIGINT 等）时标记，下次启动就不当成异常 */
  markCleanExit() {
    this.state.cleanExit = true;
    this._save();
  }
}

export default new ChildRegistry();

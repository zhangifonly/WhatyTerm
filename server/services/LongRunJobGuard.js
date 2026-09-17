/**
 * 长程编排：进程连坐（原版 orchestrator/jobguard.py 的 macOS/Linux 等价实现）
 *
 * 需求：编排器无论怎么死（包括被强杀、来不及跑清理代码），执行者整棵进程树都要跟着死。
 * 实测不这样的后果（原版 longrun-env-pitfalls）：编排器 20:19 被外部 kill 后，执行者又
 * **无人监管跑了 30 分钟** —— 代码照写，但没有监督者判定、没有交接、没有 git 快照。
 *
 * 原版靠 Windows Job Object（内核 kill-on-close）；非 Windows 上原版只打一行"不可用"警告。
 * 这里补上：
 *   1. 执行者 spawn 时 detached → 自成进程组，杀组能带走它起的 vite、subagent 的 Bash
 *   2. 每发另起一个极小的看门进程（自己也独立成组，不会被连带杀掉），每秒看一眼
 *      WebTmux 还活着没有；死了就对执行者整组 SIGTERM，5 秒后 SIGKILL。
 *      atexit / 信号处理器做不到这一点 —— 强杀不给执行清理代码的机会
 * Windows 上 process.kill 不支持负 pid，暂报不可用（与原版在非 Windows 上的姿态对称）。
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const WATCHER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'longrun-jobguard-watch.mjs');

export function available() {
  return process.platform !== 'win32';
}

/** 对执行者整个进程组发信号；拿不到组就退回只杀进程本身。 */
export function killProcessGroup(proc, signal = 'SIGTERM') {
  if (!proc?.pid) return;
  if (available()) {
    try { process.kill(-proc.pid, signal); return; } catch { /* 组已不在，退回单进程 */ }
  }
  try { proc.kill(signal); } catch { /* 已退出 */ }
}

/**
 * 把一发执行者交给看门进程。要求 proc 以 detached 方式 spawn（自成进程组）。
 * @returns {boolean} 是否已托管
 */
export function adoptProcessGroup(proc, parentPid = process.pid) {
  if (!available() || !proc?.pid) return false;
  try {
    const w = spawn(process.execPath, [WATCHER, String(parentPid), String(proc.pid)], {
      detached: true, stdio: 'ignore',
      // 打包后 execPath 是 Electron 本体，要按 Node 跑脚本
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    w.unref();
    return true;
  } catch {
    return false;
  }
}

/** 启动自检里打印的一行（原版 report_jobguard） */
export function report() {
  return available()
    ? '子进程连坐: 已启用（进程组 + 看门进程；WebTmux 被强杀时执行者整组终止）'
    : '⚠ 子进程连坐: 不可用 —— WebTmux 被强杀后执行者会脱管续跑，需手动清理';
}

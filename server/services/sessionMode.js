/**
 * 会话运行模式（纯函数）
 *
 * 长程任务是会话条目的一种运行模式：runMode = 'longrun' 时 tmux 里只有 shell，由服务端长程编排驱动。
 * 这时 AI 监控、自动操作、30 秒项目信息刷新都**不能碰它** —— 它们会把空 shell 当成"CLI 退出了"
 * 去发 `claude -c`，或把 goal/工作目录改掉。
 */

import { existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { isPathWithin } from './pathBoundary.js';

/** @param {{runMode?: string}} session */
export function isLongRunMode(session) {
  return session?.runMode === 'longrun';
}

/** 工作目录恰好是 dir 的会话（不含子目录；尾斜杠不影响）。 */
export function sessionsInDir(sessions, dir) {
  return (sessions || []).filter((s) => s?.workingDir && isPathWithin(s.workingDir, dir) && isPathWithin(dir, s.workingDir));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Claude 把某工作目录下的对话记录存在 ~/.claude/projects/<目录编码>/<会话id>.jsonl（编码：非字母数字一律换成 -） */
export function claudeTranscriptPath(workingDir, id, home = os.homedir()) {
  return path.join(home, '.claude', 'projects', String(workingDir || '').replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
}

/**
 * 重启/续接 claude 用的命令：有记录的对话 id、且这段对话的记录文件还在，就 `claude --resume <id>` 精确接回；
 * 否则 `claude -c`（CLI 自己挑这个目录下最近的对话）。
 *
 * 为什么不再只对「来自长程」的条目这么做（2026-09-26 Hitech）：`claude -c` 会**跳过由 `claude -p` 开出来的对话**。
 * 长程转终端后接着用的那段对话（58215909，开头 32 条是长程执行者写的）因此被跳过，重启后接回的是 9 月 18 日
 * 转长程之前的旧对话 —— 看起来像「恢复到长程的历史记录」。只认 origin=longrun 标记也不够：条目转过来的路径不同，
 * 标记不一定在。会话记录的 id 由 hook 实时更新（每次调工具、每轮结束都写，/clear、换对话后也跟着变），比 CLI 猜的准。
 *
 * @param {{claudeSessionId?:string, workingDir?:string}} session
 * @param {string} fallback  非 claude 的 CLI 传它自己的续接命令
 * @param {{exists?: (p:string)=>boolean, home?: string}} [deps] 测试注入
 */
export function claudeStartCommand(session, fallback = 'claude -c', { exists = existsSync, home } = {}) {
  const id = session?.claudeSessionId;
  if (typeof id !== 'string' || !UUID_RE.test(id)) return fallback;
  if (!/^claude\b/.test(fallback)) return fallback;   // grok/codex 等不适用 claude 的 --resume
  // 工作目录不知道时按原行为（来自长程的条目仍信任 id：长程目录的对话一定在）
  if (!session.workingDir) return session.origin === 'longrun' ? `claude --resume ${id}` : fallback;
  return exists(claudeTranscriptPath(session.workingDir, id, home)) ? `claude --resume ${id}` : fallback;
}

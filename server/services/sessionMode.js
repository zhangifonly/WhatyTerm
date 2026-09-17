/**
 * 会话运行模式（纯函数）
 *
 * 长程任务是会话条目的一种运行模式：runMode = 'longrun' 时 tmux 里只有 shell，由服务端长程编排驱动。
 * 这时 AI 监控、自动操作、30 秒项目信息刷新都**不能碰它** —— 它们会把空 shell 当成"CLI 退出了"
 * 去发 `claude -c`，或把 goal/工作目录改掉。
 */

import { isPathWithin } from './pathBoundary.js';

/** @param {{runMode?: string}} session */
export function isLongRunMode(session) {
  return session?.runMode === 'longrun';
}

/** 工作目录恰好是 dir 的会话（不含子目录；尾斜杠不影响）。 */
export function sessionsInDir(sessions, dir) {
  return (sessions || []).filter((s) => s?.workingDir && isPathWithin(s.workingDir, dir) && isPathWithin(dir, s.workingDir));
}

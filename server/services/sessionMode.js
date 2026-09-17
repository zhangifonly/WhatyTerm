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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 重启/续接 claude 用的命令。来自长程的条目（origin=longrun）且有 claude 会话 id 时用 `claude --resume <id>`：
 * 长程执行者的 `claude -p` 会话不进 history 索引，`claude -c` 找不到它（转为终端后首次 resume 的会话同理）。
 * 其余会话维持原行为。
 */
export function claudeStartCommand(session, fallback = 'claude -c') {
  const id = session?.claudeSessionId;
  return session?.origin === 'longrun' && typeof id === 'string' && UUID_RE.test(id) ? `claude --resume ${id}` : fallback;
}

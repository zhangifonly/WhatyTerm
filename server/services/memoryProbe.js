/**
 * 会话的 Auto Memory 目录与「收尾之后记忆到底写了没有」（给上下文水位交接用）。
 *
 * 为什么不再只看屏幕上的回复措辞（2026-09-26）：旧判据是「回复里有完成式的写记忆措辞，或已经空闲 3 轮」。
 * 收尾指令一次都没进输入框的会话，照样在 3 个空闲轮后被判「记忆已写完」、接着发 /compact ——
 * 这正是交接最该防的事：什么都没记下就把上下文压掉。现在要求**磁盘上的记忆文件真的在收尾之后被改过**。
 *
 * 目录：项目 .claude/settings.local.json 的 autoMemoryDirectory（长程共用记忆时会这样设）优先，
 * 否则 Claude Code 默认的 ~/.claude/projects/<工作目录编码>/memory/。
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import os from 'os';
import path from 'path';

const encodeCwd = (cwd) => String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');

/** 这个工作目录的 Auto Memory 目录（不保证存在） */
export function memoryDirFor(workingDir, home = os.homedir()) {
  try {
    const ls = JSON.parse(readFileSync(path.join(workingDir, '.claude', 'settings.local.json'), 'utf8'));
    if (typeof ls.autoMemoryDirectory === 'string' && ls.autoMemoryDirectory) {
      return path.isAbsolute(ls.autoMemoryDirectory) ? ls.autoMemoryDirectory : path.join(workingDir, ls.autoMemoryDirectory);
    }
  } catch { /* 没有项目配置 */ }
  return path.join(home, '.claude', 'projects', encodeCwd(workingDir), 'memory');
}

/** 记忆目录里 .md 文件的 {文件名: 修改时间}；目录不存在返回 {} */
export function memorySnapshot(dir) {
  const out = {};
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.md')) continue;
      try { out[name] = statSync(path.join(dir, name)).mtimeMs; } catch { /* 刚被删 */ }
    }
  } catch { /* 目录还不存在：第一次写记忆时 CLI 会建 */ }
  return out;
}

/**
 * 与收尾时的快照相比，哪些记忆文件被新建或改过。
 * @returns {string[]} 变化的文件名（空数组 = 一个字都没写）
 */
export function memoryChangedSince(before, after) {
  return Object.keys(after).filter((n) => !(n in (before || {})) || after[n] > before[n]).sort();
}

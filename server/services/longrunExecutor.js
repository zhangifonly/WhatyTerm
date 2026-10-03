/**
 * 长程执行者的选择：Claude Code（默认）或 Cursor CLI。监督者始终是 Claude（经 claude CLI），只换干活的那个。
 *
 * 提示词按执行者改写：原版提示词是围着 Claude Code 的 Auto Memory 写的（第一句就是「确认自动记忆库开启，
 * 没开就停下来」）。Cursor 没有这个功能，原样发过去它会照字面停下等人。沙箱给 Claude 配的 autoMemoryDirectory
 * 就是项目里的 `.memory/`，所以改写成「读写 .memory/ 目录」——两种执行者用的是同一份记忆，中途换执行者也接得上。
 * 规则文件同理：Cursor 读 AGENTS.md 与 .cursor/rules，不读 .claude/rules。
 */

import { LongRunRunner } from './LongRunRunner.js';
import { LongRunCursorRunner } from './LongRunCursorRunner.js';

export const EXECUTORS = ['claude', 'cursor'];
export const normalizeExecutor = (v) => (EXECUTORS.includes(v) ? v : 'claude');

/** 执行者工厂（Loop 的 runnerFactory） */
export function runnerFactoryFor(executor) {
  return executor === 'cursor' ? (opts) => new LongRunCursorRunner(opts) : (opts) => new LongRunRunner(opts);
}

const MEMORY_DIR = '项目根目录下的 `.memory/` 目录（索引文件是 `.memory/MEMORY.md`）';

/** 把一段为 Claude Code 写的提示词改成 Cursor 能照做的（纯函数） */
export function adaptPromptForCursor(text) {
  return String(text || '')
    // 「确认自动记忆库开启，没开就停」→ 记忆库就是一个目录，没有就建
    .replace(/帮我确认本项目的自动记忆库处于开启状态[^\n]*/g, `本项目的记忆库是${MEMORY_DIR}，没有就创建它。`)
    .replace(/确认开启后，/g, '')
    .replace(/(?<![/`.])MEMORY\.md/g, '`.memory/MEMORY.md`')
    .replace(/Auto Memory/g, '记忆库（`.memory/`）')
    .replace(/CLAUDE\.md 或合适的 `\.claude\/rules` 文件/g, 'AGENTS.md 或合适的 `.cursor/rules` 文件')
    .replace(/CLAUDE\.md/g, 'AGENTS.md');
}

/** 整套提示词按执行者改写；Claude 原样返回 */
export function promptsFor(executor, prompts) {
  if (executor !== 'cursor' || !prompts) return prompts;
  const out = { ...prompts };
  for (const [k, v] of Object.entries(prompts)) if (typeof v === 'string' && k !== 'source') out[k] = adaptPromptForCursor(v);
  return out;
}

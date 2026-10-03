/**
 * 长程执行者的选择：Claude Code（默认）、Cursor CLI、Kiro CLI、OpenCode。监督者始终是 Claude（经 claude CLI），只换干活的那个。
 *
 * 提示词按执行者改写：原版提示词是围着 Claude Code 的 Auto Memory 写的（第一句就是「确认自动记忆库开启，
 * 没开就停下来」）。别的 CLI 没有这个功能，原样发过去它会照字面停下等人。沙箱给 Claude 配的 autoMemoryDirectory
 * 就是项目里的 `.memory/`，所以改写成「读写 .memory/ 目录」——几种执行者用的是同一份记忆，中途换执行者也接得上。
 * 规则文件按各 CLI 自己读的位置写（Claude 读 CLAUDE.md 与 .claude/rules）。
 */

import { LongRunRunner } from './LongRunRunner.js';
import { LongRunCursorRunner } from './LongRunCursorRunner.js';
import { LongRunKiroRunner } from './LongRunKiroRunner.js';
import { LongRunOpencodeRunner } from './LongRunOpencodeRunner.js';

/**
 * 各执行者的特性（界面说明、自检、服务端校验都从这里取，不各写一份）：
 *   billing   计费口径：usd 按美元记账、预算刹车生效；credits / subscription 不记美元
 *   context   能不能拿到运行中水位（拿不到就不做水位交接）
 *   rules     项目规则文件写在哪（给「定期维护提示词2」用）
 */
export const EXECUTORS = {
  claude: { label: 'Claude Code', billing: 'usd', context: true, rules: null },
  cursor: { label: 'Cursor CLI', billing: 'subscription', context: false, rules: 'AGENTS.md 或合适的 `.cursor/rules` 文件' },
  kiro: { label: 'Kiro CLI', billing: 'credits', context: true, rules: 'AGENTS.md 或 `.kiro/steering/` 下合适的文件' },
  opencode: { label: 'OpenCode', billing: 'usd', context: true, rules: 'AGENTS.md' },
};
export const normalizeExecutor = (v) => (Object.hasOwn(EXECUTORS, v) ? v : 'claude');

const RUNNERS = { claude: LongRunRunner, cursor: LongRunCursorRunner, kiro: LongRunKiroRunner, opencode: LongRunOpencodeRunner };

/** 执行者工厂（Loop 的 runnerFactory）。extra 是执行者专属参数：Kiro 的 contextWindow、OpenCode 的 opencodeConfig 等 */
export function runnerFactoryFor(executor, extra = {}) {
  const R = RUNNERS[normalizeExecutor(executor)];
  return (opts) => new R({ ...opts, ...extra });
}

const MEMORY_DIR = '项目根目录下的 `.memory/` 目录（索引文件是 `.memory/MEMORY.md`）';

/** 把一段为 Claude Code 写的提示词改成别的 CLI 能照做的（纯函数）。rules：规则文件该写到哪 */
export function adaptPromptForExecutor(text, rules = 'AGENTS.md') {
  return String(text || '')
    // 「确认自动记忆库开启，没开就停」→ 记忆库就是一个目录，没有就建
    .replace(/帮我确认本项目的自动记忆库处于开启状态[^\n]*/g, `本项目的记忆库是${MEMORY_DIR}，没有就创建它。`)
    .replace(/确认开启后，/g, '')
    .replace(/(?<![/`.])MEMORY\.md/g, '`.memory/MEMORY.md`')
    .replace(/Auto Memory/g, '记忆库（`.memory/`）')
    .replace(/CLAUDE\.md 或合适的 `\.claude\/rules` 文件/g, rules)
    .replace(/CLAUDE\.md/g, 'AGENTS.md');
}

/** 整套提示词按执行者改写；Claude 原样返回 */
export function promptsFor(executor, prompts) {
  const ex = EXECUTORS[normalizeExecutor(executor)];
  if (!ex.rules || !prompts) return prompts;
  const out = { ...prompts };
  for (const [k, v] of Object.entries(prompts)) if (typeof v === 'string' && k !== 'source') out[k] = adaptPromptForExecutor(v, ex.rules);
  return out;
}

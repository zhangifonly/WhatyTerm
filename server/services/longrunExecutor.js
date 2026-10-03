/**
 * 长程执行者的选择：Claude Code（默认）、Codex、Cursor CLI、Kiro CLI、OpenCode。监督者跟着执行者走：选了哪个 CLI，监督者也用它自己（见 LongRunSupervisorCreds.makeSupervisorChannel）。
 *
 * 提示词按执行者改写：原版提示词是围着 Claude Code 的 Auto Memory 写的（第一句就是「确认自动记忆库开启，
 * 没开就停下来」）。别的 CLI 没有这个功能，原样发过去它会照字面停下等人。沙箱给 Claude 配的 autoMemoryDirectory
 * 就是项目里的 `.memory/`，所以改写成「读写 .memory/ 目录」——几种执行者用的是同一份记忆，中途换执行者也接得上。
 * 规则文件按各 CLI 自己读的位置写（Claude 读 CLAUDE.md 与 .claude/rules）。
 */

import { existsSync } from 'fs';
import path from 'path';
import { LongRunRunner } from './LongRunRunner.js';
import { LongRunCursorRunner } from './LongRunCursorRunner.js';
import { LongRunKiroRunner } from './LongRunKiroRunner.js';
import { LongRunOpencodeRunner } from './LongRunOpencodeRunner.js';
import { LongRunCodexRunner } from './LongRunCodexRunner.js';

/**
 * 各执行者的特性（界面说明、自检、服务端校验都从这里取，不各写一份）：
 *   billing   计费口径：usd 按美元记账、预算刹车生效；credits / subscription 不记美元
 *   context   能不能拿到运行中水位（拿不到就不做水位交接）
 *   rules     项目规则文件写在哪（给「定期维护提示词2」用）
 */
export const EXECUTORS = {
  claude: { label: 'Claude Code', billing: 'usd', context: true, rules: null },
  codex: { label: 'Codex', billing: 'usd', context: true, rules: 'AGENTS.md' },
  cursor: { label: 'Cursor CLI', billing: 'subscription', context: false, rules: 'AGENTS.md 或合适的 `.cursor/rules` 文件' },
  kiro: { label: 'Kiro CLI', billing: 'credits', context: true, rules: 'AGENTS.md 或 `.kiro/steering/` 下合适的文件' },
  opencode: { label: 'OpenCode', billing: 'usd', context: true, rules: 'AGENTS.md' },
};
export const normalizeExecutor = (v) => (Object.hasOwn(EXECUTORS, v) ? v : 'claude');

const RUNNERS = { claude: LongRunRunner, codex: LongRunCodexRunner, cursor: LongRunCursorRunner, kiro: LongRunKiroRunner, opencode: LongRunOpencodeRunner };

/** 执行者工厂（Loop 的 runnerFactory）。extra 是执行者专属参数：Kiro 的 contextWindow、OpenCode 的 opencodeConfig 等 */
export function runnerFactoryFor(executor, extra = {}) {
  const R = RUNNERS[normalizeExecutor(executor)];
  return (opts) => new R({ ...opts, ...extra });
}

const MEMORY_DIR = '项目根目录下的 `.memory/` 目录（索引文件是 `.memory/MEMORY.md`）';

/**
 * 把一段为 Claude Code 写的提示词改成别的 CLI 能照做的（纯函数）。
 * @param {string} rules     「规则写到哪」那一处换成什么
 * @param {string} mainFile  其余提到 CLAUDE.md 的地方换成什么（项目只有 CLAUDE.md 且执行者读得到它时就保留 CLAUDE.md）
 */
export function adaptPromptForExecutor(text, rules = 'AGENTS.md', mainFile = 'AGENTS.md') {
  const SLOT = '\u0001';   // 先占位：rules 里本身可能含 CLAUDE.md，不能被下面的全局替换再改一遍
  return String(text || '')
    // 「确认自动记忆库开启，没开就停」→ 记忆库就是一个目录，没有就建
    .replace(/帮我确认本项目的自动记忆库处于开启状态[^\n]*/g, `本项目的记忆库是${MEMORY_DIR}，没有就创建它。`)
    .replace(/确认开启后，/g, '')
    .replace(/(?<![/`.])MEMORY\.md/g, '`.memory/MEMORY.md`')
    .replace(/Auto Memory/g, '记忆库（`.memory/`）')
    .replace(/CLAUDE\.md 或合适的 `\.claude\/rules` 文件/g, SLOT)
    .replace(/CLAUDE\.md/g, mainFile)
    .replace(new RegExp(SLOT, 'g'), rules);
}

/**
 * 项目规则只留一份，两边都读得到（换执行者时不分叉）：
 *   · Claude Code 2.1.277 起，项目里没有 CLAUDE.md 时会读 AGENTS.md
 *   · Codex 配 project_doc_fallback_filenames=["CLAUDE.md"] 后，没有 AGENTS.md 时会读 CLAUDE.md（执行者每次调用都带上，见 LongRunCodexRunner）
 * 所以：项目里已经有哪一份就一直往哪一份写，别新建另一份 —— 新建出来的那份会把原来那份遮住
 * （有 CLAUDE.md 时 Claude 不再看 AGENTS.md；有 AGENTS.md 时 Codex 不再看 CLAUDE.md）。
 * @returns {'CLAUDE.md'|'AGENTS.md'|null} 只有一份时返回它；两份都有或都没有返回 null（按执行者默认）
 */
export function sharedRulesFile(root, exists = existsSync) {
  if (!root) return null;
  const c = exists(path.join(root, 'CLAUDE.md')), a = exists(path.join(root, 'AGENTS.md'));
  return c && !a ? 'CLAUDE.md' : a && !c ? 'AGENTS.md' : null;
}

/** 整套提示词按执行者改写。root 给了就按项目里已有的规则文件定写到哪（见 sharedRulesFile） */
export function promptsFor(executor, prompts, { root = '', exists = existsSync } = {}) {
  const name = normalizeExecutor(executor);
  const ex = EXECUTORS[name];
  if (!prompts) return prompts;
  const shared = sharedRulesFile(root, exists);
  const out = { ...prompts };
  if (!ex.rules) {
    // Claude 原样，只有一种例外：项目里只有 AGENTS.md（别的执行者建的），规则就接着写进 AGENTS.md，别新建 CLAUDE.md 把它遮住
    if (shared !== 'AGENTS.md') return prompts;
    for (const [k, v] of Object.entries(prompts)) if (typeof v === 'string' && k !== 'source') out[k] = v.replace(/CLAUDE\.md/g, 'AGENTS.md');
    return out;
  }
  // Codex 读得到 CLAUDE.md（带了回退配置）：项目只有 CLAUDE.md 时就一直写它
  const keepClaude = name === 'codex' && shared === 'CLAUDE.md';
  const rules = keepClaude ? 'CLAUDE.md（这个项目的规则文件，Claude 与 Codex 共用）' : ex.rules;
  for (const [k, v] of Object.entries(prompts)) {
    if (typeof v === 'string' && k !== 'source') out[k] = adaptPromptForExecutor(v, rules, keepClaude ? 'CLAUDE.md' : 'AGENTS.md');
  }
  return out;
}

/**
 * 换执行者续跑时，接在新需求前面的交接说明：之前谁做的、进度在哪、规则在哪。
 * 上一轮用的执行者记在 .run/executor.json（每次开跑写）。没换人返回空串。
 */
export function switchNote(prev, cur, root, exists = existsSync) {
  if (!prev || normalizeExecutor(prev) === normalizeExecutor(cur)) return '';
  const label = (x) => EXECUTORS[normalizeExecutor(x)].label;
  const rules = ['CLAUDE.md', 'AGENTS.md'].filter((f) => root && exists(path.join(root, f)));
  return [
    `【换执行者】这个项目之前由 ${label(prev)} 开发，现在改由 ${label(cur)} 接着做。`,
    '之前的进度、结论、做过的决定都在 `.memory/`（先读 `.memory/MEMORY.md`），以它为准，不要从头重来。',
    rules.length ? `项目规则在 ${rules.join('、')}：不管当初是写给哪个工具的，都照着遵守；以后新增规则也写进这份，不要另建一份。` : '',
  ].filter(Boolean).join('\n');
}

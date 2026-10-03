/**
 * 普通会话换 CLI 接着开发（Claude Code ⇄ Codex）：纯逻辑部分。流程在 index.js 的 session:switchCli。
 *
 * 做法与长程换执行者同一套（业界叫「会话交接」）：换人前让手上有上下文的那个先写交接，新的照着接上。
 *   ① 等当前 CLI 闲下来，发交接指令：写记忆 + 在回复里给出交接摘要
 *   ② 等它答完（Claude 看屏幕上的回复、复用水位交接的「记忆写完了」判据；Codex 读它 rollout 里的 task_complete）
 *   ③ 退出当前 CLI，在同一个窗格里起新的 CLI（新对话），把交接摘要作为第一句发过去
 * 规则文件：Codex 起的时候带 project_doc_fallback_filenames=["CLAUDE.md"]；Claude 起的时候带「两个都读」的设置文件。
 *
 * Codex 屏幕（codex-cli 0.160.0 实抓，tests/fixtures/screens/codex-*）：
 *   空闲  「› Ask Codex to do anything」（占位文字是暗色 \x1b[2m）+「? for shortcuts」
 *   草稿  「› hello draft」（不是暗色）
 *   运行  「• Working (3s • esc to interrupt)」，输入框照样显示占位文字
 *   信任  「Trust this folder? … › 1. Trust and continue / 2. Quit」
 */

import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync, mkdirSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

export const SWITCHABLE = { claude: 'Claude Code', codex: 'Codex' };
export const SWITCH_REPLY_WAIT_MS = 5 * 60 * 1000;
export const SWITCH_READY_WAIT_MS = 3 * 60 * 1000;   // 新 CLI 起来可能要人确认信任目录，多给些时间

const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;
const strip = (s) => String(s || '').replace(ANSI, '');
const tailLines = (s, n) => strip(s).split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-n);

/** Codex 输入框那一行（带色码的原文）：最后一个以「›」开头的行 */
function codexPromptLine(raw) {
  const lines = String(raw || '').split('\n').filter((l) => /^\s*(\x1b\[[0-9;]*m)*›/.test(l));
  return lines.at(-1) || '';
}

/** Codex 输入框里有没有没发出去的字：占位文字是暗色，真草稿不是。没色码时按常见占位文字兜底 */
export function codexPendingText(raw) {
  const line = codexPromptLine(raw);
  if (!line) return '';
  const after = line.replace(/^\s*(\x1b\[[0-9;]*m)*›(\x1b\[[0-9;]*m)*\s?/, '');
  if (/^\x1b\[2m/.test(after)) return '';                       // 暗色 = 占位
  const text = strip(after).trim();
  if (!/\x1b\[/.test(line) && /^(Ask Codex to do anything|Explain this codebase|Find and fix a bug|Summarize recent commits|Implement \{feature\}|Write tests for)/i.test(text)) return '';
  return text;
}

/** Codex 能接收输入：有输入框、有「? for shortcuts」、不在跑（没有 esc to interrupt） */
export function isCodexInputReady(raw) {
  const tail = tailLines(raw, 12).join('\n');
  return /^\s*›/m.test(tail) && /\? for shortcuts/.test(tail) && !/esc to interrupt/i.test(tail) && !isTrustPrompt(raw);
}

/** 新起的 CLI 在问是否信任这个目录（Codex / Claude 两种措辞）。这是人的决定，不替人点 */
export function isTrustPrompt(raw) {
  const t = tailLines(raw, 20).join('\n');
  return /Trust this folder\?[\s\S]*Trust and continue/i.test(t) || /Do you trust the files in this folder|Is this a project you created or one you trust|Yes, I trust this folder/i.test(t);
}

/** 交接指令：写记忆 + 回复里给出交接摘要（摘要会原样转给下一个 CLI） */
export function switchHandoffPrompt(from, to) {
  const memory = from === 'claude'
    ? '先把跨会话仍有价值的内容同步进 Auto Memory（规则同平时：能更新旧记录就不新增，密钥一律不写）。'
    : '';
  return [
    `接下来要换成 ${SWITCHABLE[to]} 接着开发这个项目，你这一段先收尾。`,
    memory,
    `然后在回复里写一份交接摘要（会原样转给 ${SWITCHABLE[to]}，它看不到我们这段对话）：`,
    '- 当前任务进行到哪里', '- 已经确认的结论、做过的重要决定及原因', '- 尝试过但失败的方案，以及失败原因',
    '- 修改了哪些关键文件', '- 当前测试结果', '- 尚未解决的风险或问题', '- 下一步最具体的行动',
    from === 'claude' ? '最后说明：更新了哪些记忆文件；下一会话应该从哪一项开始。' : '最后说明：下一会话应该从哪一项开始。',
    '这一步只做收尾和交接，不要继续写代码。',
  ].filter(Boolean).join('\n');
}

/** 发给新 CLI 的第一句：说明换了人、附交接摘要、规则与记忆在哪 */
export function switchFirstMessage({ from, to, receipt, rulesFiles = [], memoryDir = '' }) {
  return [
    `【换工具接着开发】这个项目刚才由 ${SWITCHABLE[from]} 开发，现在换成你（${SWITCHABLE[to]}）接着做。`,
    `下面是 ${SWITCHABLE[from]} 留下的交接摘要。先按摘要核对现状（看代码、git log、跑测试），再从「下一步」接着做；摘要里没写到的，不要凭印象猜。`,
    rulesFiles.length ? `项目规则在 ${rulesFiles.join('、')}：不管当初是写给哪个工具的，都照着遵守；以后新增规则也写进这份，不要另建一份。` : '',
    memoryDir ? `${SWITCHABLE[from]} 的记忆在 ${memoryDir}（MEMORY.md 是索引），需要细节时可以读。` : '',
    '', '---', '', String(receipt || '').trim() || `（${SWITCHABLE[from]} 没给出交接摘要：请从代码与 git log 自行确认进度）`,
  ].filter((l, i, a) => l || a[i - 1]).join('\n');
}

/** Claude Auto Memory 的目录：项目配置里指定了就用它，否则是 ~/.claude/projects/<编码后的目录>/memory */
export function claudeMemoryDir(cwd, home = os.homedir()) {
  try {
    const ls = JSON.parse(readFileSync(path.join(cwd, '.claude', 'settings.local.json'), 'utf8'));
    if (ls.autoMemoryDirectory) return ls.autoMemoryDirectory;
  } catch { /* 没有项目配置 */ }
  const dir = path.join(home, '.claude', 'projects', String(cwd).replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
  return existsSync(dir) ? dir : '';
}

/** Claude 「两个规则文件都读」的设置文件（经 --settings 传入，只作用于这次起的 claude，不改用户设置） */
export function ensureBothRulesSettings(home = os.homedir()) {
  const file = path.join(home, '.webtmux', 'claude-agents-md-both.json');
  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ pluginConfigs: { 'agents-md@builtin': { options: { instructionFiles: 'claude-md-and-agents-md' } } } }, null, 2) + '\n');
  }
  return file;
}

/** rollout 第一行的 session_meta.cwd */
function rolloutCwd(file) {
  // 首行 session_meta 带着整份系统指令，几十 KB 很常见：分块读到第一个换行为止（上限 4MB）
  let fd = null;
  try {
    fd = openSync(file, 'r');
    const chunks = [];
    for (let pos = 0; pos < 4 * 1024 * 1024;) {
      const buf = Buffer.alloc(256 * 1024);
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (!n) break;
      const nl = buf.subarray(0, n).indexOf(10);
      if (nl >= 0) { chunks.push(buf.subarray(0, nl)); break; }
      chunks.push(buf.subarray(0, n)); pos += n;
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))?.payload?.cwd || '';
  } catch { return ''; } finally { if (fd != null) try { closeSync(fd); } catch { /* 忽略 */ } }
}

/**
 * 某目录里的交互式 Codex 在 sinceMs 之后答完的那一轮：读最近改过的 rollout 里的 task_complete（带 last_agent_message）。
 * 比从屏幕上抠可靠：长回复会滚出屏幕，屏幕上还夹着工具输出。
 * @returns {{done: boolean, text: string, file: string}}
 */
export function codexTurnSince(cwd, sinceMs, home = path.join(os.homedir(), '.codex')) {
  const root = path.join(home, 'sessions');
  // rollout 按本地日期分目录：开始时与现在可能跨零点，两天都看
  const dayDir = (ms) => { const d = new Date(ms); return path.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')); };
  const dirs = [...new Set([dayDir(Date.now()), dayDir(sinceMs)])];
  const files = dirs.flatMap((d) => { try { return readdirSync(d).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(d, f)); } catch { return []; } })
    .map((f) => ({ f, t: (() => { try { return statSync(f).mtimeMs; } catch { return 0; } })() }))
    .filter((x) => x.t >= sinceMs).sort((a, b) => b.t - a.t);
  for (const { f } of files) {
    if (rolloutCwd(f) !== cwd) continue;
    let text = '', done = false;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.includes('"task_complete"')) continue;
      let d; try { d = JSON.parse(line); } catch { continue; }
      if (d.payload?.type !== 'task_complete' || Date.parse(d.timestamp) < sinceMs) continue;
      done = true; text = String(d.payload.last_agent_message || '');
    }
    if (done) return { done, text, file: f };
  }
  return { done: false, text: '', file: '' };
}

/**
 * 某目录里的交互式 Claude 在 sinceMs 之后答完的那一轮：读 ~/.claude/projects/<编码目录>/*.jsonl。
 * 结束的标志是 system/turn_duration；回复取这一轮里 stop_reason=end_turn 的文字块。
 * 不从屏幕抠：2026-10-04 实测屏幕上的「最后一段回复」会把刚发的指令回显和「Germinating…」当成回复，
 * 交接还没开始写就被判成写完，Codex 拿到的是空摘要。
 * @returns {{done: boolean, text: string, file: string}}
 */
export function claudeTurnSince(cwd, sinceMs, home = os.homedir()) {
  const dir = path.join(home, '.claude', 'projects', String(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f)); } catch { return { done: false, text: '', file: '' }; }
  files = files.map((f) => ({ f, t: (() => { try { return statSync(f).mtimeMs; } catch { return 0; } })() }))
    .filter((x) => x.t >= sinceMs).sort((a, b) => b.t - a.t).map((x) => x.f);
  for (const f of files) {
    let texts = [], done = false, asked = false;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line) continue;
      let d; try { d = JSON.parse(line); } catch { continue; }
      if (Date.parse(d.timestamp || 0) < sinceMs) continue;
      if (d.type === 'user' && !(Array.isArray(d.message?.content) && d.message.content.every((b) => b?.type === 'tool_result'))) {
        asked = true; texts = []; done = false;       // 新的一轮从人发的话开始
      } else if (asked && d.type === 'assistant' && d.message?.stop_reason === 'end_turn') {
        for (const b of d.message.content || []) if (b?.type === 'text' && String(b.text).trim()) texts.push(b.text);
      } else if (asked && d.type === 'system' && d.subtype === 'turn_duration') {
        done = true;
      }
    }
    if (done) return { done, text: texts.join('\n\n'), file: f };
  }
  return { done: false, text: '', file: '' };
}

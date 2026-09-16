/**
 * 长程编排：提示词加载 —— 回归测试
 *
 * ⚠ 这个文件锁的是「提示词一字不改」这条铁律。
 * 长程编排器的核心取舍是**不干涉执行者**：发出去的每一段都是 提示词.txt 里的原文，
 * 编排器"顺手补一句"会改变执行者的行为，而那种改变很难察觉。
 *
 * test_session_loop.py 里 case_prompts_verbatim / case_wrapup_and_resume_verbatim /
 * case_continue_is_exact 三条验的是「发出时是原文」，需要 loop + StubRunner（步骤 3）。
 * 这里先锁它们的前置条件：**加载出来的就是文件原文**，以及 CONTINUE 那一句不被改。
 *
 * 运行: node tests/test-longrun-prompts.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  loadPrompts, PROMPT_SLOTS, CONTINUE_PROMPT, PromptError,
} from '../server/services/LongRunPrompts.js';

const results = { passed: 0, failed: 0, errors: [] };
const pending = [];

function test(name, fn) {
  const p = (async () => {
    try { await fn(); results.passed++; console.log(`✅ ${name}`); }
    catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
  })();
  pending.push(p);
  return p;
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 随编排器一起复制进仓库的提示词原文（server/prompts/longrun/提示词.txt） */
const REAL_FILE = path.join(HERE, '..', 'server', 'prompts', 'longrun', '提示词.txt');
const TMP = path.join(os.tmpdir(), 'longrun_prompt_test');

function freshTmp() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  return TMP;
}
function writeDoc(name, text) {
  const p = path.join(freshTmp(), name);
  fs.writeFileSync(p, text, 'utf8');
  return p;
}

// ── 真实提示词文件：五段齐全且是原文 ──────────────────────────
test('真实 提示词.txt 五段齐全', () => {
  const p = loadPrompts(REAL_FILE);
  for (const slot of Object.keys(PROMPT_SLOTS)) {
    assert(typeof p[slot] === 'string' && p[slot].length > 0, `缺少 ${slot}（${PROMPT_SLOTS[slot]}）`);
  }
  assert(p.source === path.resolve(REAL_FILE), 'source 应是绝对路径');
});

test('加载出的每一段都能在原文里逐字找到（不被改写、不被拼接）', () => {
  // ⚠ 提示词文件是 CRLF。比较前把原文归一成 LF —— Python 的 read_text 默认开启
  //    universal newlines，同样把 CRLF 变 LF，所以原编排器发给执行者的也是 LF 版。
  //    这里归一是为了对齐口径，不是放宽断言：内容本身仍要求逐字一致。
  const raw = fs.readFileSync(REAL_FILE, 'utf8').replace(/\r\n/g, '\n');
  const p = loadPrompts(REAL_FILE);
  for (const [slot, keyword] of Object.entries(PROMPT_SLOTS)) {
    assert(raw.includes(p[slot]),
      `${slot}（${keyword}）的内容在原文里找不到 —— 说明加载时被改动了`);
  }
});

test('五段互不相同（标题匹配没有串段）', () => {
  const p = loadPrompts(REAL_FILE);
  const bodies = Object.keys(PROMPT_SLOTS).map((s) => p[s]);
  assert(new Set(bodies).size === bodies.length, '有两段内容相同，说明关键词匹配串了');
});

// ── CONTINUE 那一句不许加料 ──────────────────────────────────
// 对译 case_continue_is_exact 的常量部分：发出时的校验等 loop 到位后补。
test('催继续恰好是「继续完成项目」，无附加内容', () => {
  assert(CONTINUE_PROMPT === '继续完成项目', `催继续的话被改了: ${JSON.stringify(CONTINUE_PROMPT)}`);
});

// ── 容错：编号与措辞微调都要能命中 ────────────────────────────
test('标题带编号（1. / 1、）也能命中', () => {
  const body = Object.entries(PROMPT_SLOTS)
    .map(([, kw], i) => `## ${i + 1}. ${kw}\n\n正文-${kw}\n`).join('\n');
  const p = loadPrompts(writeDoc('带编号.txt', body));
  assert(p.init === '正文-初始化提示词', `编号未被剥离: ${JSON.stringify(p.init)}`);

  const body2 = Object.entries(PROMPT_SLOTS)
    .map(([, kw], i) => `## ${i + 1}、${kw}\n\n正文2-${kw}\n`).join('\n');
  const p2 = loadPrompts(writeDoc('顿号编号.txt', body2));
  assert(p2.maintain_2 === '正文2-定期维护提示词2', `顿号编号未剥离: ${JSON.stringify(p2.maintain_2)}`);
});

// ── 硬失败：缺段/空文件/文件不存在都不许降级 ──────────────────
test('缺任何一段都拒绝启动（不降级、不用默认值）', () => {
  const partial = ['初始化提示词', '旧对话收尾提示词']
    .map((kw) => `## ${kw}\n\n正文\n`).join('\n');
  let threw = null;
  try { loadPrompts(writeDoc('缺段.txt', partial)); } catch (e) { threw = e; }
  assert(threw instanceof PromptError, '缺段应抛 PromptError');
  assert(threw.message.includes('新对话开始提示词'), `报错要指名缺哪段: ${threw.message}`);
  assert(threw.message.includes('已找到的段落'), '报错要列出已找到的段落，便于排查');
});

test('没有 ## 段落时报格式错', () => {
  let threw = null;
  try { loadPrompts(writeDoc('无标题.txt', '这里全是正文，没有任何标题。\n')); }
  catch (e) { threw = e; }
  assert(threw instanceof PromptError, '应抛 PromptError');
  assert(threw.message.includes('## 标题'), `报错要说明格式要求: ${threw.message}`);
});

test('文件不存在时报路径', () => {
  let threw = null;
  try { loadPrompts(path.join(TMP, '不存在.txt')); } catch (e) { threw = e; }
  assert(threw instanceof PromptError, '应抛 PromptError');
  assert(threw.message.includes('不存在'), `报错要说文件不存在: ${threw.message}`);
});

test('标题存在但正文为空的段落不算一段', () => {
  const body = `## 初始化提示词\n\n## 旧对话收尾提示词\n\n正文\n`;
  let threw = null;
  try { loadPrompts(writeDoc('空正文.txt', body)); } catch (e) { threw = e; }
  assert(threw instanceof PromptError, '空正文的段落应视为缺段');
  assert(threw.message.includes('初始化提示词'), `应指出初始化那段是空的: ${threw.message}`);
});

await Promise.all(pending);
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

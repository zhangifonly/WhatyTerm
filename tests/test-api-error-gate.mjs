/**
 * 「会话污染类 API 错误 → 自动退出、改对话记录、重启」只在 CLI 真报错时触发。
 *
 * 由来（2026-09-26 phyviz）：旧判据在整屏回滚里拼接找关键词，助手正文「Unexpected token '<'」与一千多字后的
 * 「content-type」拼起来命中 `unexpected.*content.*type` → 好好在跑的会话被连续 4 次 /quit、改写、重启。
 * fixture claude-false-api-error.txt：状态栏为真实抓屏，正文已脱敏（保留了触发误判的那几个词）。
 * 真错误原文取自对话记录里的真实报错。
 *
 * 运行: node tests/test-api-error-gate.mjs
 */

import fs from 'fs';
import { classifyApiErrorScreen } from '../server/services/apiErrorGate.js';

let pass = 0, fail = 0;
const queue = [];
// 先入队、最后依次 await：其中有 async 测试，同步 test() 会在它断言之前就记成通过
const test = (name, fn) => queue.push([name, fn]);
const assert = (c, m) => { if (!c) throw new Error(m || '断言失败'); };

const FALSE = fs.readFileSync(new URL('./fixtures/screens/claude-false-api-error.txt', import.meta.url), 'utf8');
const LONG = fs.readFileSync(new URL('./fixtures/screens/whatyterm-81dfe7f2.txt', import.meta.url), 'utf8');
const BAR = '\n────────────────────\n❯ \n────────────────────\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← 6 agents                         ✘ Auto-update failed · Run claude doctor\n';
const errScreen = (line) => `⏺ Bash(npm test)\n  ⎿  ok\n\n⏺ ${line}\n${BAR}`;

test('误报样本：正文里的 Unexpected token … content-type、thinking … invalid block 不算', () => {
  const v = classifyApiErrorScreen(FALSE);
  assert(!v.fixable, `把正在正常工作的会话判成了 API 错误：${JSON.stringify(v)}`);
});

test('反证：旧判据确实会把这份样本判成 API 错误（样本有效，不是空测）', async () => {
  const m = await import('../server/services/ClaudeSessionFixer.js');
  const F = m.default || new m.ClaudeSessionFixer();
  const log = console.log; console.log = () => {};
  try { assert(F.detectApiError(FALSE), '旧判据已不命中 —— 样本失效'); } finally { console.log = log; }
});

test('真实可修复的报错（原文）：签名无效、tool_use_id 对不上、空内容 —— 停在屏幕末尾时判为可修复', () => {
  for (const line of [
    'API Error: 400 messages.13.content.10: Invalid `signature` in `thinking` block',
    'API Error: 400 messages.3.content.0: Invalid `signature` in `thinking` block',
    'API Error: 400 messages: text content blocks must be non-empty',
    'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.5.content.0: unexpected `tool_use_id` found in `tool_result` blocks"}}',
  ]) assert(classifyApiErrorScreen(errScreen(line)).fixable, `真错误没认出来：${line}`);
});

test('真错误折成两行也认得', () => {
  const s = `⏺ API Error: 400 messages.99.content.0: Invalid \`signature\` in\n  \`thinking\` block\n${BAR}`;
  assert(classifyApiErrorScreen(s).fixable);
});

test('改对话记录救不了的 API 错误不触发：连接中断、限流、上下文过长（真实抓屏）', () => {
  for (const line of ['API Error: Connection dropped (ECONNRESET)', 'API Error: 429 rate_limit_error', 'API Error: 529 Overloaded'])
    assert(!classifyApiErrorScreen(errScreen(line)).fixable, line);
  assert(!classifyApiErrorScreen(LONG).fixable, '上下文过长被当成可修复');
});

test('报完错 CLI 又接着输出了（已自己恢复）→ 不触发', () => {
  const s = `⏺ API Error: 400 messages.3.content.0: Invalid \`signature\` in \`thinking\` block\n\n⏺ 重试后继续处理中…\n${BAR}`;
  assert(!classifyApiErrorScreen(s).fixable);
});

const IDX = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
test('接线：检测用新判据；修复流程的 /quit 与「继续」都确认落地；定时改写所有对话记录默认关闭', () => {
  assert(/const apiErrorVerdict = classifyApiErrorScreen\(terminalContent\);\s*const hasApiError = apiErrorVerdict\.fixable;/.test(IDX), '检测没改用新判据');
  assert(!/const hasApiError = claudeSessionFixer\.detectApiError\(/.test(IDX), '旧的整屏关键词判据还在用');
  assert(/sendTextWithLanding\(session, '\/quit'\)/.test(IDX) && /sendTextWithLanding\(session, '继续'\)/.test(IDX), '修复流程的发送没核对落地');
  assert(/if \(process\.env\.WEBTMUX_PROACTIVE_THINKING_SCAN === '1'\) setInterval\(async \(\) => \{\s*const now = Date\.now\(\);\s*if \(now - lastProactiveScanTime/.test(IDX),
    '定时改写所有对话记录没有默认关闭');
});

for (const [name, fn] of queue) {
  try { await fn(); pass++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n    ${e.message}`); }
}
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);

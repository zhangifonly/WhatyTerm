/**
 * CLI 弹出「Enter to continue · Esc to cancel」一次性通知时，监控按 Enter 关掉。
 *
 * 由来（2026-09-26 Hitech）：Claude Code 弹出 auto mode 计费变更通知（写明 Nothing breaks），
 * 监控 163 轮都判「终端状态不明确」不动手，会话停在那里。
 * fixture claude-notice-enter-to-continue.txt：通知原文（网关域名已换成 example），上方对话已脱敏。
 *
 * 运行: node tests/test-cli-notice-enter.mjs
 */

import fs from 'fs';

let pass = 0, fail = 0;
const queue = [];
const test = (name, fn) => queue.push([name, fn]);
const assert = (c, m) => { if (!c) throw new Error(m || '断言失败'); };

const log = console.log; console.log = () => {};
const { AIEngine } = await import('../server/services/AIEngine.js');
const pm = (await import('../server/services/MonitorPlugins/index.js')).default;
await pm.loadBuiltinPlugins();
console.log = log;
const engine = new AIEngine();
engine.detectRunningCLI = () => 'claude';
const analyze = (screen) => { const l = console.log; console.log = () => {}; try { return engine.preAnalyzeStatus(screen, 'claude', null, {}, null); } finally { console.log = l; } };
const NOTICE = fs.readFileSync(new URL('./fixtures/screens/claude-notice-enter-to-continue.txt', import.meta.url), 'utf8');

test('通知：按 Enter 关掉（不再判「状态不明确」干等）', () => {
  const r = analyze(NOTICE);
  assert(r?._rule === 'cli-notice-enter' && r.actionType === 'key' && r.suggestedAction === 'Enter', JSON.stringify(r && { s: r.currentState, t: r.actionType, a: r.suggestedAction }));
});

test('带编号选项的面板即使也写着 Enter to continue，不按 Enter（那是要选择的）', () => {
  const menu = NOTICE.replace('  Enter to continue · Esc to cancel', '  ❯ 1. Keep current setting\n    2. Switch to new mode\n\n  Enter to continue · Esc to cancel');
  const r = analyze(menu);
  assert(r?._rule !== 'cli-notice-enter', `把选项面板当成了通知：${JSON.stringify(r && r.currentState)}`);
});

test('「Enter to continue」只出现在上方历史里、屏幕末尾是正常输入框 → 不触发', () => {
  const past = NOTICE + '\n⏺ 继续处理中…\n────────────\n❯ \n────────────\n  ⏵⏵ auto mode on (shift+tab to cycle)\n';
  assert(analyze(past)?._rule !== 'cli-notice-enter', '历史里的通知文字被当成了当前弹窗');
});

for (const [name, fn] of queue) {
  try { await fn(); pass++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n    ${e.message}`); }
}
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);

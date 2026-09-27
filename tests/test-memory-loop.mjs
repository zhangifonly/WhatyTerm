/**
 * 普通会话的 Auto Memory 闭环：收尾写记忆 → /compact → 先读 MEMORY.md 再续，四个环节都要真的闭上。
 *
 * 由来（2026-09-26）：收尾指令在 tableCard / mathviz / Hitech / ChemAIForge / BiologyintheAIEra 上
 * 一次都没发出去（长指令折行，核对只看提示符第一行）；阶段却照样推进，3 个空闲轮后判「记忆写完」发 /compact；
 * 压缩后底栏的百分比消失，状态机卡在 resumed / compact_sent 永不复位，下次再满也不会再收尾。
 *
 * 运行: node tests/test-memory-loop.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { pendingCount, landed } from '../server/services/inputLanding.js';
import { promptInputText } from '../server/services/promptState.js';
import { memoryDirFor, memorySnapshot, memoryChangedSince } from '../server/services/memoryProbe.js';
import { decideWaterlinePhase, HANDOFF_PROMPT, RESUME_PROMPT } from '../server/services/contextWaterline.js';

let pass = 0, fail = 0;
const test = (name, fn) => { try { fn(); pass++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n    ${e.message}`); } };
const assert = (c, m) => { if (!c) throw new Error(m || '断言失败'); };

/** 按终端宽度把文本折行放进输入框（与 Claude Code 实际显示一致：首行带 ❯，续行两格缩进） */
function inputBox(text, width = 60) {
  const rows = []; let cur = '', w = 0;
  for (const ch of text) { const cw = /[　-鿿＀-￯]/.test(ch) ? 2 : 1; if (w + cw > width) { rows.push(cur); cur = ''; w = 0; } cur += ch; w += cw; }
  if (cur) rows.push(cur);
  return `⏺ 上一轮的回复\n\n${'─'.repeat(40)}\n${rows.map((r, i) => (i ? `  ${r}` : `❯ ${r}`)).join('\n')}\n${'─'.repeat(40)}\n  ⏵⏵ auto mode on (shift+tab to cycle)\n`;
}
const EMPTY = `⏺ 上一轮的回复\n\n${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  ⏵⏵ auto mode on (shift+tab to cycle)\n`;

test('长指令折成多行：输入框完整内容能拼回原文；收尾/恢复指令都判为已落地', () => {
  for (const p of [HANDOFF_PROMPT, RESUME_PROMPT]) {
    const scr = inputBox(p);
    assert(scr.split('\n').filter((l) => l.startsWith('  ') && !l.includes('⏵')).length >= 2, '样本没折成多行');
    assert(pendingCount(scr, p) === 1 && landed(EMPTY, scr, p), `折行后没认出来：${p.slice(0, 20)}`);
  }
});

test('英文单词在折行处被切开时补回空格；输入框下方的状态栏不算进内容', () => {
  const scr = `❯ 写进项目记忆（Auto\n  Memory）：当前进度\n────\n  ⏵⏵ auto mode on\n`;
  assert(promptInputText(scr) === '写进项目记忆（Auto Memory）：当前进度', promptInputText(scr));
});

test('折行处的空格与原文不一致（终端在空格处断行、行尾空格被裁掉）也认得', () => {
  const p = 'please save progress to memory then stop';
  const scr = `❯ please save progress to\n  memory then stop\n────\n  ⏵⏵ auto mode on\n`;           // 原文的空格被折行吃掉
  const scr2 = `❯ please save progress to  memory then stop\n────\n  ⏵⏵ auto mode on\n`;        // 多出一个空格
  assert(landed(EMPTY, scr, p) && landed(EMPTY, scr2, p), '空白差异导致没认出');
});

test('只打进去一半（输入框里是指令的前半截）→ 不算落地，不能按回车', () => {
  const half = inputBox(HANDOFF_PROMPT.slice(0, 60));
  assert(!landed(EMPTY, half, HANDOFF_PROMPT), '半截指令被当成落地');
});

test('记忆目录：项目配置了 autoMemoryDirectory 就用它（相对路径按项目算），否则用 Claude 默认位置', () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'memdir-'));
  assert(memoryDirFor(wd, '/h') === `/h/.claude/projects/${wd.replace(/[^a-zA-Z0-9]/g, '-')}/memory`);
  fs.mkdirSync(path.join(wd, '.claude'));
  fs.writeFileSync(path.join(wd, '.claude', 'settings.local.json'), JSON.stringify({ autoMemoryDirectory: '.memory' }));
  assert(memoryDirFor(wd, '/h') === path.join(wd, '.memory'));
  fs.rmSync(wd, { recursive: true, force: true });
});

test('记忆写没写只认磁盘：新建或改过的 .md 才算；目录不存在、没变化都是空', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memsnap-'));
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), 'a');
  const before = memorySnapshot(dir);
  assert(memoryChangedSince(before, memorySnapshot(dir)).length === 0, '没改也算变化');
  const t = Date.now() / 1000 + 5;
  fs.writeFileSync(path.join(dir, 'progress.md'), 'b'); fs.utimesSync(path.join(dir, 'MEMORY.md'), t, t);
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'c');
  assert(memoryChangedSince(before, memorySnapshot(dir)).join() === 'MEMORY.md,progress.md', memoryChangedSince(before, memorySnapshot(dir)).join());
  assert(Object.keys(memorySnapshot(path.join(dir, 'nope'))).length === 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('状态机：压缩后底栏百分比消失 → compact_sent 照样发恢复指令；resumed 复位成 idle，下次再满能重新收尾', () => {
  assert(decideWaterlinePhase({ usedPercent: null, isIdle: true, phase: 'compact_sent' }).level === 'resume', '压缩后无读数，恢复指令发不出去');
  const r = decideWaterlinePhase({ usedPercent: null, isIdle: true, phase: 'resumed' });
  assert(r.nextPhase === 'idle', `恢复后无读数仍停在 ${r.nextPhase}，下次再满不会收尾`);
  assert(decideWaterlinePhase({ usedPercent: 95, isIdle: true, phase: 'idle' }).level === 'handoff', '复位后再满没有收尾');
  assert(decideWaterlinePhase({ usedPercent: null, isIdle: true, phase: 'handoff_sent' }).nextPhase === 'handoff_sent', '收尾中读数闪断不该跳步');
});

const IDX = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
test('接线：收尾确认发出时给记忆目录拍快照；只有记忆文件真变了才放行 /compact；一直没变就提醒人、不压缩', () => {
  const land = IDX.slice(IDX.indexOf('function landWaterlinePhase(session, status) {'), IDX.indexOf('function autoActionBlockReason('));
  assert(/_waterlineNextPhase === 'handoff_sent'[\s\S]{0,200}memorySnapshot\(session\._waterlineMemoryDir\)/.test(land), '收尾发出时没拍记忆快照');
  assert(/const memoryWritten = memChanged\.length > 0 && \(replySaysDone \|\| roundsSinceHandoff >= HANDOFF_WAIT_ROUNDS\);/.test(IDX), '放行 /compact 不要求记忆文件真的变了');
  assert(/记忆文件一直没变化 —— 没有压缩，请看一眼/.test(IDX), '记忆一直没写时没提醒人');
  // 复位不需要发送，必须直接落地（提议只在发送确认后落地，复位没有发送 → 永不落地）
  assert(/wl\.level === 'none' && wlNextPhase === 'idle' && phase !== 'idle'\) \{[\s\S]{0,400}landWaterlinePhase\(session, \{ _waterlineNextPhase: 'idle' \}\)/.test(IDX), '复位没有直接落地');
});

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);

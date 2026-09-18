/**
 * 普通会话转长程前的「交接」—— 回执解析与不可违反的流程约束
 *
 * 要害在两处，都会造成**不可恢复的损失**：
 *   ① 抽错「下一步」→ 那句话会原样变成长程执行者的任务，它会真去做。宁可抽不到。
 *   ② 没写完就 /quit → 这一段对话的进度、结论、失败过的方案全丢，记忆里一个字都没有。
 * 所以除了纯函数，还写死了两条源码守卫，防以后改坏。
 *
 * 运行: node tests/test-longrun-handoff.mjs
 */

import fs from 'fs';
import { parseHandoffReceipt, HANDOFF_PHASE, NEXT_STEP_MAX } from '../server/services/longrunHandoff.js';
import { isMemoryWritten, LONGRUN_HANDOFF_PROMPT } from '../server/services/contextWaterline.js';
import { HANDOFF_STEPS, handoffSummary } from '../src/components/longrun/longrunHandoffView.js';

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function test(name, fn) {
  try { fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}

const REAL_REPLY = `我已经把这一段的进展同步进 Auto Memory 了。

更新了哪些记忆文件：
- .memory/MEMORY.md：新增索引行「采购单据接口」
- .memory/progress.md：补了当前任务进度与两条失败方案
- .memory/decisions.md：记录了为什么放弃 MongoDB 改用 Postgres

下一会话应该从哪一项开始：
- 先跑 pytest tests/test_purchase.py，它现在有 3 个失败用例
- 修完再接着做审批流的驳回分支`;

test('真实形态回执：抽出全部记忆文件（去重保序）与下一步', () => {
  const r = parseHandoffReceipt(REAL_REPLY);
  assert(r.files.join() === 'memory/MEMORY.md,memory/progress.md,memory/decisions.md', r.files.join());
  assert(r.nextStep.startsWith('先跑 pytest'), r.nextStep);
  assert(r.nextStep.includes('审批流的驳回分支'), '下一步是几行清单时要整段取，只取第一行会漏掉一半：' + r.nextStep);
  assert(!/^[-*•]/m.test(r.nextStep), '清单符号要去掉，不然长程需求里混着 markdown 记号：' + r.nextStep);
});

test('同一行冒号后就有内容时直接用那一句，不把后面无关段落吞进来', () => {
  const r = parseHandoffReceipt('更新了 a.md。\n下一步：把 UserService 的单测补齐\n\n另外提醒你删掉临时目录。');
  assert(r.nextStep === '把 UserService 的单测补齐', JSON.stringify(r.nextStep));
});

test('没有「下一步」段落时给空，绝不拿别的句子顶上', () => {
  const r = parseHandoffReceipt('我更新了 .memory/MEMORY.md 和 notes.md，内容是今天的进展。');
  assert(r.files.length === 2, JSON.stringify(r.files));
  assert(r.nextStep === '', `抽不到就得是空，实际抽到了「${r.nextStep}」—— 这句会变成长程执行者的任务`);
  assert(r.raw.includes('今天的进展'), '原文要留着，界面上让人自己看');
});

test('空回复不炸；超长下一步被截断到上限', () => {
  const empty = parseHandoffReceipt('');
  assert(empty.files.length === 0 && empty.nextStep === '' && empty.raw === '', JSON.stringify(empty));
  assert(parseHandoffReceipt(null).nextStep === '');
  const long = parseHandoffReceipt(`下一步：${'补一个用例。'.repeat(200)}`);
  assert(long.nextStep.length === NEXT_STEP_MAX, `应截到 ${NEXT_STEP_MAX}，实际 ${long.nextStep.length}`);
});

test('只有指令回显时不能判成「写完了」（交接指令自身就含「更新了哪些记忆文件」）', () => {
  const echo = LONGRUN_HANDOFF_PROMPT;
  assert(isMemoryWritten(echo, 0) === false, '指令原文被当成回复 → 一发出就自证写完，CLI 可能一字未写就被 /quit');
  assert(isMemoryWritten('好的，我现在开始整理记忆文件。', 0) === false, '未来式不算写完');
  assert(isMemoryWritten('已更新 .memory/MEMORY.md 与 progress.md，下一会话从修 pytest 开始。', 0) === true, '完成式要认');
});

test('交接指令本身：要多要两样回执，且必须是多行（决定了只能走 bracketed paste）', () => {
  assert(LONGRUN_HANDOFF_PROMPT.includes('下一会话应该从哪一项开始'), '少了这条就没东西预填进长程需求');
  assert(LONGRUN_HANDOFF_PROMPT.includes('每个文件新增或修改了什么'), '少了这条人就无法判断它是不是敷衍了');
  assert(LONGRUN_HANDOFF_PROMPT.split('\n').length > 3, '多行 → 发送必须用 bracketed paste，否则第一个换行就被当成提交');
  assert(Object.keys(HANDOFF_PHASE).length === 5, JSON.stringify(HANDOFF_PHASE));
});

test('界面文案与服务端阶段表逐字相同（前端抄了一份，不许漂移）', () => {
  const pairs = [['waiting_idle', 'waiting'], ['sent', 'sent'], ['writing', 'writing'], ['quitting', 'quitting'], ['done', 'done']];
  for (const [srv, ui] of pairs) {
    assert(HANDOFF_PHASE[srv] === HANDOFF_STEPS[ui], `${srv} 漂移：服务端「${HANDOFF_PHASE[srv]}」≠ 界面「${HANDOFF_STEPS[ui]}」——界面会一直停在上一步`);
  }
});

test('成功总结：如实说抽没抽到下一步、CLI 退没退，不含糊', () => {
  const full = handoffSummary({ ok: true, exited: true, receipt: { files: ['a.md', 'b.md'], nextStep: '跑 pytest' } });
  assert(full.includes('更新了 2 个记忆文件') && full.includes('已拿到「下一步」') && full.includes('CLI 已退出'), full);
  const bare = handoffSummary({ ok: true, exited: false, receipt: { files: [], nextStep: '' } });
  assert(bare.includes('没有列出更新的记忆文件') && bare.includes('需要你自己填') && bare.includes('还没退出'), bare);
  assert(handoffSummary({ ok: false }) === '' && handoffSummary(null) === '', '失败时不给总结');
});

// ── 源码守卫：这两条错了不会有测试红，但会真丢上下文 ──────────────────────
const SRC = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
const BODY = SRC.slice(SRC.indexOf("socket.on('longrun:handoff'"), SRC.indexOf("socket.on('longrun:replay'"));

test('守卫：超时分支绝不 /quit —— 没写完就退，这一段对话就真丢了', () => {
  assert(BODY.length > 500, '没找到 longrun:handoff 处理器，守卫失效了');
  const bail = BODY.slice(BODY.indexOf('if (!written)'), BODY.indexOf('const receipt'));
  assert(bail.includes('reply(') && !bail.includes('/quit'), '超时分支里出现了 /quit：' + bail);
  assert(BODY.indexOf('/quit') > BODY.indexOf('isMemoryWritten'), '/quit 必须排在「确认写完」之后');
  assert(BODY.includes("tmuxSendLiteral(tmux, '/quit')"), '/quit 走 tmux send-keys 主路径，session.write 只作兜底');
});

test('守卫：发指令前先看输入框有没有用户草稿，且等它闲下来', () => {
  const head = BODY.slice(0, BODY.indexOf('LONGRUN_HANDOFF_PROMPT'));
  assert(head.includes('promptPendingText'), '没检查草稿：指令会和人家没发完的半截话搅成一句');
  assert(head.includes('isClaudeInputReady'), '没等空闲就发，会打断它正在跑的活');
  assert(head.includes('stripAnsiForProbe'), '抓屏读草稿前必须剥 ANSI，否则必失配（同一个坑踩过三次）');
  assert(BODY.includes('bracketedPaste(LONGRUN_HANDOFF_PROMPT)'), '多行指令必须 bracketed paste');
});

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

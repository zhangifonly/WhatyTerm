/**
 * 长程任务看板：前端增量逻辑（src/components/longrun/longrunBoard.js）—— 回归测试
 *
 * 最要紧的是第一条**结构性守卫**：同一串事件，走后端 LongRunBoard.handle 得到的快照，
 * 与从空快照开始逐条走前端 applyEvent 得到的状态必须一致 —— 刷新页面（取快照）与
 * 一直开着（收增量）看到的东西不能不一样。原版页面脚本在这里有四处走偏（见模块注释）。
 *
 * 事件串直接由真实 loop 跑出来（假执行者 + 假监督者），不是手写的，字段改名会被带进来。
 *
 * 运行: node tests/test-longrun-events.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  applyEvent, normalizeSnapshot, mergedEntries, timelineCount, entryView, ctxView, taskBadge,
  fmtDur, STOP_LABEL, VERDICT_LABEL, ROLE_ICON, isSubmitKey,
} from '../src/components/longrun/longrunBoard.js';
import { LongRunBoard, TIMELINE_RULES } from '../server/services/LongRunBoard.js';
import { LongRunLoop, Stop } from '../server/services/LongRunLoop.js';
import { Supervisor, Verdict } from '../server/services/LongRunSupervisor.js';
import { loadPrompts } from '../server/services/LongRunPrompts.js';

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
async function test(name, fn) {
  try { await fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}

/** 用真实 loop 跑一轮：交接、维护、代答、叫人并回答、人工注入、暂停与继续，事件全收下来 */
async function realEvents() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lr_events_'));
  const spec = { root, memoryDir: path.join(root, '.memory'), runDir: path.join(root, '.run'), extraDirs: [],
    verifyClean() {}, childEnv: () => ({ ...process.env }) };
  for (const d of [spec.memoryDir, spec.runDir]) fs.mkdirSync(d, { recursive: true });
  const verdicts = ['decide', 'needs_human', 'continue', 'project_done'];
  const events = [];
  let n = 0;
  const loop = new LongRunLoop({
    sandbox: spec, prompts: loadPrompts(fileURLToPath(new URL('../server/prompts/longrun/提示词.txt', import.meta.url))),
    requirementText: '做个待办', maintenanceEvery: 1, onEvent: (ev) => events.push(ev),
    humanChannel: async () => '用 SQLite',
    supervisor: new Supervisor({ systemPrompt: 'x', complete: async () => {
      const v = verdicts.shift() || 'project_done';
      return { text: JSON.stringify({ verdict: v, confidence: 0.95, reason: `桩 ${v}`, reply: v === 'decide' ? '按需求来' : '', needs_from_human: '定库' }),
        stopReason: 'end_turn', inputTokens: 1, outputTokens: 1 };
    } }),
    runnerFactory: (ro) => ({ abort() {}, run: async (prompt, sid) => {
      n += 1;
      ro.onStream({ kind: 'context', occupied: 1000 * n, peak: 1000 * n, limit: ro.contextLimit, cost_estimate: 0.01 * n, calls: n });
      ro.onStream({ kind: 'thinking', text: `想 ${n}` });
      ro.onStream({ kind: 'tool', names: ['bash'], calls: [{ id: `t${n}`, name: 'Bash', brief: 'npm test', detail: 'command: npm test' }] });
      ro.onStream({ kind: 'tool_result', id: `t${n}`, name: 'Bash', is_error: n === 2, text: 'ok' });
      ro.onStream({ kind: 'text', text: `第 ${n} 发的旁白` });
      if (n === 3) fs.writeFileSync(path.join(spec.runDir, 'pause'), '');
      if (n === 3) setTimeout(() => fs.rmSync(path.join(spec.runDir, 'pause')), 500);
      const inject = n === 4 ? '改方向' : '';
      if (inject) { ro.onStream({ kind: 'inject.waiting', text: inject }); ro.onStream({ kind: 'inject.sent', text: inject, immediate: true }); }
      return { sessionId: sid || `sid-${n}`, exitReason: inject ? 'interrupted_by_human' : 'completed',
        contextPeak: n >= 5 ? 250000 : 1000 * n, finalText: `完成第 ${n} 步`, stopReason: 'end_turn', costUsd: 0.1,
        costEstimate: 0, injectText: inject, pendingTasks: [], numTurns: 1, error: '', durationS: 3, permissionDenials: [] };
    } }),
  });
  const report = await loop.run();
  fs.rmSync(root, { recursive: true, force: true });
  return { events, report };
}

const { events, report } = await realEvents();
const FIELDS = ['spent_usd', 'running_cost', 'context', 'logs', 'last_tool', 'supervisor', 'finished', 'timeline',
  'trace', 'need_human', 'legs', 'handoffs', 'maintenances', 'decisions', 'current_label', 'session_id', 'paused'];
const board = new LongRunBoard({ title: 't', requirement: 'r', sandbox: '/s', startedAt: 0 });
const empty = normalizeSnapshot(new LongRunBoard({ title: 't', requirement: 'r', sandbox: '/s', startedAt: 0 }).snapshot());
// 逐条比较：只比最终状态会漏掉"中途不一致、最后碰巧对上"的情况（如新一发不清监督者判定）
let frontend = empty;
let firstMismatch = '';
for (const [i, ev] of events.entries()) {
  frontend = applyEvent(frontend, board.handle(ev));
  if (firstMismatch) continue;
  const snap = board.snapshot();
  const f = FIELDS.find((k) => JSON.stringify(frontend[k]) !== JSON.stringify(snap[k]));
  if (f) firstMismatch = `第 ${i} 条（${ev.kind}）后 ${f}: 前端=${JSON.stringify(frontend[f])?.slice(0, 160)} 后端=${JSON.stringify(snap[f])?.slice(0, 160)}`;
}
const backend = board.snapshot();

await test('真实 loop 事件串覆盖了关键看板状态（否则下面的一致性比较有盲区）', () => {
  const kinds = new Set(events.map((e) => e.kind));
  for (const k of ['send', 'result', 'exec.context', 'exec.tool', 'exec.text', 'supervisor', 'supervisor.decided',
    'need_human', 'need_human.done', 'exec.inject.sent', 'inject.applied', 'paused', 'resumed', 'handoff.done',
    'maintenance.done', 'finished', 'log']) assert(kinds.has(k), `事件串缺 ${k}；实有: ${[...kinds].join(',')}`);
  assert(report.stop === Stop.PROJECT_DONE, report.stop);
});

await test('刷新（取后端快照）与一直开着（收前端增量）看到的状态，每一步都一致', () => {
  assert(!firstMismatch, firstMismatch);
});

await test('修正：注入已被后续发送消化后，快照与增量都不再显示「已注入，续跑中」', () => {
  assert(frontend.inject === null, `增量应已收起: ${JSON.stringify(frontend.inject)}`);
  assert(backend.inject?.phase === 'applied', '后端与原版一致地保留最后阶段');
  assert(normalizeSnapshot(backend).inject === null, '快照入场时应收起');
  const pending = normalizeSnapshot({ ...backend, inject: { phase: 'applied', text: 'x', at: 1e12 } });
  assert(pending.inject, '之后还没有发送的注入要保留');
});

await test('修正：增量时时间线上限与后端一致（1000，不是原版页面的 400）', () => {
  let s = empty;
  for (let i = 0; i < 1100; i++) s = applyEvent(s, { kind: 'exec.text', _entry: { id: i + 1, at: i, role: 'say', stream: 'main', body: 'x' } });
  assert(s.timeline.length === 1000 && s.timeline[0].id === 101, `${s.timeline.length}`);
});

await test('修正：隐藏过程明细时计数不再说"含过程"；合并按时间与 id 排序', () => {
  assert(!timelineCount(backend, false).includes('含过程') && timelineCount(backend, true).includes('含过程'));
  const m = mergedEntries(backend, true);
  assert(m.every((e, i) => i === 0 || m[i - 1].at < e.at || (m[i - 1].at === e.at && m[i - 1].id < e.id)), '合并顺序');
  assert(mergedEntries(backend, false).every((e) => e.stream === 'main'));
});

await test('折叠规则：过程明细默认折叠；旁白 900 字才折；不折叠时非过程条目常开且不给「收起」（修正）', () => {
  const ex = new Set();
  const v = (role, len, fold = true) => entryView({ id: 1, role, body: 'x'.repeat(len) }, { fold, expanded: ex });
  assert(!v('tool', 5).open && v('tool', 5).collapsible, '过程明细再短也折叠');
  assert(v('say', 800).open && !v('say', 901).open && !v('executor', 261).open && v('executor', 260).open);
  assert(v('executor', 5000, false).open && !v('executor', 5000, false).collapsible, '不折叠时不该有收起');
  assert(!v('thinking', 10, false).open, '过程明细不受「折叠长内容」开关影响');
  assert(entryView({ id: 7, role: 'tool', body: 'x' }, { fold: true, expanded: new Set([7]) }).open, '点开后展开');
});

await test('水位条、耗时、列表徽标与文案表', () => {
  assert(ctxView({}).text === '水位 —' && ctxView({ occupied: 81, peak: 90, limit: 100 }).hot && !ctxView({ occupied: 80, peak: 1, limit: 100 }).hot);
  assert(fmtDur(59.4) === '59s' && fmtDur(725) === '12m05s' && fmtDur(4320) === '1h12m', fmtDur(4320));
  assert(taskBadge({ state: 'running', awaitingHuman: true, halted: true })[1].includes('等你回答'), '等人优先');
  assert(taskBadge({ state: 'running', pauseArmed: true })[1].includes('暂停闸'), '闸挂上≠已停住');
  assert(taskBadge({ state: 'failed', report: { stop: 'interrupted' } })[1] === '已中断');
  for (const v of Object.values(Stop)) assert(STOP_LABEL[v], `缺停机文案 ${v}`);
  for (const v of Object.values(Verdict)) assert(VERDICT_LABEL[v], `缺判定文案 ${v}`);
  const roles = new Set(TIMELINE_RULES.map(([, r]) => r));
  for (const r of roles) assert(ROLE_ICON[r], `缺角色图标 ${r}`);
});

await test('底部输入框提交键：Enter 提交，Shift+Enter 换行，输入法组字中的回车是选词', () => {
  const k = (o) => ({ key: 'Enter', shiftKey: false, keyCode: 13, nativeEvent: { isComposing: false }, ...o });
  assert(isSubmitKey(k({})), 'Enter 提交');
  assert(!isSubmitKey(k({ shiftKey: true })), 'Shift+Enter 换行');
  assert(!isSubmitKey(k({ nativeEvent: { isComposing: true } })), '组字中不提交');
  assert(!isSubmitKey(k({ keyCode: 229 })), 'Safari 组字结束的回车 keyCode 229 不提交');
  assert(!isSubmitKey(k({ key: 'a' })));
});

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

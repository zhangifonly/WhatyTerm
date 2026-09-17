/**
 * 长程任务面板：事件显示与运行态 —— 回归测试
 *
 * 最要紧的是第一条**结构性守卫**：扫服务端源码里真实发出的每种事件类型，逐个断言
 * 前端有专门的显示规则。原编排器看板有过 exec.text 一直在发却从未上屏，丢了 139 条
 * 执行者旁白才被发现。以后加事件忘了配显示，这条会立刻变红。
 *
 * 运行: node tests/test-longrun-events.mjs
 */

import fs from 'fs';
import {
  describeEvent, reduceLive, liveFromTask, waterlinePercent, thresholdError,
  THRESHOLD_PRESETS, STOP_TEXT, EXIT_TEXT,
} from '../src/components/longrun/longrunEvents.js';
import { ExitReason } from '../server/services/LongRunRunner.js';
import { Stop } from '../server/services/LongRunLoop.js';

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

const read = (f) => fs.readFileSync(new URL(`../server/services/${f}`, import.meta.url), 'utf8');

/** 从源码抽事件类型。只认字面量第一个参数，动态拼的另行列出。 */
function kindsIn(src, pattern) {
  return [...new Set([...src.matchAll(pattern)].map((m) => m[1]))];
}

const loopKinds = kindsIn(read('LongRunLoop.js'), /this\.emit\('([a-z_.]+)'/g);
const runnerKinds = [
  ...kindsIn(read('LongRunRunner.js'), /this\._writeEvent\('([a-z_.]+)'/g),
  // _emit 前是下划线、没有词边界，\bemit 会漏抽（inject.waiting / inject.sent 就这样漏过）
  ...kindsIn(read('LongRunRunner.js'), /(?:\b|_)emit\('([a-z_.]+)'/g),
].map((k) => `exec.${k}`);
const serviceKinds = kindsIn(read('LongRunService.js'), /this\._emit\(task, '([a-z_.]+)'/g);

/** 兜底样式的特征：标题就是类型名本身 */
const isFallback = (ev, desc) => desc.icon === '•' && desc.title === ev.kind;

test('源码里确实抽到了事件（否则下面的守卫是空转）', () => {
  assert(loopKinds.length >= 12, `loop 事件太少，正则可能失配: ${loopKinds}`);
  assert(runnerKinds.length >= 8, `runner 事件太少，正则可能失配: ${runnerKinds}`);
  assert(['state', 'error', 'selfcheck'].every((k) => serviceKinds.includes(k)), `service 事件抽取失配: ${serviceKinds}`);
});

test('服务端发出的每种事件，前端都有专门的显示规则（不走兜底）', () => {
  const all = [...new Set([...loopKinds, ...runnerKinds, ...serviceKinds])];
  const missing = all.filter((kind) => {
    const ev = { kind };
    const desc = describeEvent(ev);
    return desc.lane !== 'hidden' && isFallback(ev, desc);
  });
  assert(missing.length === 0,
    `这些事件没配显示规则，会以兜底样式出现（等于没人认真显示）: ${missing.join(', ')}`);
});

test('未知事件不静默丢弃，走兜底照样显示', () => {
  const desc = describeEvent({ kind: 'some.future.kind', foo: 1 });
  assert(desc.lane !== 'hidden', '未知事件不能被藏起来');
  assert(desc.title === 'some.future.kind' && desc.detail.includes('foo'), '兜底要带类型名和数据');
  assert(!desc.detail.includes('seq'), '兜底详情不该塞元数据');
});

test('停机原因与退出原因的人话覆盖全部枚举', () => {
  for (const v of Object.values(Stop)) assert(STOP_TEXT[v], `缺停机原因文案: ${v}`);
  for (const v of Object.values(ExitReason)) assert(EXIT_TEXT[v], `缺退出原因文案: ${v}`);
});

// ── 运行态归约 ──────────────────────────────────────────────
const base = () => liveFromTask({
  state: 'running', occupied: 0, contextPeak: 0, costUsd: 0, legs: 0, handoffs: 0,
  thresholds: { hardKill: 400000 },
});

test('水位跟 exec.context 走，新一发归零，峰值保留', () => {
  let l = reduceLive(base(), { kind: 'exec.context', occupied: 200000, peak: 210000 });
  assert(l.occupied === 200000 && l.peak === 210000, '水位未更新');
  assert(waterlinePercent(l) === 50, `分母应是 hardKill，实际 ${waterlinePercent(l)}%`);
  l = reduceLive(l, { kind: 'send', label: '催继续' });
  assert(l.occupied === 0 && l.peak === 210000, '新一发应归零但保留峰值');
});

test('暂停/继续驱动横幅（停着和挂死在看板上都表现为不动，必须区分）', () => {
  let l = reduceLive(base(), { kind: 'paused', label: '催继续' });
  assert(l.paused === true, '应显示已暂停');
  l = reduceLive(l, { kind: 'resumed' });
  assert(l.paused === false, '继续后横幅应消失');
});

test('等人回答：带原因进入，回答后清掉', () => {
  let l = reduceLive(base(), { kind: 'need_human', reason: 'r', needs: '选哪个库', question: '用 A 还是 B？' });
  assert(l.awaiting?.needs === '选哪个库' && l.awaiting.question.includes('A 还是 B'), '要带出需要人做什么与执行者原话');
  l = reduceLive(l, { kind: 'need_human.done', answered: true });
  assert(l.awaiting === null, '回答后应清掉');
});

test('收工报告的费用是权威实账，覆盖前端累加', () => {
  let l = reduceLive(base(), { kind: 'result', leg: 1, cost_usd: 1.1, context_peak: 1 });
  l = reduceLive(l, { kind: 'result', leg: 2, cost_usd: 2.2, context_peak: 1 });
  assert(Math.abs(l.costUsd - 3.3) < 1e-9, `运行中应累加，实际 ${l.costUsd}`);
  l = reduceLive(l, { kind: 'finished', stop: 'project_done', cost_usd: 3.47, legs: 2, handoffs: 0, decisions: 0 });
  assert(l.costUsd === 3.47 && l.state === 'done', '收工后以报告为准');
});

test('非完成的收工与服务异常都记为失败态', () => {
  assert(reduceLive(base(), { kind: 'finished', stop: 'budget' }).state === 'failed');
  assert(reduceLive(base(), { kind: 'error', message: 'x' }).state === 'failed');
});

test('归约是纯函数：不改原对象', () => {
  const l = base();
  const snap = JSON.stringify(l);
  reduceLive(l, { kind: 'paused' });
  assert(JSON.stringify(l) === snap, '原运行态被改了');
});

test('快照恢复：刷新后从服务端快照重建（含暂停与等人）', () => {
  const l = liveFromTask({ state: 'running', occupied: 5, contextPeak: 9, costUsd: 1.2,
    legs: 4, handoffs: 1, paused: true, awaitingHuman: true, thresholds: { hardKill: 100 } });
  // paused 文件在只代表闸已挂上，不代表已停住（见下一条用例）
  assert(l.pauseArmed && !l.paused && l.awaiting && l.legs === 4 && l.hardKill === 100, '快照字段没接全');
  assert(liveFromTask(null) === null, '无任务返回 null');
});

/**
 * 从源码抽每种事件的字段名：找到 emit('kind', { … }) 的对象字面量，按括号/字符串深度切出顶层键。
 * 同一类型多处发出时取并集。
 */
function fieldsIn(src, pattern) {
  const out = {};
  for (const m of src.matchAll(pattern)) {
    let i = m.index + m[0].length;
    while (src[i] === ' ') i++;
    if (src[i] !== '{') continue;
    const keys = out[m[1]] || (out[m[1]] = new Set());
    let depth = 0, seg = '', quote = null;
    for (; i < src.length; i++) {
      const c = src[i];
      if (quote) { if (c === quote && src[i - 1] !== '\\') quote = null; if (depth === 1) seg += c; continue; }
      if (c === "'" || c === '"' || c === '`') { quote = c; if (depth === 1) seg += c; continue; }
      if ('{(['.includes(c)) { depth++; if (depth === 1) continue; }
      if ('})]'.includes(c)) { depth--; if (depth === 0) { addKey(keys, seg); break; } }
      if (depth === 1 && c === ',') { addKey(keys, seg); seg = ''; continue; }
      if (depth === 1) seg += c;
    }
  }
  return out;
}
function addKey(keys, seg) {
  const t = seg.trim();
  const m = t.match(/^([A-Za-z_$][\w$]*)\s*(?::|$)/);
  if (m) keys.add(m[1]);
}
const META = new Set(['kind', 'at', 'seq', 'taskId']);
const prefixed = (obj, p) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [p + k, v]));
const sourceFields = {
  ...fieldsIn(read('LongRunLoop.js'), /this\.emit\('([a-z_.]+)',/g),
  ...prefixed(fieldsIn(read('LongRunRunner.js'), /(?:\b|_)emit\('([a-z_.]+)',/g), 'exec.'),
  ...fieldsIn(read('LongRunService.js'), /this\._emit\(task, '([a-z_.]+)',/g),
};

test('前端读的每个事件字段，源码里真的发了（改名一边忘改另一边会满屏 undefined 却照样绿）', () => {
  assert(sourceFields.result?.has('exit_reason') && sourceFields['exec.tool']?.has('calls'),
    `字段抽取失配: ${JSON.stringify(Object.fromEntries(Object.entries(sourceFields).map(([k, v]) => [k, [...v]])))}`);
  const wrong = [];
  for (const [kind, fields] of Object.entries(sourceFields)) {
    const read = new Set();
    const ev = new Proxy({ kind }, { get: (t, p) => { if (typeof p === 'string') read.add(p); return t[p]; } });
    describeEvent(ev);
    reduceLive(base(), ev);
    for (const f of read) if (!META.has(f) && !fields.has(f)) wrong.push(`${kind}.${f}`);
  }
  assert(wrong.length === 0, `前端读了源码没发的字段: ${wrong.join(', ')}`);
});

// ── 阈值 ────────────────────────────────────────────────────
test('两个预设本身满足有序（否则一选就报错）', () => {
  for (const [k, p] of Object.entries(THRESHOLD_PRESETS)) {
    assert(thresholdError(p) === '', `预设 ${k} 自相矛盾: ${thresholdError(p)}`);
  }
});

test('阈值写反或缺值时给出说清后果的报错', () => {
  assert(thresholdError({ handoffFloor: 300, handoffCeiling: 200, hardKill: 400 }).includes('刚开跑'));
  assert(thresholdError({ handoffFloor: '', handoffCeiling: 200, hardKill: 400 }).includes('正整数'));
});

test("展开 result 能看到执行者这一发的原话与遗留任务", () => {
  const d = describeEvent({ kind: "result", label: "继续完成项目", exit_reason: "completed",
    context_peak: 1, duration_s: 1, cost_usd: 0.1, text: "我实现了 add 命令", pending_tasks: [{}] });
  assert(d.full.includes("我实现了 add 命令"), "展开内容缺执行者原话");
  assert(d.full.includes("后台任务仍在飞"), "展开内容要提示遗留任务");
  assert(!d.detail.includes("我实现了"), "折叠摘要不该塞整段原话");
});

test("暂停闸已挂 ≠ 已停住：闸挂上时当前这发照常跑完", () => {
  const l = liveFromTask({ state: "running", paused: true, thresholds: { hardKill: 1 } });
  assert(l.pauseArmed === true && l.paused === false, "快照只知道 pause 文件在，不能当成已停住");
  const h = liveFromTask({ state: "running", pauseArmed: true, halted: true, thresholds: { hardKill: 1 } });
  assert(h.paused === true, "服务端明确 halted 才算已停住");
  const r = reduceLive(reduceLive(l, { kind: "paused" }), { kind: "resumed" });
  assert(r.paused === false && r.pauseArmed === false, "继续后两个状态都清掉");
});

await Promise.all(pending);
console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

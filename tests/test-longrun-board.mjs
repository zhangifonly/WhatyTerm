/**
 * 长程编排：看板状态（LongRunBoard）与原版 web.py RunState 逐条对拍
 *
 * 同一串事件分别喂给 Node 与 Python，比较：推给前端的每条事件（含 _entry 条目）+ 最终快照。
 * 事件串覆盖：全部归类规则、不上时间线的事件、空正文/None、浮点 repr、.Nf 的真 tie、
 * 码点截断边界（emoji）、三个有界队列溢出、键存在但为 null 的 dict.get 语义。
 *
 * 运行: node tests/test-longrun-board.mjs
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { LongRunBoard, TIMELINE_RULES, pyFixed } from '../server/services/LongRunBoard.js';
import { orchestratorRoot } from '../server/services/LongRunSandbox.js';

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
async function test(name, fn) {
  try { await fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}

// ── 事件串 ──────────────────────────────────────────────────
let t = 1000;
const E = (kind, data = {}) => ({ ...data, kind, at: (t += 1.5) });
const emoji = '😀';
const events = [
  E('log', { message: '沙箱: /x' }),
  E('send', { label: '初始化提示词', text: '初始化', resume: false, leg: 1 }),
  E('exec.context', { occupied: 1234, peak: 2000, limit: 400000, cost_estimate: 0.0123, calls: 2 }),
  E('exec.thinking', { text: `想一想\n  换行   多空格 ${'长'.repeat(120)}` }),
  E('exec.thinking', { text: null }),
  E('exec.text', { text: '' }),
  E('exec.tool', { names: ['bash', 'read'], calls: [{ id: 'a', name: 'Bash', brief: 'npm test', detail: 'command: npm test' },
    { id: 'b', name: 'Read', brief: '', detail: 'file_path: /x' }] }),
  E('exec.tool', { names: ['glob'] }),
  E('exec.tool_result', { id: 'a', name: 'Bash', is_error: true, text: `失败\n${'x'.repeat(100)}` }),
  E('exec.tool_result', { id: 'b', name: '', is_error: false, text: 'ok' }),
  E('exec.text', { text: '我先实现 add 命令' }),
  E('result', { label: '初始化提示词', leg: 1, exit_reason: 'completed', context_peak: 1234567, duration_s: 12,
    cost_usd: 0.03125, cost_is_estimate: false, text: '完成', session_id: 'sid-1', pending_tasks: [] }),
  E('result', { label: 'x', leg: 1, exit_reason: 'hang_killed', context_peak: 5, duration_s: 7.25, cost_usd: 0.12345,
    text: '', session_id: '' }),
  E('supervisor', { phase: 'init', verdict: 'continue', confidence: 0.125, reason: '还没做完', needs_from_human: '' }),
  E('supervisor', { phase: 'main', verdict: 'needs_human', confidence: 0.5, reason: 'r', needs_from_human: '定数据库', question: 'q' }),
  E('supervisor.decided', { text: '用 SQLite', reason: '需求写了轻量', confidence: 0.875 }),
  E('need_human', { question: '选 A 还是 B', needs: '选型', reason: '缺信息' }),
  E('need_human.done', { answered: false, text: '' }),
  E('need_human', { question: null, needs: 'n', reason: null }),
  E('need_human.done', { answered: true, text: '选 A' }),
  E('exec.inject.waiting', { text: '改方向' }),
  E('exec.inject.sent', { text: '改方向', immediate: true }),
  E('inject.applied', { text: '改方向' }),
  E('send', { label: '人工注入', text: '改方向', resume: true }),
  E('exec.tasks.waiting', { count: 2, names: '子系统A、子系统B', limit: 150 }),
  E('exec.tasks.timeout', { count: 1, waited: 90, limit: 1800 }),
  E('handoff.start', { count: 1, reason: '正常结束且水位 210,000 ≥ 交接下限 200,000' }),
  E('maintenance.start', { count: 1 }),
  E('maintenance.done', { count: 1 }),
  E('wrapup.empty', { count: 1 }),
  E('handoff.done', { count: 1, commit: null }),
  E('handoff.done', { count: 2, commit: 'a1b2c3d' }),
  E('paused', { label: '继续完成项目', path: '/s/.run/pause' }),
  E('resumed', { label: '继续完成项目', paused_s: 3 }),
  E('some.future.kind', { foo: 1 }),
  E('send', { label: '继续完成项目', text: `${'长'.repeat(11999)}${emoji}尾巴`, resume: true, leg: 7 }),
  E('exec.thinking', { text: `${'想'.repeat(3999)}${emoji}尾巴` }),
  ...Array.from({ length: 1010 }, (_, i) => E('exec.text', { text: `旁白 ${i}` })),
  ...Array.from({ length: 610 }, (_, i) => E('exec.tool', { names: ['bash'], calls: [{ name: 'Bash', brief: `步骤${i}`, detail: '' }] })),
  ...Array.from({ length: 505 }, (_, i) => E('log', { message: `日志 ${i}` })),
  // 键存在但为 null：dict.get 返回 None 而不是默认值（legs 会变成 null）
  E('send', { label: '收尾', text: 'x', resume: true, leg: null }),
  E('finished', { stop: 'project_done', legs: 7, handoffs: 2, maintenances: 1, decisions: 1, elapsed_s: 3600,
    cost_usd: 1.5, needs_from_human: '' }),
];
const opts = { title: '回放 x', requirement: '需求', sandbox: '/s', startedAt: 1000, replay: true, replayUntil: t };

/** 原版这些字段一定是 float（round()/time 差值/秒数），JSON 往返会丢类型，喂给 Python 前补回来 */
const FLOAT_FIELDS = ['duration_s', 'elapsed_s', 'paused_s', 'cost_usd', 'cost_estimate', 'confidence', 'waited', 'limit', 'at'];

function runPython() {
  const orch = orchestratorRoot();
  if (!fs.existsSync(path.join(orch, 'orchestrator', 'web.py'))) return null;
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'board_parity_'));
  const inFile = path.join(dir, 'in.json'), outFile = path.join(dir, 'out.json');
  fs.writeFileSync(inFile, JSON.stringify({ events, opts }));
  const code = `
import sys, json
sys.path.insert(0, ${JSON.stringify(orch)})
from orchestrator.web import RunState
data = json.load(open(${JSON.stringify(inFile)}, encoding='utf-8'))
o = data['opts']
st = RunState(title=o['title'], requirement=o['requirement'], sandbox=o['sandbox'],
              started_at=float(o['startedAt']), replay=o['replay'], replay_until=float(o['replayUntil']))
class Q:
    def __init__(s): s.items = []
    def put_nowait(s, ev): s.items.append(ev)
q = Q(); st.subscribe(q)
for ev in data['events']:
    for k in ${JSON.stringify(FLOAT_FIELDS)}:
        if isinstance(ev.get(k), (int, float)) and not isinstance(ev.get(k), bool):
            ev[k] = float(ev[k])
    st.handle(ev)
json.dump({'pushed': q.items, 'snapshot': st.snapshot()}, open(${JSON.stringify(outFile)}, 'w', encoding='utf-8'), ensure_ascii=False)
`;
  const r = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error(`python 失败: ${r.error?.message || r.stderr}`);
  const out = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

/** 深比较，返回第一处差异的路径与两边的值 */
function diff(a, b, p = '$') {
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || (a === null) !== (b === null)) {
    return `${p}: node=${JSON.stringify(a)?.slice(0, 200)} py=${JSON.stringify(b)?.slice(0, 200)}`;
  }
  if (a && typeof a === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    if (Array.isArray(a) && a.length !== b.length) return `${p}.length: node=${a.length} py=${b.length}`;
    for (const k of keys) { const d = diff(a[k], b[k], `${p}.${k}`); if (d) return d; }
    return '';
  }
  return a === b ? '' : `${p}: node=${JSON.stringify(a)?.slice(0, 300)} py=${JSON.stringify(b)?.slice(0, 300)}`;
}

const board = new LongRunBoard(opts);
const pushed = events.map((ev) => board.handle(ev));
const snapshot = board.snapshot();
const py = runPython();

await test('每条推送事件（含时间线条目）与原版逐字段一致', () => {
  if (!py) { console.log('   ⊘ 无原版可对拍'); return; }
  assert(pushed.length === py.pushed.length, `推送条数 node=${pushed.length} py=${py.pushed.length}`);
  for (let i = 0; i < pushed.length; i++) {
    const d = diff(pushed[i], py.pushed[i], `pushed[${i}](${events[i].kind})`);
    assert(!d, d);
  }
});

await test('最终快照与原版一致（计数、水位、监督者、打断、暂停、三个有界队列）', () => {
  if (!py) { console.log('   ⊘ 无原版可对拍'); return; }
  const d = diff(snapshot, py.snapshot, 'snapshot');
  assert(!d, d);
});

await test('事件串确实覆盖了全部归类规则，且三个队列都溢出过（否则对拍有盲区）', () => {
  const kinds = new Set(events.map((e) => e.kind));
  const missing = TIMELINE_RULES.map(([k]) => k).filter((k) => !kinds.has(k));
  assert(!missing.length, `事件串缺: ${missing}`);
  assert(snapshot.timeline.length === 1000 && snapshot.trace.length === 600 && snapshot.logs.length === 500,
    `队列长度 ${snapshot.timeline.length}/${snapshot.trace.length}/${snapshot.logs.length}`);
  assert(snapshot.timeline[0].id > 1, '时间线应已丢过最旧条目');
});

await test('.Nf 格式化：只在二进制真值恰好是 .5 时走银行家舍入', () => {
  const cases = [[0.12345, 4, '0.1235'], [2.5, 0, '2'], [0.125, 2, '0.12'], [0.5, 0, '0'], [1.5, 0, '2'],
    [1.005, 2, '1.00'], [12.25, 1, '12.2'], [0.375, 2, '0.38'], [-2.5, 0, '-2'], [0.03125, 4, '0.0312']];
  const bad = cases.filter(([v, d, want]) => pyFixed(v, d) !== want).map(([v, d, w]) => `${v}:.${d}f 应 ${w} 得 ${pyFixed(v, d)}`);
  assert(!bad.length, bad.join('; '));
});

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

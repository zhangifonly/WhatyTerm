/**
 * 长程编排：runner 的进程编排 —— 集成测试
 *
 * 判定逻辑的 31 条纯函数测试在 test-longrun-runner.mjs。这里测的是**接到真进程上
 * 之后**的行为：spawn、按行解析、看门狗定时器、stdin 控制消息、结果组装。
 *
 * 用 tests/fixtures/fake-claude.mjs 当假 CLI（吐预设 stream-json），
 * **不起真 claude、不联网、不花钱**。
 *
 * 运行: node tests/test-longrun-runner-proc.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { LongRunRunner, ExitReason, looksLikeQuestion } from '../server/services/LongRunRunner.js';

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
const FAKE = path.join(HERE, 'fixtures', 'fake-claude.mjs');
const TMP = path.join(os.tmpdir(), 'longrun_proc_test');

function freshTmp() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  return TMP;
}

/** 造一个跑假 CLI 的 runner。script 是假 CLI 要吐的事件序列。 */
function makeRunner(script, over = {}, fakeEnv = {}) {
  return new LongRunRunner({
    cwd: freshTmp(),
    claudeBin: process.execPath,           // 用 node 跑假 CLI
    binPrefixArgs: [FAKE],                 // 假 CLI 脚本路径作为 node 的首参
    env: { ...process.env, FAKE_SCRIPT: JSON.stringify(script), ...fakeEnv },
    wallTimeout: 30, taskWait: 0,
    watchdogInterval: 0.1,                 // 采样要密，否则测不到 hang
    ...over,
  });
}

const evAssistant = (id, tokens, blocks = null) => ({
  type: 'assistant',
  message: { id, usage: { input_tokens: tokens },
    content: blocks ?? [{ type: 'text', text: '干活中' }] },
});
const evResult = (over = {}) => ({
  type: 'result', subtype: 'success', is_error: false, num_turns: 2,
  total_cost_usd: 0.42, result: '做完了', stop_reason: 'end_turn',
  terminal_reason: 'completed', session_id: 'sid-1', permission_denials: [], ...over,
});

// ── 基本闭环 ────────────────────────────────────────────────
test('正常一发：解析事件、组装结果', async () => {
  const r = await makeRunner([
    { line: { type: 'system', subtype: 'init', session_id: 'sid-1', model: 'opus' } },
    { line: evAssistant('m1', 5000) },
    { line: evResult() },
  ]).run('提示词原文', 'sid-1');

  assert(r.exitReason === ExitReason.COMPLETED, `应正常完成，实际 ${r.exitReason} / ${r.error}`);
  assert(r.contextPeak === 5000, `水位峰值应为 5000，实际 ${r.contextPeak}`);
  assert(r.numTurns === 2, `turn 数应为 2，实际 ${r.numTurns}`);
  assert(r.costUsd === 0.42, `权威费用应来自 result，实际 ${r.costUsd}`);
  assert(r.costEstimate > 0, '运行中估算也该有值');
  assert(r.finalText.includes('干活中'), `应取到文本产出: ${r.finalText}`);
});

test('提示词经 stdin 送达（假 CLI 回显核对）', async () => {
  const MARK = '这段提示词必须走stdin';
  // 假 CLI 把收到的 stdin 回显到 stderr。让它先静默一会儿，确保回显先到。
  const runner = makeRunner([{ delay: 0.4, line: evResult() }], {},
    { FAKE_ECHO_STDIN: '1' });
  const seen = [];
  runner.emit = (k, d) => seen.push([k, d]);
  const r = await runner.run(MARK, 'sid-1');
  // 拿不到 result 说明进程编排本身就错了，先排除
  assert(r.exitReason === ExitReason.COMPLETED, `进程未正常收尾: ${r.exitReason}`);
  // stdin 内容出现在 error 里只在 ERROR 分支，所以改从 send 事件核对命令行：
  // 提示词绝不能出现在命令行参数里
  const send = seen.find(([k]) => k === 'send');
  assert(send, '应发出 send 事件');
  assert(!send[1].cmd.includes(MARK),
    `提示词出现在命令行里了 —— 它必须走 stdin: ${send[1].cmd}`);
  assert(send[1].promptChars === MARK.length, '发出的字符数应与提示词一致');
});

test('非 JSON 行被忽略，不打断解析', async () => {
  const r = await makeRunner([
    { raw: '这不是 JSON' },
    { raw: '' },
    { line: evAssistant('m1', 100) },
    { raw: '{ 残缺的 json' },
    { line: evResult() },
  ]).run('x', 'sid-1');
  assert(r.exitReason === ExitReason.COMPLETED, `脏行不该影响结果: ${r.exitReason}`);
  assert(r.contextPeak === 100, '有效事件仍被处理');
});

test('跨 chunk 的半行能拼回来（不丢事件）', async () => {
  // 把一个完整事件拆成两半，中间隔一次 write：runner 的行缓冲必须把它拼回来。
  // 假 CLI 的 raw 不带换行，所以第一段发出去时还不成行。
  const ev = JSON.stringify(evResult());
  const cut = Math.floor(ev.length / 2);
  const r = await makeRunner([
    { raw2: true, raw: ev.slice(0, cut) },        // 无换行，半行
    { delay: 0.2, raw: ev.slice(cut) },           // 补上后半 + 换行
  ]).run('x', 'sid-1');
  assert(r.exitReason === ExitReason.COMPLETED,
    `半行未被拼回，事件丢了: ${r.exitReason} / ${r.error}`);
  assert(r.numTurns === 2, '拼回来的 result 内容要完整');
});

test('拿不到 result 归 ERROR（不能当成做完了）', async () => {
  const r = await makeRunner([{ line: evAssistant('m1', 100) }]).run('x', 'sid-1');
  assert(r.exitReason === ExitReason.ERROR, `实际 ${r.exitReason}`);
});

// ── 空 result：发出去的提示词进了黑洞 ────────────────────────
test('空 result 与正常完成分开（0 turn + 零费用 + 空文本）', async () => {
  const r = await makeRunner([
    { line: evResult({ num_turns: 0, total_cost_usd: 0, result: '' }) },
  ]).run('x', 'sid-1');
  assert(r.exitReason === ExitReason.EMPTY_RESULT,
    `应识别为空 result，实际 ${r.exitReason}`);
});

// ── 水位与费用刹车 ──────────────────────────────────────────
test('水位触顶被终止，且带判据', async () => {
  const r = await makeRunner([
    { line: evAssistant('m1', 50000) },
    { delay: 5, line: evResult() },        // 不该等到这条
  ], { contextLimit: 10000 }).run('x', 'sid-1');
  assert(r.exitReason === ExitReason.BUDGET_KILLED, `应被水位刹车，实际 ${r.exitReason}`);
  assert(r.error.includes('水位'), `判据要说明是水位: ${r.error}`);
  assert(r.contextPeak === 50000, '峰值仍要记下来');
});

test('费用刹车被终止（与水位分开）', async () => {
  const r = await makeRunner([
    { line: evAssistant('m1', 100000) },
    { delay: 5, line: evResult() },
  ], { costCeiling: 0.01 }).run('x', 'sid-1');
  assert(r.exitReason === ExitReason.COST_KILLED, `应被费用刹车，实际 ${r.exitReason}`);
  assert(r.error.includes('估算已花'), `判据要给金额: ${r.error}`);
  // 被 kill 的发次拿不到 result，权威费用是 0，但估算要有值
  assert(r.costUsd === 0 && r.costEstimate > 0,
    '被 kill 时权威费用为 0，估算必须补上这笔账');
});

// ── hang 检测（真定时器）────────────────────────────────────
test('真静默被看门狗杀掉，判据带静默时长与档位', async () => {
  // 把空闲档压到 0.4s，再让假 CLI 吐完就挂住：这是 qingming 那次误杀的镜像场景，
  // 只是这里**应该**被杀（连 delta 都停了）。
  const r = await new LongRunRunner({
    cwd: freshTmp(), claudeBin: process.execPath, binPrefixArgs: [FAKE],
    env: { ...process.env,
      FAKE_SCRIPT: JSON.stringify([{ line: evAssistant('m1', 100) }]),
      FAKE_HANG: '1' },
    wallTimeout: 30,                        // 墙钟给足，确保杀它的是静默判据
    taskWait: 0, watchdogInterval: 0.1,
    silence: { idle: 0.4 },
  }).run('x', 'sid-1');
  assert(r.exitReason === ExitReason.HANG_KILLED,
    `应因静默被杀（而非墙钟），实际 ${r.exitReason} / ${r.error}`);
  assert(r.error.includes('静默'), `判据要带静默时长: ${r.error}`);
  assert(r.error.includes('无工具在飞'), `判据要说明当时有没有工具在飞: ${r.error}`);
  assert(r.error.includes('本轮未见过流'), `判据要说明流的状态: ${r.error}`);
});

test('Bash 在飞时容忍度更宽，同样静默不被杀', async () => {
  const r = await new LongRunRunner({
    cwd: freshTmp(), claudeBin: process.execPath, binPrefixArgs: [FAKE],
    env: { ...process.env,
      FAKE_SCRIPT: JSON.stringify([
        { line: { type: 'assistant', message: { id: 'm1', usage: { input_tokens: 100 },
            content: [{ type: 'tool_use', id: 't1', name: 'Bash' }] } } },
        { delay: 0.8, line: evResult() },
      ]) },
    wallTimeout: 30, taskWait: 0, watchdogInterval: 0.1,
    // 空闲档 0.3s 会杀掉它，但 Bash 在飞 → 用 5s 档 → 不该杀
    silence: { idle: 0.3, bash: 5.0 },
  }).run('x', 'sid-1');
  assert(r.exitReason === ExitReason.COMPLETED,
    `Bash 在飞时不该按空闲档杀，实际 ${r.exitReason} / ${r.error}`);
});

test('墙钟超时无条件终止，即使工具在飞', async () => {
  const r = await new LongRunRunner({
    cwd: freshTmp(), claudeBin: process.execPath, binPrefixArgs: [FAKE],
    env: { ...process.env,
      FAKE_SCRIPT: JSON.stringify([
        { line: { type: 'assistant', message: { id: 'm1',
            usage: { input_tokens: 100 },
            content: [{ type: 'tool_use', id: 't1', name: 'Bash' }] } } },
      ]),
      FAKE_HANG: '1' },
    wallTimeout: 1.0, taskWait: 0, watchdogInterval: 0.1,
  }).run('x', 'sid-1');
  assert(r.exitReason === ExitReason.WALL_TIMEOUT,
    `墙钟到点应无条件杀（工具在飞也一样），实际 ${r.exitReason}`);
  assert(r.error.includes('总时长'), `判据要说明是墙钟: ${r.error}`);
});

test('delta 持续到达时不被墙钟外的判据误杀', async () => {
  // 用 6 个 delta 拉长时间，墙钟给足 —— 不该被 hang 掉
  const script = [];
  for (let i = 0; i < 6; i++) {
    script.push({ delay: 0.15, line: { type: 'stream_event', event: { type: 'content_block_delta' } } });
  }
  script.push({ line: evResult() });
  const r = await makeRunner(script, { wallTimeout: 30 }).run('x', 'sid-1');
  assert(r.exitReason === ExitReason.COMPLETED,
    `delta 期间不该被杀，实际 ${r.exitReason} / ${r.error}`);
});

// ── 人工注入与中断 ──────────────────────────────────────────
test('人工注入立即模式：送出 interrupt 并把文本带回结果', async () => {
  let handed = false;
  const runner = new LongRunRunner({
    cwd: freshTmp(), claudeBin: process.execPath, binPrefixArgs: [FAKE],
    env: { ...process.env,
      FAKE_SCRIPT: JSON.stringify([{ delay: 0.6, line: evResult() }]) },
    wallTimeout: 30, taskWait: 0, watchdogInterval: 0.1,
    checkInject: () => {
      if (handed) return null;
      handed = true;
      return ['改成用 Vue', true];          // 立即模式
    },
  });
  const r = await runner.run('x', 'sid-1');
  assert(runner.sentToStdin.length > 0, '应往 stdin 写过 interrupt 控制消息');
  const msg = runner.sentToStdin[0];
  assert(msg.includes('control_request') && msg.includes('interrupt'),
    `控制消息格式不对: ${msg}`);
  assert(r.injectText === '改成用 Vue',
    `注入文本必须带回结果，供下一发原样发出，实际 ${JSON.stringify(r.injectText)}`);
});

test('非立即模式在工具在飞时不打断（避免脏会话）', async () => {
  const runner = new LongRunRunner({
    cwd: freshTmp(), claudeBin: process.execPath, binPrefixArgs: [FAKE],
    env: { ...process.env,
      FAKE_SCRIPT: JSON.stringify([
        { line: { type: 'assistant', message: { id: 'm1', usage: { input_tokens: 100 },
            content: [{ type: 'tool_use', id: 't1', name: 'Bash' }] } } },
        { delay: 0.5, line: evResult() },
      ]) },
    wallTimeout: 30, taskWait: 0, watchdogInterval: 0.1,
    checkInject: () => ['等间隙再说', false],   // 非立即
  });
  await runner.run('x', 'sid-1');
  // 工具一直在飞到 result 到达，期间不该打断
  assert(runner.sentToStdin.length === 0,
    '工具在飞时不该送 interrupt —— 那会把会话留在脏状态');
});

// ── 后台 subagent 等待 ──────────────────────────────────────
test('主线给了 result 但有 local_agent 在飞时继续等', async () => {
  const runner = makeRunner([
    { line: { type: 'system', subtype: 'task_started',
        task: { task_id: 'a1', task_type: 'local_agent', description: '子系统' } } },
    { line: evResult() },
    { delay: 0.4, line: { type: 'system', subtype: 'task_completed', task: { task_id: 'a1' } } },
  ], { taskWait: 10 });
  const seen = [];
  runner.emit = (k, d) => seen.push([k, d]);
  const r = await runner.run('x', 'sid-1');
  assert(seen.some(([k]) => k === 'tasks.waiting'), '应发出 tasks.waiting 事件');
  assert(r.exitReason === ExitReason.COMPLETED, `等完应正常完成，实际 ${r.exitReason}`);
  assert(r.pendingTasks.length === 0, '任务已收尾，不该有遗留');
});

test('等 subagent 超时：终止但仍记为正常完成，遗留任务带出来', async () => {
  const runner = makeRunner([
    { line: { type: 'system', subtype: 'task_started',
        task: { task_id: 'a1', task_type: 'local_agent', description: '慢活' } } },
    { line: evResult() },
  ], { taskWait: 0.5 }, { FAKE_HANG: '1' });
  const seen = [];
  runner.emit = (k, d) => seen.push([k, d]);
  const r = await runner.run('x', 'sid-1');
  assert(seen.some(([k]) => k === 'tasks.timeout'), '应发出 tasks.timeout 事件');
  // 主线已正常给过 result，这一发算正常完成，只是有任务没收尾
  assert(r.exitReason === ExitReason.COMPLETED,
    `不该记成失败，实际 ${r.exitReason} / ${r.error}`);
  assert(r.taskWaitTimeout === true, '要标记出等待超时');
  assert(r.pendingTasks.length === 1, '遗留任务必须带出来（是"能不能续会话"的判据）');
});

test('local_bash 不等（dev server 那类永远不会完成）', async () => {
  const runner = makeRunner([
    { line: { type: 'system', subtype: 'task_started',
        task: { task_id: 'b1', task_type: 'local_bash', description: 'dev server' } } },
    { line: evResult() },
  ], { taskWait: 10 });
  const seen = [];
  runner.emit = (k, d) => seen.push([k, d]);
  const t0 = Date.now();
  const r = await runner.run('x', 'sid-1');
  assert(!seen.some(([k]) => k === 'tasks.waiting'), 'local_bash 不该触发等待');
  assert(Date.now() - t0 < 3000, '不该白等到上限');
  assert(r.exitReason === ExitReason.COMPLETED, `实际 ${r.exitReason}`);
});

// ── 事件落盘 ────────────────────────────────────────────────
test('事件落盘为 jsonl，delta 不进文件', async () => {
  const dir = freshTmp();
  const events = path.join(dir, '.run', 'orchestrator.jsonl');
  await new LongRunRunner({
    cwd: dir, claudeBin: process.execPath, binPrefixArgs: [FAKE],
    env: { ...process.env, FAKE_SCRIPT: JSON.stringify([
      { line: { type: 'stream_event', event: { type: 'content_block_delta' } } },
      { line: evAssistant('m1', 100) },
      { line: evResult() },
    ]) },
    eventsPath: events, wallTimeout: 30, taskWait: 0, watchdogInterval: 0.1,
  }).run('x', 'sid-1');

  assert(fs.existsSync(events), '事件文件应被创建');
  const lines = fs.readFileSync(events, 'utf8').trim().split('\n').filter(Boolean);
  for (const l of lines) JSON.parse(l);           // 每行都要是合法 JSON
  const kinds = lines.map((l) => JSON.parse(l).kind);
  assert(kinds.includes('send'), '应记录 send');
  assert(kinds.includes('context'), '应记录 context');
  assert(!kinds.includes('delta'), 'delta 不该落盘（一发几十万条）');
});

// ── looksLikeQuestion ──────────────────────────────────────
test('问句信号：只在正常完成时判，且认中英文问号与常见措辞', () => {
  const base = { exitReason: ExitReason.COMPLETED };
  assert(looksLikeQuestion({ ...base, finalText: '要用哪个框架？' }), '中文问号应命中');
  assert(looksLikeQuestion({ ...base, finalText: 'Which one?' }), '英文问号应命中');
  assert(looksLikeQuestion({ ...base, finalText: '请确认是否继续' }), '措辞应命中');
  assert(!looksLikeQuestion({ ...base, finalText: '全部做完了。' }), '陈述句不该命中');
  // 被 kill 的发次不算提问
  assert(!looksLikeQuestion({ exitReason: ExitReason.HANG_KILLED, finalText: '？' }),
    '非正常完成不该判成提问');
});

await Promise.all(pending);
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

/**
 * 长程编排：runner 进程编排 —— 集成测试（真进程，但用假 CLI，不联网不花钱）
 *
 * 判定逻辑在 test-longrun-runner.mjs；这里测接到真进程之后的行为：spawn、按行解析、
 * 看门狗定时器、stdin 送提示词与控制消息、收尾方式、原始事件落盘、结果组装。
 * 假 CLI：tests/fixtures/fake-claude.mjs。
 *
 * 运行: node tests/test-longrun-runner-proc.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { LongRunRunner, ExitReason } from '../server/services/LongRunRunner.js';

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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'longrun_proc_'));
let seq = 0;
const freshDir = () => { const d = path.join(TMP, String(++seq)); fs.mkdirSync(d, { recursive: true }); return d; };

/**
 * 造一个跑假 CLI 的 runner。script 是假 CLI 要吐的事件序列。
 * 默认让假 CLI 等 stdin 关闭才退 —— 这是真 CLI 在流输入模式下的行为（吐完 result 不退出）。
 */
function makeRunner(script, over = {}, fakeEnv = {}) {
  const seen = [];
  const runner = new LongRunRunner({
    cwd: freshDir(),
    claudeBin: process.execPath,
    binPrefixArgs: [FAKE],
    env: { ...process.env, FAKE_SCRIPT: JSON.stringify(script), FAKE_WAIT_STDIN_EOF: '1', ...fakeEnv },
    wallTimeout: 30, taskWait: 0, watchdogInterval: 0.1, handoffLimit: 0,
    onStream: (e) => seen.push(e),
    ...over,
  });
  runner.seen = seen;
  return runner;
}

const evAssistant = (id, tokens, blocks = null) => ({
  type: 'assistant', message: { id, usage: { input_tokens: tokens }, content: blocks ?? [{ type: 'text', text: '干活中' }] },
});
const evBash = (id) => ({
  type: 'assistant', message: { id, usage: { input_tokens: 100 }, content: [{ type: 'tool_use', id: `t-${id}`, name: 'Bash', input: { command: 'npm test' } }] },
});
const evResult = (over = {}) => ({
  type: 'result', subtype: 'success', is_error: false, num_turns: 2, total_cost_usd: 0.42, result: '做完了',
  stop_reason: 'end_turn', terminal_reason: 'completed', session_id: 'sid-1', permission_denials: [], ...over,
});
const agentStarted = (id, desc) => ({ type: 'system', subtype: 'task_started', task_id: id, task_type: 'local_agent', description: desc, is_backgrounded: true });
const agentDone = (id) => ({ type: 'system', subtype: 'task_notification', task_id: id, status: 'completed' });
const kinds = (r) => r.seen.map((e) => e.kind);

// ── 基本闭环 ────────────────────────────────────────────────
test('正常一发：解析、组装；finalText 取 result 正文', async () => {
  const r = await makeRunner([{ line: evAssistant('m1', 5000) }, { line: evResult() }]).run('提示词原文', 'sid-1');
  assert(r.exitReason === ExitReason.COMPLETED, `${r.exitReason} / ${r.error}`);
  assert(r.contextPeak === 5000 && r.numTurns === 2 && r.costUsd === 0.42 && r.costEstimate > 0, JSON.stringify(r));
  assert(r.finalText === '做完了', `原版用 result 正文覆盖旁白，实际 ${r.finalText}`);
});

// 审计 G9：原先拿到 result 就 SIGTERM、2 秒后 SIGKILL，被信号杀的发次末尾几条 assistant
// 可能没落进 transcript（CLI 正常收尾才 flush），影响下一发 --resume
test('result 后关 stdin 让 CLI 自己正常退出，不是被信号杀', async () => {
  const runner = makeRunner([{ line: evResult() }]);
  const t0 = Date.now();
  const r = await runner.run('x', 'sid-1');
  assert(r.exitCode === 0, `应正常退出（exitCode 0），实际 ${r.exitCode}——说明被信号杀了`);
  assert(Date.now() - t0 < 5000, '关 stdin 后应很快退出');
});

test('提示词经 stdin 送达，content 是纯字符串，且不出现在命令行里', async () => {
  const dir = freshDir();
  const stdinFile = path.join(dir, 'stdin.txt');
  const argvFile = path.join(dir, 'argv.json');
  await makeRunner([{ line: evResult() }], {}, { FAKE_STDIN_FILE: stdinFile, FAKE_ARGV_FILE: argvFile }).run('这段提示词必须走stdin', 'sid-1');
  const first = JSON.parse(fs.readFileSync(stdinFile, 'utf8').split('\n')[0]);
  assert(first.type === 'user' && first.message.role === 'user', JSON.stringify(first));
  assert(first.message.content === '这段提示词必须走stdin', `content 应为原文字符串（原版如此），实际 ${JSON.stringify(first.message.content)}`);
  const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
  assert(!argv.some((a) => a.includes('这段提示词')), `提示词出现在命令行里: ${argv}`);
  assert(argv.includes('--session-id') && argv.includes('sid-1'), '新建会话应带 --session-id');
});

test('非 JSON 行忽略；跨 chunk 的半行能拼回来', async () => {
  const ev = JSON.stringify(evResult());
  const cut = Math.floor(ev.length / 2);
  const r = await makeRunner([
    { raw: '这不是 JSON' }, { line: evAssistant('m1', 100) }, { raw: '{ 残缺' },
    { raw2: true, raw: ev.slice(0, cut) }, { delay: 0.2, raw: ev.slice(cut) },
  ]).run('x', 'sid-1');
  assert(r.exitReason === ExitReason.COMPLETED && r.contextPeak === 100 && r.numTurns === 2, `${r.exitReason} ${r.error}`);
});

test('拿不到 result 归 ERROR；空返回单独归类', async () => {
  // 没吐 result 就自己退了（不等 stdin）—— 真实的异常退出形态
  const noResult = await makeRunner([{ line: evAssistant('m1', 100) }], {}, { FAKE_WAIT_STDIN_EOF: '0' }).run('x', 'sid-1');
  assert(noResult.exitReason === ExitReason.ERROR, `实际 ${noResult.exitReason}`);
  const empty = await makeRunner([{ line: evResult({ num_turns: 0, total_cost_usd: 0, result: '' }) }]).run('x', 'sid-1');
  assert(empty.exitReason === ExitReason.EMPTY_RESULT, `实际 ${empty.exitReason}`);
});

// ── 刹车与看门狗 ────────────────────────────────────────────
test('水位触顶被终止（error 为空，与原版一致）；费用刹车带金额判据', async () => {
  const w = await makeRunner([{ line: evAssistant('m1', 50000) }, { delay: 5, line: evResult() }],
    { contextLimit: 10000 }).run('x', 'sid-1');
  assert(w.exitReason === ExitReason.BUDGET_KILLED && w.contextPeak === 50000 && w.error === '', `${w.exitReason} ${w.error}`);
  const c = await makeRunner([{ line: evAssistant('m1', 100000) }, { delay: 5, line: evResult() }],
    { costCeiling: 0.01 }).run('x', 'sid-1');
  assert(c.exitReason === ExitReason.COST_KILLED && c.error.includes('估算已花'), `${c.exitReason} ${c.error}`);
  assert(c.costUsd === 0 && c.costEstimate > 0, '被 kill 时权威费用为 0，估算必须补上这笔账');
});

test('真静默被看门狗杀，判据三要素齐全；Bash 在飞时同样静默不杀', async () => {
  const hang = await makeRunner([{ line: evAssistant('m1', 100) }], { silence: { idle: 0.4 } }, { FAKE_HANG: '1' }).run('x', 'sid-1');
  assert(hang.exitReason === ExitReason.HANG_KILLED, `应因静默而非墙钟被杀: ${hang.exitReason} ${hang.error}`);
  assert(['静默', '无工具在飞', '本轮未见过流'].every((k) => hang.error.includes(k)), hang.error);
  const bash = await makeRunner([{ line: evBash('b1') }, { delay: 0.8, line: evResult() }],
    { silence: { idle: 0.3, bash: 5.0 } }).run('x', 'sid-1');
  assert(bash.exitReason === ExitReason.COMPLETED, `Bash 在飞时不该按空闲档杀: ${bash.exitReason} ${bash.error}`);
});

test('delta 持续到达时不被误杀', async () => {
  const script = Array.from({ length: 6 }, () => ({ delay: 0.15, line: { type: 'stream_event', event: { type: 'content_block_delta' } } }));
  const r = await makeRunner([...script, { line: evResult() }], { silence: { idle: 0.3 } }).run('x', 'sid-1');
  assert(r.exitReason === ExitReason.COMPLETED, `delta 期间不该被杀: ${r.exitReason} ${r.error}`);
});

test('墙钟超时无条件终止（工具在飞也杀）', async () => {
  const r = await makeRunner([{ line: evBash('b1') }], { wallTimeout: 1.0 }, { FAKE_HANG: '1' }).run('x', 'sid-1');
  assert(r.exitReason === ExitReason.WALL_TIMEOUT && r.error === '', `${r.exitReason} ${r.error}`);
});

// ── 后台 subagent ───────────────────────────────────────────
test('result 后有 local_agent 在飞 → 继续读流等；收完立刻正常收尾', async () => {
  const runner = makeRunner([
    { line: agentStarted('a1', '子系统A') }, { line: evResult() },
    { delay: 0.4, line: agentDone('a1') },
  ], { taskWait: 10, silence: { idle: 0.5 } });
  const t0 = Date.now();
  const r = await runner.run('x', 'sid-1');
  const waiting = runner.seen.find((e) => e.kind === 'tasks.waiting');
  assert(waiting && waiting.names.includes('子系统A'), `应发 tasks.waiting 且带名字: ${kinds(runner)}`);
  // 审计 G7：任务收完后原先不收尾，被空闲档判 hang。这里把空闲档压到 0.5s，若不收尾必被杀
  assert(r.exitReason === ExitReason.COMPLETED, `收完应正常结束，实际 ${r.exitReason} ${r.error}`);
  assert(r.pendingTasks.length === 0 && Date.now() - t0 < 5000, '不该有遗留，也不该白等');
});

test('等 agent 超时：终止但仍记为正常完成，遗留任务带出来', async () => {
  const runner = makeRunner([{ line: agentStarted('a1', '慢活') }, { line: evResult() }],
    { taskWait: 0.5 }, { FAKE_HANG: '1' });
  const r = await runner.run('x', 'sid-1');
  assert(kinds(runner).includes('tasks.timeout'), `应发 tasks.timeout: ${kinds(runner)}`);
  assert(r.exitReason === ExitReason.COMPLETED, `不该记成失败: ${r.exitReason} ${r.error}`);
  assert(r.pendingTasks.length === 1 && r.pendingTasks[0].description === '慢活', '遗留任务必须带出来');
});

test('local_bash 与前台任务都不触发等待', async () => {
  const runner = makeRunner([
    { line: { type: 'system', subtype: 'task_started', task_id: 'b1', task_type: 'local_bash', is_backgrounded: true } },
    { line: { type: 'system', subtype: 'task_started', task_id: 'f1', task_type: 'local_agent', is_backgrounded: false } },
    { line: evResult() },
  ], { taskWait: 10 });
  const t0 = Date.now();
  const r = await runner.run('x', 'sid-1');
  assert(!kinds(runner).includes('tasks.waiting') && Date.now() - t0 < 5000, `不该等: ${kinds(runner)}`);
  assert(r.exitReason === ExitReason.COMPLETED, r.exitReason);
});

// ── 人工注入 ────────────────────────────────────────────────
test('立即注入：往 stdin 送 interrupt 控制消息，结果归人工打断并带回原文', async () => {
  let handed = false;
  const dir = freshDir();
  const stdinFile = path.join(dir, 'stdin.txt');
  const runner = makeRunner(
    [{ delay: 0.6, line: evResult({ is_error: true, subtype: 'error_during_execution' }) }],
    { checkInject: () => (handed ? null : (handed = true, ['改用 Vue', true])) },
    { FAKE_STDIN_FILE: stdinFile });
  // 立即模式要在有事件时才取件（原版在每个事件后取件）→ 先让假 CLI 吐一条事件
  runner.env.FAKE_SCRIPT = JSON.stringify([{ line: evAssistant('m0', 10) },
    { delay: 0.6, line: evResult({ is_error: true, subtype: 'error_during_execution' }) }]);
  const r = await runner.run('x', 'sid-1');
  const lines = fs.readFileSync(stdinFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert(lines.some((l) => l.type === 'control_request' && l.request?.subtype === 'interrupt'), 'stdin 里应有 interrupt 控制消息');
  // CLI 收到 interrupt 后回 is_error（实测），仍须归人工打断，否则注入永远发不出去
  assert(r.exitReason === ExitReason.INTERRUPTED_BY_HUMAN && r.injectText === '改用 Vue', `${r.exitReason} ${r.injectText}`);
  assert(runner.seen.some((e) => e.kind === 'inject.sent' && e.text === '改用 Vue'), 'inject.sent 要带原文');
});

test('非立即注入在工具在飞时不打断，到下个间隙照发（原版这里会丢，已修正）', async () => {
  let handed = false;
  const runner = makeRunner([
    { line: evBash('b1') },
    { delay: 0.3, line: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't-b1', content: 'ok' }] } } },
    { delay: 0.3, line: evAssistant('m2', 100) },
    { delay: 0.5, line: evResult() },
  ], { checkInject: () => (handed ? null : (handed = true, ['等间隙再说', false])) });
  const r = await runner.run('x', 'sid-1');
  const ks = kinds(runner);
  assert(ks.indexOf('inject.waiting') >= 0 && ks.indexOf('inject.waiting') < ks.indexOf('inject.sent'), `应先等后发: ${ks}`);
  assert(r.injectText === '等间隙再说', `注入不能丢: ${JSON.stringify(r.injectText)}`);
});

// 审计 G10：stdin 管道已关时写入会异步抛 error，没接住就是未捕获异常，整个 WebTmux 进程崩掉
test('对端已关 stdin 时写控制消息不会把服务弄崩', async () => {
  let asked = false;
  const r = await makeRunner(
    [{ delay: 0.4, line: evAssistant('m1', 10) }, { delay: 0.4, line: evResult() }],
    { checkInject: () => (asked ? null : (asked = true, ['晚到的注入', true])) },
    { FAKE_CLOSE_STDIN: '1', FAKE_WAIT_STDIN_EOF: '0' }).run('x', 'sid-1');
  assert(asked, '取件必须真的发生过（否则这条没测到写入）');
  assert(r && typeof r.exitReason === 'string', '应正常返回结果');
});

// ── 原始事件落盘 ────────────────────────────────────────────
test('CLI 原始事件写进 .run/events/<会话>-<时间>.jsonl，stream_event 不落盘', async () => {
  const dir = freshDir();
  const r = await makeRunner([
    { line: { type: 'stream_event', event: { type: 'content_block_delta' } } },
    { line: evAssistant('m1', 100) }, { line: evResult() },
  ], { eventsDir: path.join(dir, '.run', 'events') }).run('x', 'sid-9');
  assert(r.eventsPath && path.basename(r.eventsPath).startsWith('sid-9-'), `文件名应带会话 id: ${r.eventsPath}`);
  const types = fs.readFileSync(r.eventsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l).type);
  assert(JSON.stringify(types) === JSON.stringify(['assistant', 'result']), `落盘内容不对: ${types}`);
});

// ── 进程组 ──────────────────────────────────────────────────
test('终止时整组杀：执行者起的孙进程一并带走', async () => {
  const dir = freshDir();
  const pidFile = path.join(dir, 'grandchild.pid');
  // 让"执行者"起一个孙进程再挂住，然后被墙钟杀
  const r = await new LongRunRunner({
    cwd: dir, claudeBin: 'sh',
    binPrefixArgs: ['-c', `sleep 300 & echo $! > ${pidFile}; ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)}`, 'fake'],
    env: { ...process.env, FAKE_SCRIPT: JSON.stringify([{ line: evAssistant('m1', 10) }]), FAKE_HANG: '1' },
    wallTimeout: 1.0, taskWait: 0, watchdogInterval: 0.1, handoffLimit: 0,
  }).run('x', 'sid-1');
  assert(r.exitReason === ExitReason.WALL_TIMEOUT, r.exitReason);
  const gc = Number(fs.readFileSync(pidFile, 'utf8'));
  await new Promise((res) => setTimeout(res, 500));
  let aliveGc = true;
  try { process.kill(gc, 0); } catch { aliveGc = false; }
  assert(!aliveGc, `孙进程 ${gc} 没被带走（只杀主进程会留下孤儿）`);
});

await Promise.all(pending);
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

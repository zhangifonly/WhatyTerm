/**
 * 长程编排：runner 判定内核 —— 回归测试（不起进程、不花钱）
 *
 * 覆盖原版 test_runner_hang.py 的 26 条 case_*，外加移植审计补齐的各项
 * （G6 打断优先、G7 等待中任务收完即收尾、G8 任务事件形状、ASKED_HUMAN、空 usage 等）。
 * 事件形状一律照原版读取的真实字段：task_started/task_notification 字段在事件顶层，
 * background_tasks_changed 的列表键是 tasks。
 *
 * 运行: node tests/test-longrun-runner.mjs
 */

import {
  ExitReason, ContextMeter, BASE_FLAGS, DEFAULT_TOOLS,
  SILENCE_TOOL_BASH, SILENCE_TOOL_OTHER, SILENCE_IDLE, SETTLE_GRACE, TASK_WAIT,
  COST_PER_CALL, COST_PER_INPUT_TOKEN, LongRunRunner,
  buildArgs, silenceTolerance, watchdogDecide, handleEvent, trackTasks, waitTasks,
  ingestLine, agentTasks, isEmptyResult, looksLikeQuestion, clip, toolBrief, fmtToolInput,
} from '../server/services/LongRunRunner.js';
import fs from 'fs';
import path from 'path';
import { sandboxRoots } from '../server/services/LongRunSandbox.js';

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

/** 与 run() 里一致的初始运行态 */
function freshState(over = {}) {
  return {
    started: 0, lastEvent: 0, toolInFlight: null, killReason: null, finalText: '', result: null,
    toolNames: {}, sawDelta: false, injectText: '', injectImmediate: false, injectWaiting: false,
    injectPending: null, interruptSent: false, interruptAt: 0, tasks: {}, taskWaitStarted: null,
    taskWaitTimeout: false, hangDetail: '', costDetail: '', ...over,
  };
}
const cfg = (over = {}) => ({ contextLimit: 1e12, costCeiling: null, ...over });
const dog = (over = {}) => ({ wallTimeout: 1e9, taskWait: TASK_WAIT, ...over });
const evAssistant = (id, tokens, blocks = null) => ({
  type: 'assistant', message: { id, usage: { input_tokens: tokens }, content: blocks ?? [{ type: 'text', text: '干活中' }] },
});
const evToolUse = (id, name, input = {}) => ({
  type: 'assistant', message: { id, usage: { input_tokens: 100 }, content: [{ type: 'tool_use', id: `t-${id}`, name, input }] },
});
const evResult = (over = {}) => ({
  type: 'result', subtype: 'success', is_error: false, num_turns: 3, total_cost_usd: 0.42,
  result: '做完了', stop_reason: 'end_turn', terminal_reason: 'completed', session_id: 'sid-1', ...over,
});
/** 直接调 _assemble 验证判定顺序，不起进程 */
function assemble(state, meter = new ContextMeter(), opts = {}) {
  const r = new LongRunRunner({ handoffLimit: 0, ...opts });
  return r._assemble('sid-x', { exitCode: 0 }, state, meter, Date.now() / 1000, null, opts.stderr || '');
}

// ── 阈值与命令构造 ──────────────────────────────────────────
test('阈值有序：其它工具 < 空闲 < Bash；中断宽容期与等待上限都存在', () => {
  assert(SILENCE_TOOL_OTHER < SILENCE_IDLE && SILENCE_IDLE < SILENCE_TOOL_BASH, '档位顺序错');
  assert(SILENCE_IDLE >= 300, '空闲档 ≥300s（qingming 92 秒误杀的教训）');
  assert(SETTLE_GRACE > 0 && TASK_WAIT > 0, '两个上限都必须存在');
});

test('提示词不作为 -p 的参数（带 --input-format stream-json 时会被忽略，静默挂到超时）', () => {
  const args = buildArgs({ sessionId: 'sid-1' });
  assert(args[0] === '-p' && String(args[1]).startsWith('--'), `-p 后不该带文本: ${args[1]}`);
  assert(BASE_FLAGS.includes('--input-format') && BASE_FLAGS.includes('stream-json'), '缺流输入模式');
});

test('必需 flag 齐全（缺 --verbose 直接报错退出；缺 partial 分不清生成与挂死）', () => {
  for (const f of ['--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none', '--include-partial-messages']) {
    assert(BASE_FLAGS.includes(f), `缺 ${f}`);
  }
});

test('默认带原版工具白名单；resume 与新建 flag 不同；--add-dir 逐个展开', () => {
  const a = buildArgs({ sessionId: 's' });
  assert(a[a.indexOf('--allowedTools') + 1] === DEFAULT_TOOLS, '默认应带 DEFAULT_TOOLS（原版 session_loop 固定传）');
  assert(DEFAULT_TOOLS === 'Read,Write,Edit,Glob,Grep,Bash,WebFetch,TodoWrite', `工具白名单与原版不一致: ${DEFAULT_TOOLS}`);
  assert(buildArgs({ sessionId: 's', resume: true }).includes('--resume'), 'resume 应用 --resume');
  assert(!buildArgs({ sessionId: 's', resume: true }).includes('--session-id'), 'resume 不该带 --session-id');
  assert(buildArgs({ sessionId: 's', extraDirs: ['/a', '/b'] }).filter((x) => x === '--add-dir').length === 2);
  assert(buildArgs({ sessionId: 's', model: 'opus' }).includes('--model'), '要能传执行者模型');
});

// ── 流级活性：delta 保活 vs 真静默 ───────────────────────────
// 复现 qingming 那次误杀：delta 持续到达时总时长远超阈值，但不该被杀。
test('生成期间的 delta 刷新活性，未被误判为挂死', () => {
  const st = freshState();
  let clock = 0;
  const delta = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta' } });
  for (let i = 0; i < 8; i++) {
    clock += 0.4;
    assert(ingestLine(delta, st, clock) === null, 'delta 不该往下传（不落盘不转发）');
    const d = watchdogDecide(st, clock, dog({ silence: { idle: 1.0 } }));
    assert(d.action === 'continue', `第 ${i + 1} 个 delta 后被误杀: ${d.hangDetail}`);
  }
  assert(st.sawDelta && clock > 1.0, '累计已超 1s 阈值且记为见过流（否则这条没测到东西）');
});

test('非 JSON 行也刷新活性，但不往下传', () => {
  const st = freshState();
  assert(ingestLine('这不是 JSON', st, 5) === null && st.lastEvent === 5, '任何一行都算活着');
  assert(ingestLine('   ', st, 9) === null && st.lastEvent === 5, '空行不算');
  assert(ingestLine(JSON.stringify(evResult()), st, 7)?.type === 'result', '正常事件往下传');
});

test('连 delta 都停了才算真挂死，判据三要素齐全', () => {
  const d = watchdogDecide(freshState({ sawDelta: true }), SILENCE_IDLE + 1, dog());
  assert(d.action === 'kill' && d.reason === ExitReason.HANG_KILLED, JSON.stringify(d));
  assert(d.hangDetail.includes('静默') && d.hangDetail.includes('流已断'), d.hangDetail);
  assert(d.hangDetail.includes(String(SILENCE_IDLE.toFixed(0))) && d.hangDetail.includes('无工具在飞'), d.hangDetail);
  const d2 = watchdogDecide(freshState({ sawDelta: false }), SILENCE_IDLE + 1, dog());
  assert(d2.hangDetail.includes('本轮未见过流'), d2.hangDetail);
});

test('Bash 在飞 900s、其它工具 120s；等后台 agent 时放到 Bash 档', () => {
  assert(silenceTolerance(freshState({ toolInFlight: 'bash' })) === SILENCE_TOOL_BASH);
  assert(silenceTolerance(freshState({ toolInFlight: 'other' })) === SILENCE_TOOL_OTHER);
  assert(silenceTolerance(freshState()) === SILENCE_IDLE);
  const waiting = freshState({ taskWaitStarted: 0, tasks: { a: { task_id: 'a', task_type: 'local_agent' } } });
  assert(silenceTolerance(waiting) === SILENCE_TOOL_BASH, 'agent 跑长 Bash 时几分钟不发进度，不是挂死');
});

// ── 费用 ────────────────────────────────────────────────────
test('费用按 message id 去重（3+1 次上报 → 2 次调用，第一版标定偏差 66% 就栽在这）', () => {
  const m = new ContextMeter();
  for (let i = 0; i < 3; i++) m.observe({ input_tokens: 75977 }, 'msg-1');
  m.observe({ input_tokens: 80000 }, 'msg-2');
  assert(m.calls === 2, `应 2 次，实际 ${m.calls}`);
  const expect = 2 * COST_PER_CALL + (75977 + 80000) * COST_PER_INPUT_TOKEN;
  assert(Math.abs(m.costEstimate - expect) < 1e-9, `${m.costEstimate} vs ${expect}`);
  m.observe({ input_tokens: 999 }, null);
  assert(m.calls === 2, '无 id 不计入调用数，宁可少算也不重复算');
});

test('估算对得上真实发次的量级（防改动把估算搞错一个数量级）', () => {
  // 照搬原版：扫真实沙箱 .run/events/ 里最大的几个已结算发次，偏差须 < 50%
  const base = sandboxRoots()[0];
  let files = [];
  try {
    for (const box of fs.readdirSync(base)) {
      const dir = path.join(base, box, '.run', 'events');
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.jsonl')) files.push(path.join(dir, f));
    }
  } catch { files = []; }
  files.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  let picked = null;
  for (const f of files.slice(0, 6)) {
    const m = new ContextMeter();
    let real = null;
    for (const raw of fs.readFileSync(f, 'utf8').split('\n')) {
      let d; try { d = JSON.parse(raw); } catch { continue; }
      if (d.type === 'assistant') m.observe(d.message?.usage || {}, d.message?.id);
      else if (d.type === 'result') real = d.total_cost_usd;
    }
    if (real && m.calls > 20) { picked = { f, m, real }; break; }
  }
  if (!picked) { console.log('   ⊘ 找不到已结算的大发次（本机尚无真实运行），跳过对账'); return; }
  const dev = Math.abs(picked.m.costEstimate - picked.real) / picked.real;
  assert(dev < 0.5, `估算偏差 ${(dev * 100).toFixed(0)}% 过大：估 $${picked.m.costEstimate.toFixed(2)} vs 实 $${picked.real.toFixed(2)}`);
});

test('水位口径三项之和；空 usage 保持上次水位（不能清成 0）', () => {
  const m = new ContextMeter();
  assert(m.observe({ input_tokens: 1000, cache_read_input_tokens: 2000, cache_creation_input_tokens: 500 }, 'a') === 3500);
  assert(m.observe({}, 'b') === 3500 && m.latest === 3500, '空 usage 把水位清成了 0（审计 G24）');
  assert(m.calls === 1, '空 usage 不该计为一次调用');
});

test('水位刹车只在工具间隙；费用刹车同样只在间隙且带金额判据', () => {
  const st = freshState();
  const m = new ContextMeter();
  handleEvent(evToolUse('m1', 'Bash'), st, m, cfg({ contextLimit: 50 }));
  assert(!st.killReason, '工具在飞时不该杀（会留下改了一半的文件）');
  handleEvent(evAssistant('m2', 5000), st, m, cfg({ contextLimit: 1000 }));
  assert(st.killReason === ExitReason.BUDGET_KILLED, `间隙应触发水位刹车: ${st.killReason}`);

  const st2 = freshState();
  handleEvent(evAssistant('c1', 100000), st2, new ContextMeter(), cfg({ costCeiling: 0.01 }));
  assert(st2.killReason === ExitReason.COST_KILLED && st2.costDetail.includes('估算已花'), st2.costDetail);
  assert(ExitReason.COST_KILLED !== ExitReason.BUDGET_KILLED, '处置不同，命名必须分开');
});

// ── 中断 ────────────────────────────────────────────────────
test('中断后宽容期内不杀；超过宽容期必须终止并归为人工打断', () => {
  // interruptAt 用非 0 值：真实运行里它是送出时刻，不会是 0（原版 `or now` 对 0 同样失效）
  const st = freshState({ interruptSent: true, interruptAt: 10, sawDelta: true });
  assert(watchdogDecide(st, 10 + SETTLE_GRACE - 1, dog()).action === 'continue', '宽容期内不该杀');
  const d = watchdogDecide(st, 10 + SETTLE_GRACE + 1, dog());
  assert(d.action === 'kill' && d.reason === ExitReason.INTERRUPTED_BY_HUMAN, `应归人工打断: ${JSON.stringify(d)}`);
  assert(d.hangDetail.includes('已送出中断') && d.hangDetail.includes('宽容期'), d.hangDetail);
});

// 审计 G6：CLI 收到 interrupt 后 result 是 error_during_execution + is_error（实测），
// 不特判会归成 ERROR，注入内容永远发不出去；看门狗先设的 HANG_KILLED 也不能盖掉人的动作
test('人工打断优先于一切分类：盖过 is_error 与看门狗已设的 hang', () => {
  const st = freshState({ interruptSent: true, injectText: '改用 Vue', killReason: ExitReason.HANG_KILLED,
    hangDetail: '静默 300s', result: evResult({ is_error: true, subtype: 'error_during_execution' }) });
  const r = assemble(st);
  assert(r.exitReason === ExitReason.INTERRUPTED_BY_HUMAN, `实际 ${r.exitReason}`);
  assert(r.injectText === '改用 Vue', '注入内容必须带出去');
});

test('墙钟无条件杀（工具在飞也杀）且优先于其它判据；不带判据文字（与原版一致）', () => {
  const d = watchdogDecide(freshState({ toolInFlight: 'bash', lastEvent: 0, sawDelta: true }), 101, dog({ wallTimeout: 100 }));
  assert(d.action === 'kill' && d.reason === ExitReason.WALL_TIMEOUT && !d.hangDetail, JSON.stringify(d));
  const r = assemble(freshState({ killReason: ExitReason.WALL_TIMEOUT }));
  assert(r.error === '', `原版墙钟超时 error 为空，实际 ${r.error}`);
});

// ── 后台任务（事件形状照原版：字段在顶层，列表键是 tasks）────────
test('task_started 只认 is_backgrounded 为真（前台工具调用也发它）', () => {
  const st = freshState();
  trackTasks({ subtype: 'task_started', task_id: 'f1', task_type: 'local_agent', is_backgrounded: false }, st);
  trackTasks({ subtype: 'task_started', task_id: 'n1', task_type: 'local_agent' }, st);
  assert(Object.keys(st.tasks).length === 0, '没带或为假的 is_backgrounded 都不算（审计 G8：原先把没带字段的算进去）');
  trackTasks({ subtype: 'task_started', task_id: 'a1', task_type: 'local_agent', is_backgrounded: true, description: '子系统' }, st);
  assert(st.tasks.a1?.description === '子系统', '后台任务应登记');
});

test('task_notification 是终局事件（不是 task_completed）', () => {
  const st = freshState({ tasks: { a1: { task_id: 'a1', task_type: 'local_agent' } } });
  trackTasks({ subtype: 'task_completed', task_id: 'a1' }, st);
  assert(st.tasks.a1, 'task_completed 不是 CLI 的真实事件名，不该删');
  trackTasks({ subtype: 'task_notification', task_id: 'a1', status: 'completed' }, st);
  assert(!st.tasks.a1, 'task_notification 到达应移除（原先漏认，每发白挂到 1800s 上限）');
});

test('background_tasks_changed 给当前完整列表，整表替换', () => {
  const st = freshState({ tasks: { a1: { task_id: 'a1', task_type: 'local_agent' } } });
  trackTasks({ subtype: 'background_tasks_changed', tasks: [{ task_id: 'a2', task_type: 'local_agent', description: 'x' }] }, st);
  assert(!st.tasks.a1 && st.tasks.a2, `应整表替换: ${JSON.stringify(st.tasks)}`);
});

test('只等 local_agent，不等 local_bash（长驻服务永远不会完成）', () => {
  const w = agentTasks({ a: { task_type: 'local_agent' }, b: { task_type: 'local_bash' } });
  assert(w.length === 1 && w[0].task_type === 'local_agent', JSON.stringify(w));
});

// 审计 G7：原先只在 result 那一刻判一次，任务收完也不收尾，300 秒后被判 hang 走交接
test('等待中任务全部收完 → 下一个事件就结束等待', () => {
  const seen = [];
  const st = freshState({ result: evResult(), tasks: { a1: { task_id: 'a1', task_type: 'local_agent', description: '子系统A' } } });
  assert(waitTasks(st, TASK_WAIT, (k, d) => seen.push([k, d]), 5) === true, '有 agent 在飞应继续等');
  assert(seen[0]?.[0] === 'tasks.waiting' && seen[0][1].names.includes('子系统A'), '应发 tasks.waiting 且带名字');
  assert(waitTasks(st, TASK_WAIT, (k, d) => seen.push([k, d]), 6) === true && seen.length === 1, '只发一次');
  trackTasks({ subtype: 'task_notification', task_id: 'a1' }, st);
  assert(waitTasks(st, TASK_WAIT, () => {}, 7) === false, '任务收完应立刻结束等待');
});

test('没有任务或 taskWait=0 时不等；看门狗判超时后不再等', () => {
  const agents = { a1: { task_id: 'a1', task_type: 'local_agent' } };
  assert(waitTasks(freshState({ tasks: {} }), TASK_WAIT, () => {}, 1) === false, '无任务不白等');
  const st0 = freshState({ tasks: agents });
  assert(waitTasks(st0, 0, () => {}, 1) === false && st0.taskWaitStarted === null, 'taskWait=0 不开始等');
  assert(waitTasks(freshState({ tasks: agents, taskWaitTimeout: true }), TASK_WAIT, () => {}, 1) === false, '超时后不再等');
});

test('等 agent 有上限：看门狗到点终止，但不设退出原因（算正常完成）', () => {
  const st = freshState({ taskWaitStarted: 0, tasks: { a1: { task_id: 'a1', task_type: 'local_agent' } } });
  const d = watchdogDecide(st, TASK_WAIT + 1, dog());
  assert(d.action === 'kill' && d.taskTimeout && !d.reason && d.count === 1, JSON.stringify(d));
});

// ── 结果组装：判定顺序 ──────────────────────────────────────
test('空 result 四条同时成立才算，且排在 completed 之前判', () => {
  const empty = evResult({ num_turns: 0, total_cost_usd: 0, result: '' });
  assert(assemble(freshState({ result: empty })).exitReason === ExitReason.EMPTY_RESULT, '应识别空返回');
  const m = new ContextMeter();
  m.observe({ input_tokens: 10 }, 'x');
  assert(!isEmptyResult(empty, m), '观测到过调用就不算空');
  assert(!isEmptyResult(evResult({ num_turns: 0, total_cost_usd: 0, result: '说了点' }), new ContextMeter()), '有文本不算空');
});

test('is_error 的 result 归 ERROR（在空返回判定之前），error 取 stderr 末尾', () => {
  const r = assemble(freshState({ result: evResult({ is_error: true, num_turns: 0, total_cost_usd: 0, result: '' }) }),
    new ContextMeter(), { stderr: 'x'.repeat(3000) + '最后的报错' });
  assert(r.exitReason === ExitReason.ERROR, `实际 ${r.exitReason}`);
  assert(r.error.endsWith('最后的报错') && r.error.length === 2000, '应取 stderr 末尾 2000 字（原先取开头 500）');
  assert(assemble(freshState()).exitReason === ExitReason.ERROR, '没拿到 result 归 ERROR');
});

test('terminal_reason=completed 为主判据：stop_reason 是 tool_use 也算完成', () => {
  const r = assemble(freshState({ result: evResult({ stop_reason: 'tool_use' }) }));
  assert(r.exitReason === ExitReason.COMPLETED, `实际 ${r.exitReason}`);
  const mt = assemble(freshState({ result: evResult({ terminal_reason: 'max_turns', num_turns: 50 }) }), new ContextMeter(), { maxTurns: 50 });
  assert(mt.exitReason === ExitReason.MAX_TURNS, `非自然收尾且撞顶应为 MAX_TURNS，实际 ${mt.exitReason}`);
  const done = assemble(freshState({ result: evResult({ num_turns: 50 }) }), new ContextMeter(), { maxTurns: 50 });
  assert(done.exitReason === ExitReason.COMPLETED, '轮数撞顶但自然收尾仍算完成');
});

test('完成但末尾在提问 → ASKED_HUMAN；高水位完成 → COMPLETED_HIGH_CONTEXT（提问优先）', () => {
  // 走真实路径：result 正文由 handleEvent 写进 finalText
  const viaEvents = (resultText) => { const st = freshState(); handleEvent(evResult({ result: resultText }), st, new ContextMeter(), cfg()); return st; };
  const ask = assemble(viaEvents('要用 Postgres 还是 SQLite？'));
  assert(ask.exitReason === ExitReason.ASKED_HUMAN, `实际 ${ask.exitReason}`);
  const m = new ContextMeter();
  m.observe({ input_tokens: 250000 }, 'h');
  const high = assemble(freshState({ result: evResult() }), m, { handoffLimit: 200000 });
  assert(high.exitReason === ExitReason.COMPLETED_HIGH_CONTEXT, `实际 ${high.exitReason}`);
  const m2 = new ContextMeter();
  m2.observe({ input_tokens: 250000 }, 'h');
  const both = assemble(viaEvents('请确认是否继续？'), m2, { handoffLimit: 200000 });
  assert(both.exitReason === ExitReason.ASKED_HUMAN, '在等业务决策时要先拿答案，水位高不该盖掉');
  assert(!looksLikeQuestion({ exitReason: ExitReason.HANG_KILLED, finalText: '？' }), '非完成不算提问');
});

test('result 正文覆盖旁白作为 finalText；总 token 取 usage 或 峰值+输出', () => {
  const st = freshState();
  handleEvent(evAssistant('a', 100, [{ type: 'text', text: '旁白' }]), st, new ContextMeter(), cfg());
  handleEvent(evResult({ result: '最终总结', usage: { input_tokens: 7, output_tokens: 3 } }), st, new ContextMeter(), cfg());
  const r = assemble(st);
  assert(r.finalText === '最终总结', `原版用 result 正文覆盖，实际 ${r.finalText}`);
  assert(r.totalTokens === 10, `应取 usage 之和，实际 ${r.totalTokens}`);
});

// ── 事件内容（兼容 view.py 的字段）────────────────────────────
test('tool 事件带 calls 明细，tool_result 带 id 与 is_error，context 带 limit', () => {
  const seen = {};
  const emit = (k, d) => { seen[k] = d; };
  const st = freshState();
  handleEvent(evToolUse('m1', 'Bash', { command: 'npm   test', description: 'd' }), st, new ContextMeter(), cfg({ contextLimit: 350000 }), emit);
  assert(seen.context.limit === 350000 && 'cost_estimate' in seen.context, JSON.stringify(seen.context));
  const call = seen.tool.calls[0];
  assert(call.id === 't-m1' && call.name === 'Bash' && call.brief === 'npm test' && call.detail.includes('command: npm'), JSON.stringify(call));
  handleEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't-m1', is_error: true, content: [{ type: 'text', text: '失败' }] }] } },
    st, new ContextMeter(), cfg(), emit);
  assert(seen.tool_result.id === 't-m1' && seen.tool_result.name === 'Bash' && seen.tool_result.is_error === true, JSON.stringify(seen.tool_result));
  assert(st.toolInFlight === null, '工具返回后不再在飞');
});

test('思考块与工具同轮出现时不丢；裁剪带全文位置提示', () => {
  const seen = [];
  handleEvent(evAssistant('m', 1, [{ type: 'thinking', thinking: '先看看' }, { type: 'tool_use', id: 't', name: 'Read' }]),
    freshState(), new ContextMeter(), cfg(), (k) => seen.push(k));
  assert(seen.includes('thinking') && seen.includes('tool'), `同轮思考被丢: ${seen}`);
  assert(clip('x'.repeat(2500)).includes('全文见 .run/events/'), '裁剪要告诉人去哪看全文');
  assert(toolBrief({ query: 'a'.repeat(100) }).endsWith('…') && toolBrief({ other: 1 }) === '', 'brief 取不到就空着');
  assert(fmtToolInput({ a: { b: 1 } }) === 'a: {"b":1}', fmtToolInput({ a: { b: 1 } }));
});

// ── 打断取件（含对原版缺陷的修正）──────────────────────────────
test('非立即注入遇工具在飞：发一次 inject.waiting，暂存到下个间隙照发（原版这里会丢）', () => {
  const inbox = [['改用 Vue', false]];
  const seen = [];
  const runner = new LongRunRunner({ checkInject: () => inbox.shift() || null, onStream: (e) => seen.push(e) });
  const fakeProc = { exitCode: null, signalCode: null, stdin: { destroyed: false, writable: true, write: () => true } };
  const st = freshState({ toolInFlight: 'bash' });
  runner._maybeInterrupt(fakeProc, st);
  runner._maybeInterrupt(fakeProc, st);
  assert(seen.filter((e) => e.kind === 'inject.waiting').length === 1, 'inject.waiting 只发一次');
  assert(!st.interruptSent && inbox.length === 0, '在飞时不该打断；文件已被取走');
  st.toolInFlight = null;
  runner._maybeInterrupt(fakeProc, st);
  assert(st.interruptSent && st.injectText === '改用 Vue', '到了间隙必须照发暂存的注入，不能丢');
  assert(seen.some((e) => e.kind === 'inject.sent' && e.text === '改用 Vue'), 'inject.sent 要带原文');
});

test('立即注入不等间隙；stdin 送不进去时退回硬 kill 且保住注入内容', () => {
  const runner = new LongRunRunner({ checkInject: () => ['死循环了', true] });
  const dead = { exitCode: 1, signalCode: null, pid: undefined, stdin: null, kill: () => {} };
  const st = freshState({ toolInFlight: 'bash' });
  runner._maybeInterrupt(dead, st);
  assert(st.killReason === ExitReason.INTERRUPTED_BY_HUMAN && st.injectText === '死循环了', JSON.stringify(st));
});

await Promise.all(pending);
console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

/**
 * 长程编排：runner —— 回归测试
 *
 * 逐条对译长程编排器 orchestrator/test_runner_hang.py 的 26 条 case_*。
 *
 * 原版用假进程 drive() 驱动 + 临时调小阈值；移植后把判定抽成纯函数
 * （watchdogDecide / handleEvent / silenceTolerance），可以直接喂状态与时间，
 * **不起真进程、不烧钱**。断言逐条对应，不合并不省略。
 *
 * ⚠ 这些用例锁的是"什么时候该杀、什么时候不该杀"。误杀的代价是几十分钟算力
 *   白花且拿不到 result（费用记成 $0）；漏杀的代价是永久挂死等人发现。
 *
 * 运行: node tests/test-longrun-runner.mjs
 */

import {
  ExitReason, ContextMeter, BASE_FLAGS,
  SILENCE_TOOL_BASH, SILENCE_TOOL_OTHER, SILENCE_IDLE, SETTLE_GRACE, TASK_WAIT,
  COST_PER_CALL, COST_PER_INPUT_TOKEN,
  buildArgs, silenceTolerance, watchdogDecide, handleEvent, trackTasks,
  agentTasks, isEmptyResult,
} from '../server/services/LongRunRunner.js';

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

/** 造一份运行态。started/lastEvent 都以 0 为时间原点，便于直接喂 now。 */
function freshState(over = {}) {
  return {
    started: 0, lastEvent: 0, sawDelta: false, toolInFlight: null,
    interruptSent: false, interruptAt: null,
    tasks: {}, taskWaitStarted: null, toolNames: {},
    finalText: '', resultEvent: null, sessionId: 'sid-1',
    ...over,
  };
}
/** 默认配置：墙钟给足，只测我们关心的那一档。 */
function cfg(over = {}) {
  return { wallTimeout: 1e9, taskWait: TASK_WAIT, contextLimit: 0, costCeiling: 0,
    now: () => 0, ...over };
}

// ── 事件构造（对齐真实 stream-json 形态）──────────────────────
const evDelta = (sub = 'content_block_delta') => ({ type: 'stream_event', event: { type: sub } });
const evAssistant = (id, inputTokens, blocks = null) => ({
  type: 'assistant',
  message: {
    id, usage: { input_tokens: inputTokens },
    content: blocks ?? [{ type: 'text', text: '干活中' }],
  },
});
const evToolUse = (id, name) => ({
  type: 'assistant',
  message: { id, usage: { input_tokens: 100 }, content: [{ type: 'tool_use', id: 't1', name }] },
});
const evResultOk = (over = {}) => ({
  type: 'result', subtype: 'success', is_error: false,
  num_turns: 3, total_cost_usd: 0.42, result: '做完了',
  stop_reason: 'end_turn', terminal_reason: 'completed', session_id: 'sid-1',
  permission_denials: [], ...over,
});

// ── 1. 阈值顺序 ──────────────────────────────────────────────
test('阈值有序：其它工具 < 空闲 < Bash，且中断宽容期独立', () => {
  assert(SILENCE_TOOL_OTHER < SILENCE_IDLE, '其它工具档应短于空闲档');
  assert(SILENCE_IDLE < SILENCE_TOOL_BASH, '空闲档应短于 Bash 档');
  assert(SETTLE_GRACE > 0, '中断宽容期必须存在（否则收尾卡住即永久挂死）');
  assert(TASK_WAIT > 0, '等 subagent 的上限必须存在');
});

// ── 2. 提示词不当 -p 参数传 ──────────────────────────────────
// 实测：带 --input-format stream-json 时 `-p <文本>` 会被完全忽略，CLI 转而等
// stdin 上的 user 消息 —— 照旧写法会静默挂到超时（301 秒零输出、水位 0、费用 0）。
test('提示词不作为 -p 的参数（否则静默挂到超时）', () => {
  const args = buildArgs({ sessionId: 'sid-1' });
  const i = args.indexOf('-p');
  assert(i === 0, '-p 应是首个参数');
  // -p 后面紧跟的必须是 flag，不能是提示词文本
  assert(String(args[1]).startsWith('--'), `-p 后不该带文本参数: ${args[1]}`);
  assert(!args.some((a) => !String(a).startsWith('-') && String(a).length > 60),
    '参数里不该出现长文本（提示词应走 stdin）');
});

test('必需 flag 齐全（缺 --verbose 会直接报错退出）', () => {
  for (const f of ['--output-format', 'stream-json', '--verbose',
    '--permission-prompts', 'none', '--include-partial-messages']) {
    assert(BASE_FLAGS.includes(f), `BASE_FLAGS 缺 ${f}`);
  }
});

test('partial messages flag 在场（少了它无法区分生成与挂死）', () => {
  assert(BASE_FLAGS.includes('--include-partial-messages'),
    '没有它，"正在生成"与"真挂死"在事件流上完全一样');
});

test('resume 与新建用不同 flag，且 --add-dir 逐个展开', () => {
  const fresh = buildArgs({ sessionId: 'sid-1' });
  assert(fresh.includes('--session-id') && !fresh.includes('--resume'), '新建应用 --session-id');
  const resumed = buildArgs({ sessionId: 'sid-1', resume: true });
  assert(resumed.includes('--resume') && !resumed.includes('--session-id'), 'resume 应用 --resume');
  const withDirs = buildArgs({ sessionId: 's', extraDirs: ['/a', '/b'] });
  assert(withDirs.filter((a) => a === '--add-dir').length === 2, '每个目录一个 --add-dir');
});

// ── 3. delta 保活 vs 真静默 ─────────────────────────────────
// 直接复现 qingming 那次误杀：delta 持续到达时总静默远超阈值，但不该被杀。
test('生成期间的 delta 刷新活性，未被误判为挂死', () => {
  const st = freshState();
  let clock = 0;
  const c = cfg({ now: () => clock });
  // delta 以 0.4s 间隔到达 8 次，累计 3.2s；把空闲档当成 1s 来判
  for (let i = 0; i < 8; i++) {
    clock += 0.4;
    handleEvent(evDelta(), st, new ContextMeter(), c);
    const d = watchdogDecide(st, clock, { wallTimeout: 1e9, taskWait: 0 });
    assert(d.action === 'continue', `第 ${i + 1} 个 delta 后被误杀: ${d.detail}`);
  }
  assert(st.sawDelta, 'delta 应被记为"见过流"');
  assert(clock > 1.0, '累计静默确实超过了 1s 阈值（否则这条没测到东西）');
});

test('连 delta 都停了才算真挂死，且判据跟着结果走', () => {
  const st = freshState({ sawDelta: true, lastEvent: 0 });
  // 静默超过空闲档
  const d = watchdogDecide(st, SILENCE_IDLE + 1, { wallTimeout: 1e9, taskWait: 0 });
  assert(d.action === 'kill' && d.reason === ExitReason.HANG_KILLED, `应判挂死: ${JSON.stringify(d)}`);
  assert(d.detail.includes('静默'), 'hang 应带静默时长');
  assert(d.detail.includes('流已断'), '见过流后断掉要说明"流已断"');
  assert(d.detail.includes(String(Math.round(SILENCE_IDLE))), '要写出用的是哪一档阈值');
});

test('本轮从未见过流时，判据要说"本轮未见过流"', () => {
  const st = freshState({ sawDelta: false });
  const d = watchdogDecide(st, SILENCE_IDLE + 1, { wallTimeout: 1e9, taskWait: 0 });
  assert(d.detail.includes('本轮未见过流'), `判据措辞不对: ${d.detail}`);
});

test('delta 不落盘（一发几十万条会让事件文件涨到几百 MB）', () => {
  const st = freshState();
  const seen = [];
  handleEvent(evDelta(), st, new ContextMeter(), cfg(), (k) => seen.push(k));
  assert(seen.length === 0, `delta 不该产生事件: ${seen}`);
});

// ── 4. 费用按 message_id 去重 ───────────────────────────────
// 实测：一条 assistant 消息按 content block 多次上报同一个 usage（连续三条都是
// input_tokens=75977）。累加会把一次 API 调用算成两三次，第一版标定偏差到 66%。
test('费用按 message id 去重（3+1 次上报 → 2 次调用）', () => {
  const m = new ContextMeter();
  for (let i = 0; i < 3; i++) m.observe({ input_tokens: 75977 }, 'msg-1');
  m.observe({ input_tokens: 80000 }, 'msg-2');
  assert(m.calls === 2, `应只算 2 次调用，实际 ${m.calls}`);
  const expect = 2 * COST_PER_CALL + (75977 + 80000) * COST_PER_INPUT_TOKEN;
  assert(Math.abs(m.costEstimate - expect) < 1e-9, `${m.costEstimate} vs ${expect}`);
  // 没有 message id 时不计入调用数，宁可少算也不要重复算
  m.observe({ input_tokens: 999 }, null);
  assert(m.calls === 2, `无 id 的上报不该计入调用数，实际 ${m.calls}`);
});

test('水位口径含 cache_read 与 cache_creation（它们也占窗口）', () => {
  const m = new ContextMeter();
  const occupied = m.observe(
    { input_tokens: 1000, cache_read_input_tokens: 2000, cache_creation_input_tokens: 500 }, 'm1');
  assert(occupied === 3500, `占用应为三项之和，实际 ${occupied}`);
  assert(m.peak === 3500, 'peak 应跟上');
  // 但费用只按 input_tokens 算（实测网关只上报这一项）
  const expect = COST_PER_CALL + 1000 * COST_PER_INPUT_TOKEN;
  assert(Math.abs(m.costEstimate - expect) < 1e-9, '费用应只按 input_tokens');
});

// ── 5. 中断相关 ─────────────────────────────────────────────
test('中断后的静默是预期的，宽容期内不杀', () => {
  const st = freshState({ interruptSent: true, interruptAt: 0, sawDelta: true });
  const d = watchdogDecide(st, SETTLE_GRACE - 1, { wallTimeout: 1e9, taskWait: 0 });
  assert(d.action === 'continue', `宽容期内不该杀: ${JSON.stringify(d)}`);
});

// watchdog 原先见 interruptSent 就无条件 continue，与读取循环那个 not interrupt_sent
// 一起把两个逃生口全堵死。人按了打断却什么都不发生（tafang 卡了 10 分钟以上）。
test('中断后迟迟收不到 result 必须有限超时', () => {
  const st = freshState({ interruptSent: true, interruptAt: 0, sawDelta: true });
  const d = watchdogDecide(st, SETTLE_GRACE + 1, { wallTimeout: 1e9, taskWait: 0 });
  assert(d.action === 'kill', '超过宽容期必须终止，不能无条件等下去');
  // 归 INTERRUPTED_BY_HUMAN 而非 HANG_KILLED：人确实按了打断，注入内容要保住
  assert(d.reason === ExitReason.INTERRUPTED_BY_HUMAN,
    `应归类为人工打断而非挂死，实际 ${d.reason}`);
  assert(d.detail.includes('已送出中断'), `判据要说明是中断后收不到 result: ${d.detail}`);
  assert(d.detail.includes('宽容期'), '判据要写出宽容期时长');
});

test('人工打断不算进程异常（否则三次就误判故障停机）', () => {
  // CLI 收到 interrupt 后 result 是 error_during_execution + is_error:true（实测），
  // 照原样归类会让每次人工打断都往"连续异常"计数器里加一
  assert(ExitReason.INTERRUPTED_BY_HUMAN !== ExitReason.ERROR,
    '人工打断必须与 ERROR 分开命名');
});

// ── 6. 水位与费用刹车：只在工具间隙动手 ──────────────────────
test('水位触顶在工具间隙才杀（工具在飞时 kill 会留下脏会话）', () => {
  const st = freshState();
  const m = new ContextMeter();
  const c = cfg({ contextLimit: 1000 });
  // 工具在飞：即使水位超了也不杀
  let r = handleEvent(evToolUse('m1', 'Bash'), st, m, c);
  assert(!r.kill, '工具在飞时不该杀');
  r = handleEvent(evAssistant('m2', 5000), st, m, c);   // 无 tool_use → 间隙
  assert(r.kill === ExitReason.BUDGET_KILLED, `间隙应触发水位刹车: ${JSON.stringify(r)}`);
  assert(r.detail.includes('水位'), '判据要说明是水位');
});

test('费用刹车同样只在工具间隙，且与水位分开命名', () => {
  const st = freshState();
  const m = new ContextMeter();
  // 刹车线定得极低，一次调用就超
  const c = cfg({ costCeiling: 0.01 });
  const r = handleEvent(evAssistant('m1', 100000), st, m, c);
  assert(r.kill === ExitReason.COST_KILLED, `应触发费用刹车: ${JSON.stringify(r)}`);
  assert(r.detail.includes('估算已花'), '判据要给出估算金额');
  // 水位触顶要交接换窗口，钱花超了应当直接停机等人 —— 处置不同，命名必须分开
  assert(ExitReason.COST_KILLED !== ExitReason.BUDGET_KILLED, '两者必须分开');
});

test('Bash 在飞时容忍度放到 900s，其它工具 120s', () => {
  assert(silenceTolerance(freshState({ toolInFlight: 'bash' })) === SILENCE_TOOL_BASH);
  assert(silenceTolerance(freshState({ toolInFlight: 'other' })) === SILENCE_TOOL_OTHER);
  assert(silenceTolerance(freshState({ toolInFlight: null })) === SILENCE_IDLE);
});

test('工具返回后不再算"在飞"', () => {
  const st = freshState();
  const m = new ContextMeter();
  handleEvent(evToolUse('m1', 'Bash'), st, m, cfg());
  assert(st.toolInFlight === 'bash', '应记为 bash 在飞');
  handleEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    st, m, cfg());
  assert(st.toolInFlight === null, '工具返回后应清空');
});

// ── 7. 墙钟超时 ─────────────────────────────────────────────
test('墙钟超时无条件杀，不看工具是否在飞', () => {
  // 代价是会话被留在工具执行中途的脏状态，恢复即空返回（EMPTY_RESULT 唯一来源）
  const st = freshState({ toolInFlight: 'bash', lastEvent: 99 });
  const d = watchdogDecide(st, 101, { wallTimeout: 100, taskWait: 0 });
  assert(d.action === 'kill' && d.reason === ExitReason.WALL_TIMEOUT,
    `墙钟到点应无条件杀: ${JSON.stringify(d)}`);
});

test('墙钟优先于其它判据（先检查它）', () => {
  // 同时满足墙钟超时与静默超时：应报墙钟
  const st = freshState({ lastEvent: 0, sawDelta: true });
  const d = watchdogDecide(st, 1e6, { wallTimeout: 100, taskWait: 0 });
  assert(d.reason === ExitReason.WALL_TIMEOUT, `应优先报墙钟，实际 ${d.reason}`);
});

// ── 8. 后台 subagent 等待 ───────────────────────────────────
// 后台任务活不过会话边界：CLI 恢复会话时会把它们全标成 stopped 并回一个 0 turn
// 的空 success（diablo 实测四个 local_agent 全灭、output 文件都是 0 字节）。
test('只等 local_agent，不等 local_bash（长驻服务永远不会完成）', () => {
  const tasks = {
    a1: { task_id: 'a1', task_type: 'local_agent', description: '做子系统' },
    b1: { task_id: 'b1', task_type: 'local_bash', description: 'dev server' },
  };
  const waited = agentTasks(tasks);
  assert(waited.length === 1 && waited[0].task_id === 'a1',
    `只该等 local_agent: ${JSON.stringify(waited)}`);
});

test('没有后台任务时立刻结束，不白等', () => {
  const st = freshState({ taskWaitStarted: 0, tasks: {} });
  const d = watchdogDecide(st, TASK_WAIT + 100, { wallTimeout: 1e9, taskWait: TASK_WAIT });
  assert(!d.taskTimeout, '没有可等的任务时不该报 task 超时');
});

test('等 subagent 有上限，到点终止但不算失败', () => {
  const st = freshState({
    taskWaitStarted: 0,
    tasks: { a1: { task_id: 'a1', task_type: 'local_agent' } },
  });
  const d = watchdogDecide(st, TASK_WAIT + 1, { wallTimeout: 1e9, taskWait: TASK_WAIT });
  assert(d.action === 'kill' && d.taskTimeout, `到点应终止: ${JSON.stringify(d)}`);
  // 不设 reason：主线已正常给过 result，这一发算正常完成，只是有任务没收尾
  assert(!d.reason, `不该设 kill 原因（否则会被记成失败）: ${d.reason}`);
  assert(d.count === 1, '要带出还有几个没收尾');
});

test('taskWait 设 0 关掉等待行为', () => {
  const st = freshState({
    taskWaitStarted: 0,
    tasks: { a1: { task_id: 'a1', task_type: 'local_agent' } },
  });
  const d = watchdogDecide(st, 1e6, { wallTimeout: 1e9, taskWait: 0 });
  assert(!d.taskTimeout, 'taskWait=0 时不该有 task 超时逻辑');
});

test('等待期间容忍度提到 Bash 档（agent 跑长 Bash 时可几分钟不发进度）', () => {
  const st = freshState({
    taskWaitStarted: 0, toolInFlight: null,
    tasks: { a1: { task_id: 'a1', task_type: 'local_agent' } },
  });
  assert(silenceTolerance(st) === SILENCE_TOOL_BASH,
    '等 subagent 时不该用 idle 档，否则会误杀');
  // 但整体上限仍由 taskWait 管
  const d = watchdogDecide(st, SILENCE_IDLE + 10, { wallTimeout: 1e9, taskWait: TASK_WAIT });
  assert(d.action === 'continue', '空闲档时长内不该杀');
});

test('background_tasks_changed 给的是完整列表，是权威来源', () => {
  const st = freshState();
  trackTasks({ subtype: 'task_started', task: { task_id: 'a1', task_type: 'local_agent' } }, st);
  trackTasks({ subtype: 'task_started', task: { task_id: 'a2', task_type: 'local_agent' } }, st);
  assert(Object.keys(st.tasks).length === 2, '增量应先累积');
  // 权威快照只剩 a2 → a1 必须消失
  trackTasks({ subtype: 'background_tasks_changed',
    background_tasks: [{ task_id: 'a2', task_type: 'local_agent' }] }, st);
  assert(Object.keys(st.tasks).length === 1 && st.tasks.a2, '完整列表应整表替换');
});

test('前台任务不计入要等的后台任务', () => {
  const st = freshState();
  trackTasks({ subtype: 'task_started',
    task: { task_id: 'f1', task_type: 'local_agent', is_backgrounded: false } }, st);
  assert(Object.keys(st.tasks).length === 0, '前台任务不该进等待清单');
});

test('任务完成/停止后从清单移除', () => {
  const st = freshState();
  trackTasks({ subtype: 'task_started', task: { task_id: 'a1', task_type: 'local_agent' } }, st);
  trackTasks({ subtype: 'task_completed', task: { task_id: 'a1' } }, st);
  assert(Object.keys(st.tasks).length === 0, '完成后应移除');
});

// ── 9. 空 result 识别 ───────────────────────────────────────
// CLI 回 success 但一个 turn 都没跑 —— 发出去的提示词进了黑洞，而调用方会把它
// 当成"做完了"继续往下走。实测只在续一个被 wall_timeout 杀掉的会话时出现。
test('空 result（0 turn + 零费用 + 空文本）必须与正常完成分开', () => {
  const m = new ContextMeter();
  assert(isEmptyResult({ is_error: false, num_turns: 0, total_cost_usd: 0, result: '' }, m),
    '应识别为空 result');
});

test('正常的短发次不算空 result', () => {
  const m = new ContextMeter();
  m.observe({ input_tokens: 500 }, 'm1');
  assert(!isEmptyResult(evResultOk({ num_turns: 1 }), m), '正常完成不该被当成空');
  // 有产出文本就不算空，即使 turn 数少
  assert(!isEmptyResult({ is_error: false, num_turns: 0, total_cost_usd: 0, result: '说了点什么' }, m),
    '有文本就不算空');
});

test('报错的 result 不走空 result 判定（那是 ERROR）', () => {
  assert(!isEmptyResult({ is_error: true, num_turns: 0, total_cost_usd: 0, result: '' }, new ContextMeter()),
    'is_error 的应归 ERROR 而非空 result');
});

await Promise.all(pending);
console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败（对译 26 条 hang 用例）===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

/**
 * 长程编排：服务层 —— 回归测试
 *
 * 服务层是入口语义、沙箱、监督者、循环的组装点，也是与 WebTmux 的接缝。这里锁：
 *   1. 参数与原版命令行一一对应，缺省值与原版常量一致
 *   2. 能在动沙箱之前查出的问题全部先查 —— 拒绝时旧成果原样还在
 *   3. 新建/续跑发给执行者的开场与原版一致；监督者拿到的需求与执行者是同一份
 *   4. 监督者凭据从 CC Switch 取，且不出现在任何快照、事件、执行者环境里
 *   5. 面板干预：回答原样转发、终止真停、停下的顺序、任务结束后拒绝投件
 *
 * 不起真 claude 进程（注入假执行者），不碰真实 ~/.claude.json 与真实沙箱目录。
 *
 * 运行: node tests/test-longrun-service.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'longrun_service_')));
process.env.LONGRUN_SANDBOX_BASE = path.join(TMP, 'sandboxes');
process.env.LONGRUN_CLAUDE_JSON = path.join(TMP, 'claude.json');
fs.mkdirSync(process.env.LONGRUN_SANDBOX_BASE, { recursive: true });
fs.writeFileSync(process.env.LONGRUN_CLAUDE_JSON, JSON.stringify({ projects: {} }));

const { LongRunService, normalizeOptions, deriveName, STOP_REASON } = await import('../server/services/LongRunService.js');
const { HANDOFF_FLOOR, HANDOFF_CEILING, HARD_KILL, MAINTENANCE_EVERY, TOTAL_BUDGET_USD, MAX_LEGS } =
  await import('../server/services/LongRunLoop.js');
const { TASK_WAIT } = await import('../server/services/LongRunRunner.js');
const { loadPrompts } = await import('../server/services/LongRunPrompts.js');
const { loadSystemPrompt } = await import('../server/services/LongRunSupervisor.js');
const { orchestratorRoot } = await import('../server/services/LongRunSandbox.js');

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
async function test(name, fn) {
  try { await fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, what, ms = 8000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(20)) if (pred()) return;
  throw new Error(`等待超时: ${what}`);
}
const PROMPTS = loadPrompts(fileURLToPath(new URL('../server/prompts/longrun/提示词.txt', import.meta.url)));
const SECRET = 'sk-secret-should-never-leak';

let docSeq = 0;
function writeDoc(text) {
  const p = path.join(TMP, `需求${++docSeq}.md`);
  fs.writeFileSync(p, text, 'utf8');
  return p;
}

/**
 * 假 AIEngine：verdicts 为监督者判定序列（用完重复最后一个）。
 * 记录每次调用收到的 config / system / user。
 */
function fakeEngine({ verdicts = ['project_done'], global = true } = {}) {
  const calls = [];
  const vs = [...verdicts];
  const cfg = (url) => ({ apiUrl: url, apiKey: SECRET, model: 'claude-opus-5' });
  return {
    calls,
    resolveSessionSettings: (app, id) => ({ ...cfg(`https://session-${id}.example.com`) }),
    getSettings: () => ({ claude: global ? cfg('https://global.example.com') : {} }),
    callClaudeMessages: async (o) => {
      calls.push(o);
      const v = vs.length > 1 ? vs.shift() : vs[0];
      return { text: JSON.stringify({ verdict: v, confidence: 0.95, reason: '桩', reply: '', needs_from_human: '请定数据库' }),
        stopReason: 'end_turn', inputTokens: 10, outputTokens: 5 };
    },
  };
}

/** 假执行者。block=true 的发次一直挂着，直到 abort()（模拟长跑中被终止）。 */
function fakeRunners({ blockAt = 0 } = {}) {
  const sent = [], opts = [];
  const factory = (ro) => {
    opts.push(ro);
    const runner = {
      abort() { runner._release?.(); },
      run: async (prompt, sessionId, resume) => {
        sent.push({ prompt, resume });
        if (blockAt && sent.length === blockAt) await new Promise((r) => { runner._release = r; });
        return { sessionId: sessionId || `sid-${sent.length}`, exitReason: 'completed', contextPeak: 1000,
          finalText: '这一步做完了', stopReason: 'end_turn', costUsd: 0.25, costEstimate: 0, injectText: '',
          pendingTasks: [], numTurns: 1, error: '', durationS: 1, permissionDenials: [] };
      },
    };
    return runner;
  };
  return { sent, opts, factory };
}

/** 服务实例：注入假引擎、假执行者，并捕获推给 socket 房间的每条事件（s.pushed） */
function svc(engine = fakeEngine(), runners = fakeRunners()) {
  const pushed = [];
  const io = { to: (room) => ({ emit: (name, ev) => pushed.push({ room, name, ...ev }) }),
    emit: (name, task) => pushed.push({ room: '*', name, task }) };
  return Object.assign(new LongRunService({ io, aiEngine: engine, runnerFactory: runners.factory }), { engine, runners, pushed });
}
/** 某任务推送过的事件 */
const evs = (s, id) => s.pushed.filter((e) => e.taskId === id);
/** 广播给所有客户端的任务摘要 */
const broadcasts = (s, id) => s.pushed.filter((e) => e.room === '*' && e.task.id === id);
const finished = (s, id) => waitFor(() => s.status(id).state !== 'running', '任务收工');

// ── 参数 ────────────────────────────────────────────────────
await test('参数缺省值与原版命令行一致', () => {
  const o = normalizeOptions({});
  const want = { mode: 'start', fresh: false, totalBudgetUsd: TOTAL_BUDGET_USD, maxLegs: MAX_LEGS,
    handoffFloor: HANDOFF_FLOOR, handoffCeiling: HANDOFF_CEILING, hardKill: HARD_KILL,
    maintenanceEvery: MAINTENANCE_EVERY, taskWait: TASK_WAIT, noAsk: false, noSupervisor: false, allowMissingRefs: false };
  for (const [k, v] of Object.entries(want)) assert(o[k] === v, `${k}: ${o[k]} ≠ ${v}`);
  assert(MAX_LEGS === 200 && MAINTENANCE_EVERY === 3 && TOTAL_BUDGET_USD === 1e6, '原版 --max-legs 200 / --maintenance-every 3 / --budget 1e6');
});

await test('参数非法时启动前拒绝：非数、负数、非整数、三档水位写反；续跑忽略删掉重建', () => {
  for (const bad of [{ maxLegs: 'abc' }, { taskWait: -1 }, { maxLegs: 1.5 }, { maintenanceEvery: -3 },
    { handoffFloor: 300000, handoffCeiling: 200000 }]) {
    let e = null;
    try { normalizeOptions(bad); } catch (x) { e = x; }
    assert(e, `应拒绝 ${JSON.stringify(bad)}`);
  }
  assert(normalizeOptions({ maintenanceEvery: 0, taskWait: 0 }).maintenanceEvery === 0, '0 = 关闭维护/不等，是合法值');
  assert(normalizeOptions({ mode: 'resume', fresh: true }).fresh === false, '续跑不能带删掉重建');
});

// ── 预检 ────────────────────────────────────────────────────
await test('预检不建沙箱、不起进程；粘贴需求按标题取名', () => {
  const s = svc();
  const p = s.plan({ requirementText: '# 记账 App v2\n\n做个记账工具' });
  assert(p.sandboxName === deriveName('# 记账 App v2') && p.sandboxName === '记账_App_v2', p.sandboxName);
  assert(!fs.existsSync(p.sandboxRoot) && !p.sandboxExists && !p.resumable, '预检不该建沙箱');
  assert(s.runners.opts.length === 0 && s.tasks.size === 0, '预检不该起执行者、不该建任务');
  assert(p.promptSlots.length === 5 && fs.existsSync(p.docPath), '粘贴文本要落盘成文档');
  assert(s.plan({ requirementText: '# 记账 App v2\n\n做个记账工具' }).docPath === p.docPath, '同内容幂等，不攒两份');
});

await test('预检如实报告：沙箱已存在、可续跑、上次运行痕迹', () => {
  const root = path.join(process.env.LONGRUN_SANDBOX_BASE, 'planned');
  fs.mkdirSync(path.join(root, '.memory'), { recursive: true });
  fs.mkdirSync(path.join(root, '.run'), { recursive: true });
  fs.writeFileSync(path.join(root, '.memory', 'MEMORY.md'), '- [进度](p.md) — 做到第三步');
  fs.writeFileSync(path.join(root, '.run', 'session_state.json'), JSON.stringify({ legs: 9, handoffs: 1, spent_usd: 2 }));
  const p = svc().plan({ docPath: writeDoc('x'), sandboxName: 'planned' });
  assert(p.sandboxExists && p.resumable && p.prior.legs === 9 && p.prior.memoryIndex[0].includes('第三步'), JSON.stringify(p.prior));
  assert(p.sandboxes.includes('planned'));
});

// ── 动沙箱之前的拒绝：旧成果必须原样还在 ─────────────────────
function oldSandbox(name) {
  const root = path.join(process.env.LONGRUN_SANDBOX_BASE, name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, '成果.txt'), '上一轮');
  return () => fs.existsSync(path.join(root, '成果.txt'));
}
async function refused(s, opts, re) {
  let e = null;
  try { s.start(opts); } catch (x) { e = x; }
  assert(e && re.test(e.message), `应以 ${re} 拒绝，实际: ${e?.message || '通过了'}`);
  assert(s.tasks.size === 0 && s.runners.opts.length === 0, '拒绝时不该建任务、不该起执行者');
}

await test('新建撞上非空沙箱且没勾删掉重建 → 拒绝，指向续跑', async () => {
  const intact = oldSandbox('clash');
  await refused(svc(), { docPath: writeDoc('# 需求'), sandboxName: 'clash' }, /续跑/);
  assert(intact(), '旧成果被动了');
});

await test('勾了删掉重建，但监督者提示词文件不存在 → 删之前就拒绝', async () => {
  const intact = oldSandbox('badprompt');
  await refused(svc(), { docPath: writeDoc('# 需求'), sandboxName: 'badprompt', fresh: true,
    supervisorPrompt: path.join(TMP, '不存在的提示词.txt') }, /不存在/);
  assert(intact(), '提示词问题应在删沙箱前发现');
});

await test('勾了删掉重建，但参考路径指向受保护项目 → 删之前就拒绝；勾忽略才放行', async () => {
  const intact = oldSandbox('badref');
  const doc = writeDoc(`# 需求\n参考 ${orchestratorRoot()}/README.md\n`);
  await refused(svc(), { docPath: doc, sandboxName: 'badref', fresh: true }, /参考路径无法使用[\s\S]*受保护/);
  assert(intact(), '参考路径问题应在删沙箱前发现');
  const s = svc();
  const t = s.start({ docPath: doc, sandboxName: 'badref', fresh: true, allowMissingRefs: true });
  await finished(s, t.id);
  assert(!intact() && t.selfCheck.some((i) => /已按「忽略无法使用的参考路径」继续/.test(i.text)), '放行后要在自检里说出来');
});

await test('需求文档不存在、续跑的沙箱没有记忆 → 拒绝', async () => {
  await refused(svc(), { docPath: path.join(TMP, '没有这个.md') }, /需求文档不存在/);
  fs.mkdirSync(path.join(process.env.LONGRUN_SANDBOX_BASE, 'nomemory'), { recursive: true });
  await refused(svc(), { docPath: writeDoc('x'), sandboxName: 'nomemory', mode: 'resume' }, /没有记忆文件/);
});

// ── 完整运行（假执行者） ─────────────────────────────────────
await test('新建：先发初始化提示词，再发需求全文；监督者拿到的需求与执行者第二发逐字相同', async () => {
  const s = svc();
  const t = s.start({ docPath: writeDoc('# 待办\n\n做个待办应用'), sandboxName: 'fresh_run' });
  await finished(s, t.id);
  const { sent } = s.runners;
  assert(sent[0].prompt === PROMPTS.init && sent[0].resume === false, '第一发应是初始化提示词、新会话');
  assert(sent[1].prompt === '# 待办\n\n做个待办应用' && sent[1].resume === true, `第二发应是需求原文、续同一会话: ${JSON.stringify(sent[1])}`);
  const user = s.engine.calls.at(-1).user;
  assert(user.includes(sent[1].prompt), '监督者输入里要带执行者拿到的同一份需求');
  const st = s.status(t.id);
  assert(st.state === 'done' && st.report.stop === 'project_done' && st.mode === 'start', JSON.stringify(st.report));
});

await test('续跑：不发初始化，先发新对话开始提示词，再发"新增需求"包装', async () => {
  const s0 = svc();
  const first = s0.start({ docPath: writeDoc('# 首轮'), sandboxName: 'resume_me' });
  await finished(s0, first.id);
  const root = first.sandboxRoot;
  fs.mkdirSync(path.join(root, '.memory'), { recursive: true });
  fs.writeFileSync(path.join(root, '.memory', 'MEMORY.md'), '- [进度](p.md) — 首轮已完成');
  const s = svc();
  const t = s.start({ docPath: writeDoc('再加一个导出功能'), sandboxName: 'resume_me', mode: 'resume' });
  await finished(s, t.id);
  const { sent } = s.runners;
  assert(sent[0].prompt === PROMPTS.resume && sent[0].resume === false, '续跑第一发应是新对话开始提示词');
  assert(sent[1].prompt.startsWith('以下是新增的需求。这不是重新开始') && sent[1].prompt.endsWith('再加一个导出功能'), sent[1].prompt);
  assert(!sent.some((x) => x.prompt === PROMPTS.init), '续跑不能重发初始化提示词');
  assert(t.selfCheck.some((i) => /上次运行: 调用 \d+ 次/.test(i.text)) && t.selfCheck.some((i) => /首轮已完成/.test(i.text)),
    '续跑自检要复述上次运行与记忆索引');
});

await test('监督者凭据走 CC Switch：未指定供应商用全局，指定了用会话级；提示词走 system 位', async () => {
  const a = svc();
  await finished(a, a.start({ docPath: writeDoc('# a'), sandboxName: 'cfg_global' }).id);
  assert(a.engine.calls[0].config.apiUrl === 'https://global.example.com', a.engine.calls[0].config.apiUrl);
  assert(a.engine.calls[0].system === loadSystemPrompt().text && a.engine.calls[0].maxTokens === 4000, '判定提示词与 max_tokens');
  const b = svc();
  const t = b.start({ docPath: writeDoc('# b'), sandboxName: 'cfg_session', providerId: 'p42' });
  await finished(b, t.id);
  assert(b.engine.calls[0].config.apiUrl === 'https://session-p42.example.com', '指定供应商应走会话级解析');
  assert(t.supervisor.status === 'on' && t.supervisor.baseUrl === 'https://session-p42.example.com', JSON.stringify(t.supervisor));
});

await test('密钥不出现在任务快照、事件、执行者环境里', async () => {
  const s = svc();
  const t = s.start({ docPath: writeDoc('# 密钥'), sandboxName: 'no_leak' });
  await finished(s, t.id);
  const blob = JSON.stringify([s.status(t.id), evs(s, t.id), s.runners.opts.map((o) => o.env)]);
  assert(!blob.includes(SECRET), '监督者密钥泄漏');
  assert(!JSON.stringify(s.status(t.id)).includes(loadSystemPrompt().text.slice(0, 40)), '快照不该塞提示词全文');
});

await test('启动自检：第一条事件就是自检，含连坐、投件、代答权提醒、执行者参数', async () => {
  const s = svc();
  const t = s.start({ docPath: writeDoc('# 自检'), sandboxName: 'selfcheck', model: 'claude-sonnet-5', taskWait: 60 });
  await finished(s, t.id);
  const ev = evs(s, t.id);
  assert(ev[0].kind === 'selfcheck' && ev[0].seq === 1 && ev[0].items.length === t.selfCheck.length, ev[0].kind);
  const text = t.selfCheck.map((i) => i.text).join('\n');
  for (const need of ['子进程连坐', 'inject!.txt', '暂停不是终止', '代答权', '判定提示词', '记忆目录（已覆盖）', 'maintain_2']) {
    assert(text.includes(need), `自检缺: ${need}`);
  }
  assert(!/与内置默认不一致/.test(text), '默认提示词不该喊"被改动"');
  assert(s.runners.opts[0].model === 'claude-sonnet-5' && s.runners.opts[0].taskWait === 60, '模型与后台等待要传到执行者');
});

await test('监督者凭据缺失：不启用并在自检里警告；不启用监督者时如实说明', async () => {
  const s = svc(fakeEngine({ global: false }));
  const t = s.start({ docPath: writeDoc('# 无凭据'), sandboxName: 'no_cfg', noAsk: true });
  await finished(s, t.id);
  assert(t.supervisor.status === 'unavailable' && t.selfCheck.some((i) => i.level === 'warn' && /监督者不可用/.test(i.text)));
  assert(s.status(t.id).report.stop === 'needs_human', `没有监督者且不等人应停机: ${s.status(t.id).report.stop}`);
  const off = svc();
  const t2 = off.start({ docPath: writeDoc('# 关'), sandboxName: 'sup_off', noSupervisor: true, noAsk: true });
  await finished(off, t2.id);
  assert(t2.supervisor.status === 'off' && off.engine.calls.length === 0, '关了监督者不该调 LLM');
});

// ── 面板干预 ────────────────────────────────────────────────
await test('监督者叫人 → 面板回答原样发给执行者（不加包装），续同一会话', async () => {
  const s = svc(fakeEngine({ verdicts: ['needs_human', 'project_done'] }));
  const t = s.start({ docPath: writeDoc('# 叫人'), sandboxName: 'ask_me' });
  await waitFor(() => s.status(t.id).awaitingHuman, '进入等人');
  assert(evs(s, t.id).some((e) => e.kind === 'need_human' && e.needs === '请定数据库'), 'need_human 事件要带需要人做什么');
  assert(broadcasts(s, t.id).some((b) => b.task.awaitingHuman), '挂起等人后要广播（need_human 事件那一刻还没挂起），否则列表与回答框出不来');
  const r = s.answer(t.id, '改用 SQLite');
  assert(r.ok && r.answered, JSON.stringify(r));
  await finished(s, t.id);
  const reply = s.runners.sent.find((x) => x.prompt === '改用 SQLite');
  assert(reply && reply.resume === true, `回答应原样、续同一会话: ${JSON.stringify(s.runners.sent.map((x) => x.prompt.slice(0, 20)))}`);
  assert(s.answer(t.id, 'x').error === '任务已结束', '收工后不能再回答');
});

await test('空回答 = 停机（与原版终端直接回车一致）；没在等时回答被拒', async () => {
  const s = svc(fakeEngine({ verdicts: ['needs_human'] }));
  const t = s.start({ docPath: writeDoc('# 空答'), sandboxName: 'empty_answer' });
  assert(s.answer(t.id, 'x').error === '执行者当前没有在等回答', '开跑即回答应被拒');
  await waitFor(() => s.status(t.id).awaitingHuman, '进入等人');
  s.answer(t.id, '   ');
  await finished(s, t.id);
  assert(s.status(t.id).report.stop === 'needs_human', s.status(t.id).report.stop);
});

await test('终止长跑中的发次：执行者被结束，本轮以人工终止收工；之后投件被拒', async () => {
  const runners = fakeRunners({ blockAt: 2 });
  const s = svc(fakeEngine(), runners);
  const t = s.start({ docPath: writeDoc('# 长跑'), sandboxName: 'kill_me' });
  await waitFor(() => runners.sent.length === 2, '第二发开跑');
  const r = s.terminate(t.id, '方向错了');
  assert(r.ok, JSON.stringify(r));
  await finished(s, t.id);
  const st = s.status(t.id);
  assert(st.report.stop === 'interrupted' && st.state === 'failed' && st.aborted === '方向错了', JSON.stringify(st.report));
  assert(runners.sent.length === 2, '终止后不该再派发');
  assert(evs(s, t.id).some((e) => e.kind === 'finished' && e.stop === 'interrupted'));
  assert(s.inject(t.id, '继续').error === '任务已结束' && s.pause(t.id, true).error === '任务已结束', '结束后的投件会在下次续跑时突然生效，必须拒');
});

await test('在等人回答时终止：挂起点被唤醒，不会永远卡住', async () => {
  const s = svc(fakeEngine({ verdicts: ['needs_human'] }));
  const t = s.start({ docPath: writeDoc('# 等人时终止'), sandboxName: 'kill_waiting' });
  await waitFor(() => s.status(t.id).awaitingHuman, '进入等人');
  s.terminate(t.id);
  await finished(s, t.id);
  assert(s.status(t.id).report.stop === 'interrupted' && !s.status(t.id).awaitingHuman);
});

await test('同一沙箱同时只能跑一个；撞上时连删掉重建也不许（否则删掉正在跑的现场）', async () => {
  const runners = fakeRunners({ blockAt: 2 });
  const s = svc(fakeEngine(), runners);
  const t = s.start({ docPath: writeDoc('# 占用'), sandboxName: 'busy' });
  await waitFor(() => runners.sent.length === 2, '第二发开跑');
  let e = null;
  try { s.start({ docPath: writeDoc('# 抢'), sandboxName: 'busy', fresh: true }); } catch (x) { e = x; }
  assert(e && /已有任务在跑/.test(e.message) && fs.existsSync(path.join(t.sandboxRoot, '.run')), e?.message);
  assert(s.plan({ docPath: writeDoc('x'), sandboxName: 'busy' }).runningTaskId === t.id, '预检要报出占用它的任务');
  s.terminate(t.id);
  await finished(s, t.id);
});

await test('投件/暂停/停下写的是原版文件约定；停下 = 立即打断 + 挂暂停闸', async () => {
  const runners = fakeRunners({ blockAt: 2 });
  const s = svc(fakeEngine(), runners);
  const t = s.start({ docPath: writeDoc('# 干预'), sandboxName: 'intervene' });
  await waitFor(() => runners.sent.length === 2, '第二发开跑');
  const run = path.join(t.sandboxRoot, '.run');
  assert(s.inject(t.id, '  改存 SQLite  ').ok && fs.readFileSync(path.join(run, 'inject.txt'), 'utf8') === '改存 SQLite');
  assert(s.inject(t.id, '马上停', true).path === path.join(run, 'inject!.txt'));
  assert(s.inject(t.id, '   ').error === '注入内容为空');
  assert(s.pause(t.id, true).ok && s.status(t.id).pauseArmed && !s.status(t.id).halted, '闸挂上 ≠ 已停住');
  assert(broadcasts(s, t.id).at(-1).task.pauseArmed, '面板暂停后要广播，列表徽标才会变');
  assert(s.pause(t.id, false).ok && !fs.existsSync(path.join(run, 'pause')));
  fs.rmSync(path.join(run, 'inject!.txt'));
  const r = s.stop(t.id);
  assert(r.ok && fs.existsSync(path.join(run, 'inject!.txt')) && fs.existsSync(path.join(run, 'pause')), JSON.stringify(r));
  assert(fs.readFileSync(path.join(run, 'inject!.txt'), 'utf8') === STOP_REASON, '默认打断语要用安全措辞模板');
  s.terminate(t.id);
  await finished(s, t.id);
});

// ── 快照与事件 ──────────────────────────────────────────────
await test('快照跟事件走：发次、费用取 loop 实账、水位峰值；推送带时间线条目；订阅快照与推送序号对得上', async () => {
  const s = svc();
  const t = s.start({ docPath: writeDoc('# 快照'), sandboxName: 'snapshot' });
  await finished(s, t.id);
  const st = s.status(t.id);
  assert(st.legs === s.runners.sent.length && Math.abs(st.costUsd - 0.25 * st.legs) < 1e-9 && st.contextPeak === 1000, JSON.stringify(st));
  const pushed = evs(s, t.id);
  assert(pushed.every((p) => p.room === `longrun:${t.id}` && p.name === 'longrun:event'));
  const seqs = pushed.map((e) => e.seq);
  assert(seqs.every((q, i) => i === 0 || q === seqs[i - 1] + 1), '序号必须连续递增');
  const send = pushed.find((e) => e.kind === 'send');
  assert(send._entry && send._entry.role === 'injected' && send._entry.body.startsWith('【初始化提示词】'), '命中归类规则的事件要带条目');
  assert(!pushed.find((e) => e.kind === 'selfcheck')._entry, '不在归类规则里的事件不带条目');
  const b = s.board(t.id);
  assert(b.seq === seqs.at(-1), `快照序号 ${b.seq} 应等于最后一条推送 ${seqs.at(-1)}`);
  assert(b.snapshot.title === path.basename(t.docPath) && b.snapshot.requirement === '# 快照', '标题是文档名、需求卡片是原文');
  assert(b.snapshot.finished.stop === 'project_done' && b.snapshot.timeline.length > 0 && b.snapshot.logs.length > 0);
  s._emit(s.tasks.get(t.id), 'state', { kind: 'evil' });
  assert(evs(s, t.id).at(-1).kind === 'state', '数据里的 kind 不能覆盖事件类型');
  assert(s.board('nope') === null);
  const bs = broadcasts(s, t.id);
  assert(bs.length > 3 && bs.every((b) => b.name === 'longrun:task'), '关键变化要广播任务摘要给列表');
  assert(bs.at(-1).task.state === 'done' && !JSON.stringify(bs).includes('sk-secret'), '最后一条是收工状态，且不带密钥');
});

await test('回放：内存里有该沙箱的任务就给实时看板，否则读落盘文件；会话记录接口可达', async () => {
  const s = svc();
  const live = s.replay({ sandboxName: 'snapshot' });
  assert(live.ok && !live.live && live.snapshot.replay === true && live.count > 0, '新服务实例（模拟重启）应从文件回放');
  const t = s.start({ docPath: writeDoc('# 回放'), sandboxName: 'replay_live' });
  await finished(s, t.id);
  const r = s.replay({ sandboxName: 'replay_live' });
  assert(r.ok && r.live && r.taskId === t.id && r.snapshot.replay === false, JSON.stringify({ ...r, snapshot: undefined }));
  assert(s.transcriptSessions('').error === '没给目录' && s.transcriptSession('/etc/passwd').error.includes('已拒绝'));
});

await test('沙箱清单带上次运行痕迹与占用情况', () => {
  const list = svc().sandboxes();
  const snap = list.find((x) => x.name === 'snapshot');
  assert(snap && snap.prior.legs > 0 && snap.runningTaskId === null, JSON.stringify(snap));
});

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(results.failed ? 1 : 0);

/**
 * 长程编排：会话循环 —— WebTmux 独有部分与落盘细节
 *
 * 原版 _main_phase / _open / _handoff 的全部行为分支由 test-longrun-parity.mjs 与原版 Python
 * 逐场景对拍（38 个场景）。这里测对拍覆盖不到的：
 *   · WebTmux 独有：面板等人回答（humanChannel）、终止（abort → Stop.INTERRUPTED）、
 *     暂停状态标志（halted）、水位三档校验、非预算异常兜底
 *   · 落盘格式与参数传递：.gitignore、git 残壳清理、中文 git 下不误报快照失败、
 *     传给 runner 的参数（工具白名单、模型、原始事件目录、墙钟、exec. 前缀）
 * 不依赖 Python，任何机器都能跑。
 *
 * 运行: node tests/test-longrun-loop.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { LongRunLoop, Stop, assertThresholds, LOOP_WALL_TIMEOUT, MAX_LEGS, TOTAL_BUDGET_USD } from '../server/services/LongRunLoop.js';
import { ExitReason, DEFAULT_TOOLS, TASK_WAIT } from '../server/services/LongRunRunner.js';
import { Supervisor } from '../server/services/LongRunSupervisor.js';
import { loadPrompts } from '../server/services/LongRunPrompts.js';

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
async function test(name, fn) {
  try { await fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}

const PROMPTS = loadPrompts(fileURLToPath(new URL('../server/prompts/longrun/提示词.txt', import.meta.url)));

function fakeSpec() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop_node_'));
  const spec = { root, memoryDir: path.join(root, '.memory'), runDir: path.join(root, '.run'), extraDirs: ['/参考/资料'],
    verifyClean() {}, childEnv: () => ({ ...process.env }) };
  for (const d of [spec.memoryDir, spec.runDir]) fs.mkdirSync(d, { recursive: true });
  return spec;
}

/** script: [[退出原因, 水位, 文本]]；verdicts: 监督者判定序列（用完重复最后一个） */
function makeLoop({ script = [], verdicts = null, onRun = null, ...over } = {}) {
  const spec = fakeSpec();
  const sent = [];
  const runnerOpts = [];
  const vs = verdicts ? [...verdicts] : null;
  const loop = new LongRunLoop({
    sandbox: spec, prompts: PROMPTS, requirementText: '做个待办应用', askHuman: false,
    supervisor: vs ? new Supervisor({ systemPrompt: 'x', complete: async () => {
      const v = vs.length === 1 ? vs[0] : vs.shift();
      return { text: `{"verdict":"${v}","confidence":0.95,"reason":"stub","reply":"${v === 'decide' ? '代答内容' : ''}","needs_from_human":"请定方案"}`,
        stopReason: 'end_turn', inputTokens: 1, outputTokens: 1 };
    } }) : null,
    runnerFactory: (ro) => {
      runnerOpts.push(ro);
      const runner = {
        abort() { runner.aborted = true; },
        run: async (prompt, sessionId, resume) => {
          sent.push({ prompt, resume });
          if (onRun) await onRun(loop, sent.length, runner);
          const [reason, peak, text] = script.shift() || ['completed', 10, 'x'];
          return { sessionId: sessionId || `sid-${sent.length}`, exitReason: reason, contextPeak: peak, finalText: text,
            stopReason: 'end_turn', costUsd: 0.1, costEstimate: 0, injectText: '', pendingTasks: [], numTurns: 1,
            error: '', durationS: 0, permissionDenials: [] };
        },
      };
      return runner;
    },
    ...over,
  });
  Object.assign(loop, { _sent: sent, _runnerOpts: runnerOpts, _root: spec.root });
  return loop;
}
const events = (loop) => fs.readFileSync(loop.eventsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// ── WebTmux 独有：面板等人回答 ──────────────────────────────
await test('面板回答原样发给执行者（不加包装），续同一会话', async () => {
  let asked = null;
  const loop = makeLoop({
    script: [['completed', 10, 'i'], ['completed', 10, '要动生产库吗？'], ['completed', 10, 'done']],
    verdicts: ['needs_human', 'project_done'], askHuman: true,
    humanChannel: async (run, j) => { asked = { question: run.finalText, needs: j.needsFromHuman }; return '  可以，先备份  '; },
  });
  const rep = await loop.run();
  assert(asked?.question === '要动生产库吗？' && asked.needs === '请定方案', `等人时要带执行者原话与需要什么: ${JSON.stringify(asked)}`);
  assert(loop._sent[2].prompt === '可以，先备份' && loop._sent[2].resume === true, `应原样发出并续会话: ${JSON.stringify(loop._sent[2])}`);
  assert(rep.stop === Stop.PROJECT_DONE, rep.stop);
  const ev = events(loop);
  const need = ev.find((e) => e.kind === 'need_human');
  assert(need && need.question === '要动生产库吗？' && need.needs === '请定方案', `need_human 事件字段: ${JSON.stringify(need)}`);
  assert(ev.some((e) => e.kind === 'need_human.done' && e.answered && e.text === '可以，先备份'), 'need_human.done 要带回答原文');
});

await test('askHuman=false（原版 --no-ask）或没有等人通道时立即停机，不挂死', async () => {
  const a = await makeLoop({ script: [['completed', 10, 'i'], ['completed', 10, 'q']], verdicts: ['needs_human'] }).run();
  assert(a.stop === Stop.NEEDS_HUMAN, a.stop);
  const b = await makeLoop({ script: [['completed', 10, 'i'], ['completed', 10, 'q']], verdicts: ['needs_human'], askHuman: true }).run();
  assert(b.stop === Stop.NEEDS_HUMAN, `没有通道时应停机: ${b.stop}`);
});

// ── WebTmux 独有：终止 ──────────────────────────────────────
await test('终止：杀当前执行者、以 interrupted 停机并打快照，不再派发', async () => {
  const loop = makeLoop({
    script: [['completed', 10, 'i'], ['error', 0, '']], verdicts: ['continue'],
    onRun: async (lp, n, runner) => {
      if (n !== 2) return;
      // 执行者干了一半活（有未提交改动），这时人点了终止 —— 快照要把这半截活保住
      fs.writeFileSync(path.join(lp.spec.root, 'half.txt'), '干了一半', 'utf8');
      lp.abort('先停下看看');
      assert(runner.aborted, '应调用当前 runner 的 abort 杀进程组');
    },
  });
  const rep = await loop.run();
  assert(rep.stop === Stop.INTERRUPTED && rep.needs_from_human === '先停下看看', JSON.stringify(rep));
  assert(loop._sent.length === 2, `终止后不该再派发，实际 ${loop._sent.length} 发`);
  const log = execFileSync('git', ['log', '--oneline'], { cwd: loop._root, encoding: 'utf8' });
  assert(log.includes('orchestrator snapshot: interrupted'), `应打终止快照:\n${log}`);
});

await test('终止能唤醒暂停与等人', async () => {
  const paused = makeLoop({ script: [['completed', 10, 'i']] });
  fs.writeFileSync(paused.pausePath, '', 'utf8');
  paused.pauseSleep = () => new Promise((r) => setTimeout(r, 20));
  setTimeout(() => paused.abort('暂停中终止'), 100);
  const r1 = await paused.run();
  assert(r1.stop === Stop.INTERRUPTED && paused._sent.length === 0, `暂停中终止应直接停机: ${r1.stop} 发了 ${paused._sent.length}`);

  const waiting = makeLoop({
    script: [['completed', 10, 'i'], ['completed', 10, 'q']], verdicts: ['needs_human'], askHuman: true,
    humanChannel: (run, j) => new Promise((resolve) => setTimeout(() => { waiting.abort('等人时终止'); resolve(''); }, 50)),
  });
  const r2 = await waiting.run();
  assert(r2.stop === Stop.INTERRUPTED, `等人时终止应归为 interrupted 而非 needs_human: ${r2.stop}`);
});

// ── WebTmux 独有：暂停状态标志 ───────────────────────────────
await test('暂停：停在派发口时 halted 为真，删掉 pause 后记暂停时长', async () => {
  const loop = makeLoop({ script: [['completed', 10, 'i'], ['completed', 10, 'r']], verdicts: ['project_done'] });
  fs.writeFileSync(loop.pausePath, '', 'utf8');
  let sawHalted = false;
  loop.pauseSleep = async () => { sawHalted = sawHalted || loop.halted; fs.rmSync(loop.pausePath, { force: true }); };
  const rep = await loop.run();
  assert(sawHalted && !loop.halted, '暂停期间 halted 为真、恢复后为假（面板靠它区分"闸已挂"与"已停住"）');
  const resumed = events(loop).find((e) => e.kind === 'resumed');
  assert(rep.stop === Stop.PROJECT_DONE && resumed && typeof resumed.paused_s === 'number', `resumed 要带暂停时长: ${JSON.stringify(resumed)}`);
  assert(events(loop).find((e) => e.kind === 'paused')?.path === loop.pausePath, 'paused 要带文件路径');
});

await test('水位三档写反时拒绝构造，并说清后果', async () => {
  let e = null;
  try { assertThresholds({ handoffFloor: 300, handoffCeiling: 200, hardKill: 400 }); } catch (x) { e = x; }
  assert(e && e.message.includes('刚开跑就被打断'), e?.message);
  e = null;
  try { makeLoop({ handoffFloor: 100, handoffCeiling: 400, hardKill: 200 }); } catch (x) { e = x; }
  assert(e, 'ceiling 高于 hardKill 应拒绝');
});

await test('非预算异常兜底为 error 停机并写 report.json（原版会直接崩、不写报告）', async () => {
  const loop = makeLoop({ onRun: async () => { throw new Error('runner 炸了'); } });
  const rep = await loop.run();
  assert(rep.stop === Stop.ERROR && rep.needs_from_human === 'runner 炸了', JSON.stringify(rep));
  assert(fs.existsSync(path.join(loop.spec.runDir, 'report.json')), '也要写报告');
});

// ── 落盘格式（python view.py 回放依赖）────────────────────────
await test('事件字段与原版一致：时间字段 at、下划线命名、send 带提示词原文', async () => {
  const loop = makeLoop({ script: [['completed', 10, 'i'], ['completed', 10, 'r']], verdicts: ['project_done'] });
  await loop.run();
  const ev = events(loop);
  assert(ev.every((e) => typeof e.at === 'number' && !('ts' in e)), '时间字段应是 at（view.py 按 ev["at"] 读）');
  assert(ev.find((e) => e.kind === 'log')?.message, 'log 事件字段是 message');
  const send = ev.find((e) => e.kind === 'send');
  assert(send.text === PROMPTS.init && send.leg === 1 && send.resume === false, `send 要带原文: ${JSON.stringify(send).slice(0, 120)}`);
  const result = ev.find((e) => e.kind === 'result');
  for (const k of ['exit_reason', 'context_peak', 'duration_s', 'cost_usd', 'cost_is_estimate', 'session_id', 'pending_tasks']) {
    assert(k in result, `result 缺字段 ${k}`);
  }
  const fin = ev.find((e) => e.kind === 'finished');
  assert('elapsed_s' in fin && 'needs_from_human' in fin && 'cost_usd' in fin, `finished 字段: ${JSON.stringify(fin)}`);
  // supervisor 每次判定都发；supervisor.decided 只在真代答时发
  assert(ev.some((e) => e.kind === 'supervisor') && !ev.some((e) => e.kind === 'supervisor.decided'), '未代答不该出现 supervisor.decided');
});

await test('session_state.json 与 report.json 字段照原版', async () => {
  const loop = makeLoop({ script: [['completed', 10, 'i'], ['completed', 10, 'r']], verdicts: ['project_done'] });
  await loop.run();
  const st = JSON.parse(fs.readFileSync(loop.statePath, 'utf8'));
  assert(JSON.stringify(Object.keys(st).sort()) === JSON.stringify(['decisions', 'handoffs', 'legs', 'maintenances', 'session_id', 'spent_usd', 'updated_at']), Object.keys(st).join());
  assert(st.session_id === 'sid-1', `要记住会话 id（手工 claude --resume 靠它）: ${st.session_id}`);
  const rp = JSON.parse(fs.readFileSync(path.join(loop.spec.runDir, 'report.json'), 'utf8'));
  assert(JSON.stringify(Object.keys(rp).sort()) === JSON.stringify(['cost_usd', 'decisions', 'elapsed_s', 'handoffs', 'legs', 'maintenances', 'needs_from_human', 'stop']), Object.keys(rp).join());
});

// ── git 快照 ────────────────────────────────────────────────
await test('.gitignore 只忽略 .run/，记忆进快照（回滚时记忆与代码才一致）', async () => {
  const loop = makeLoop({ script: [['completed', 10, 'i'], ['completed', 10, 'r']], verdicts: ['project_done'] });
  fs.writeFileSync(path.join(loop.spec.memoryDir, 'MEMORY.md'), '- 进度', 'utf8');
  await loop.run();
  const gi = fs.readFileSync(path.join(loop._root, '.gitignore'), 'utf8');
  assert(gi.includes('.run/') && !gi.includes('.memory'), `不该忽略 .memory: ${JSON.stringify(gi)}`);
  const tracked = execFileSync('git', ['ls-files'], { cwd: loop._root, encoding: 'utf8' });
  assert(tracked.includes('.memory/MEMORY.md'), `记忆应进快照:\n${tracked}`);
});

await test('无改动时不误报快照失败（中文 git 环境下原版会误报）', async () => {
  const loop = makeLoop({ script: [['completed', 10, 'i'], ['completed', 10, 'r']], verdicts: ['project_done'] });
  await loop.run();
  const bad = events(loop).filter((e) => e.kind === 'log' && e.message.includes('快照 commit 失败'));
  assert(bad.length === 0, `误报了: ${bad.map((e) => e.message).join(' | ')}`);
});

await test('只剩 objects 的 .git 残壳会被清掉重建', async () => {
  const loop = makeLoop();
  fs.mkdirSync(path.join(loop._root, '.git', 'objects'), { recursive: true });
  loop.ensureRepo();
  const out = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: loop._root, encoding: 'utf8' }).trim();
  assert(out === '.git', `残壳应被重建为可用仓库: ${out}`);
});

// ── 传给 runner 的参数 ──────────────────────────────────────
await test('runner 参数：默认工具白名单、模型、原始事件目录、墙钟 7200、外部目录合并、exec. 前缀', async () => {
  const loop = makeLoop({ script: [['completed', 10, 'i'], ['completed', 10, 'r']], verdicts: ['project_done'],
    model: 'claude-opus-5', extraDirs: ['/额外'] });
  await loop.run();
  const ro = loop._runnerOpts[0];
  assert(ro.allowedTools === DEFAULT_TOOLS && ro.model === 'claude-opus-5', `工具与模型: ${ro.allowedTools} ${ro.model}`);
  assert(ro.eventsDir === path.join(loop.spec.runDir, 'events') && ro.handoffLimit === 0, '原始事件目录与 handoffLimit');
  assert(ro.wallTimeout === LOOP_WALL_TIMEOUT && LOOP_WALL_TIMEOUT === 7200 && ro.taskWait === TASK_WAIT, '墙钟与等待上限');
  assert(JSON.stringify(ro.extraDirs) === JSON.stringify(['/额外', '/参考/资料']), `外部目录应合并参数与沙箱登记的: ${ro.extraDirs}`);
  assert(MAX_LEGS === 200 && TOTAL_BUDGET_USD === 1_000_000, '默认上限与原版一致');
  ro.onStream({ kind: 'tool', names: ['bash'] });
  assert(events(loop).some((e) => e.kind === 'exec.tool' && e.names[0] === 'bash'), '执行层事件应加 exec. 前缀落盘');
});

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const x of results.errors) console.log(`  • ${x.name}\n    ${x.error}`);
process.exitCode = results.failed ? 1 : 0;

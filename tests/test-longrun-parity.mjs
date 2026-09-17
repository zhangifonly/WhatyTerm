/**
 * 长程编排：与原版 Python 实现对拍 —— 同一输入，逐字节比对输出
 *
 * 用户要求 1:1 移植、不漏逻辑。手写断言只能验"我想到的"，对拍验的是"原版实际怎么做"。
 * 本机有原版编排器（LONGRUN_ORCHESTRATOR_ROOT，默认 ~/Documents/长程编排器）且有 python3
 * 时运行；否则整体跳过。
 *
 * 运行: node tests/test-longrun-parity.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { orchestratorRoot } from '../server/services/LongRunSandbox.js';
import { Supervisor, extractJson } from '../server/services/LongRunSupervisor.js';

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

const ROOT = orchestratorRoot();
const hasPython = spawnSync('python3', ['--version']).status === 0;
if (!fs.existsSync(path.join(ROOT, 'orchestrator', 'supervisor.py')) || !hasPython) {
  console.log(`⊘ 本机没有原版编排器（${ROOT}）或 python3，跳过对拍`);
  process.exit(0);
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'longrun_parity_'));

/** 跑一段 Python，stdin 传 JSON，stdout 回 JSON */
function py(code, input) {
  const file = path.join(TMP, `p${Math.random().toString(36).slice(2)}.py`);
  fs.writeFileSync(file, `import sys, json\nsys.path.insert(0, ${JSON.stringify(ROOT)})\n${code}`, 'utf8');
  const r = spawnSync('python3', [file], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  if (r.status !== 0) throw new Error(`原版脚本出错: ${r.stderr.slice(-800)}`);
  return JSON.parse(r.stdout);
}

/** 找第一处不同，给出上下文 */
function diffAt(a, b) {
  let k = 0;
  while (k < a.length && a[k] === b[k]) k++;
  return `第 ${k} 字起不同\n    原版: ${JSON.stringify(a.slice(Math.max(0, k - 30), k + 40))}\n    Node: ${JSON.stringify(b.slice(Math.max(0, k - 30), k + 40))}`;
}

test('监督者输入（_build_input）逐字节一致：含截断、遗留任务、错误输出', () => {
  const cases = [
    { req: '做一个缓存装饰器。', exit: 'completed', peak: 123456, turns: 7, stop: 'end_turn', text: '全部完成，测试通过', error: '', pending: [], phase: '开发中' },
    { req: '', exit: 'asked_human', peak: 0, turns: 0, stop: null, text: '', error: '', pending: [], phase: '' },
    { req: 'X', exit: 'hang_killed', peak: 350000, turns: 139, stop: 'tool_use', text: '我在等 agent', error: '静默 301s',
      pending: [{ task_id: 'a1', task_type: 'local_agent', description: '子系统A' }, { task_id: 'a2', task_type: 'local_agent', description: '' }], phase: '初始化记忆库' },
    { req: `需${'求'.repeat(25000)}`, exit: 'completed', peak: 1, turns: 1, stop: 'end_turn', text: '尾'.repeat(7000), error: 'E'.repeat(2000), pending: [], phase: '开发中' },
  ];
  const expect = py(`
from orchestrator.supervisor import Supervisor
from orchestrator.runner import RunResult, ExitReason
out = []
for c in json.load(sys.stdin):
    s = Supervisor.__new__(Supervisor); s.requirement_text = c["req"]
    r = RunResult(session_id="s", exit_reason=ExitReason(c["exit"]), exit_code=0, context_peak=c["peak"],
                  num_turns=c["turns"], stop_reason=c["stop"], final_text=c["text"], error=c["error"], pending_tasks=c["pending"])
    out.append(s._build_input(r, c["phase"]))
print(json.dumps(out, ensure_ascii=False))`, cases);
  cases.forEach((c, i) => {
    const sup = new Supervisor({ complete: async () => ({}), systemPrompt: 'x', requirementText: c.req });
    const got = sup.buildInput({ exitReason: c.exit, contextPeak: c.peak, numTurns: c.turns, stopReason: c.stop,
      finalText: c.text, error: c.error, pendingTasks: c.pending }, c.phase);
    assert(got === expect[i], `用例 ${i + 1} ${diffAt(expect[i], got)}`);
  });
});

test('JSON 抽取（extract_json + 字段兜底）结果一致：围栏、前后文、坏引号、缺判定字段', () => {
  const inputs = [
    '{"verdict":"continue","confidence":0.9,"reason":"还有活"}',
    '好的\n```json\n{"verdict":"decide","confidence":0.8,"reply":"用 Postgres"}\n```\n完毕',
    '我的判断：{"verdict":"project_done","confidence":0.92} 以上',
    '{"verdict":"project_done","confidence":0.92,"reason":"它明确说"完成"，测试全通过","needs_from_human":""}',
    '{"verdict":"needs_human","confidence":1,"reason":"要动"生产库"","reply":""}',
    '{"confidence":0.9,"reason":"没有判定字段"}',
    '{"stop":"continue","score":1.2.3}',
    '完全没有 JSON',
    '[1,2,3]',
    '{"a":{"b":{"c":1}}} 然后 {"verdict":"continue"}',
  ];
  const expect = py(`
from orchestrator.llm_client import extract_json, LLMError
out = []
for t in json.load(sys.stdin):
    try: out.append({"ok": extract_json(t)})
    except LLMError: out.append({"err": True})
print(json.dumps(out, ensure_ascii=False))`, inputs);
  inputs.forEach((t, i) => {
    let got;
    try { got = { ok: extractJson(t) }; } catch { got = { err: true }; }
    assert(JSON.stringify(got) === JSON.stringify(expect[i]),
      `输入 ${i + 1} ${JSON.stringify(t).slice(0, 60)}\n    原版: ${JSON.stringify(expect[i])}\n    Node: ${JSON.stringify(got)}`);
  });
});

// ── 会话循环行为对拍 ────────────────────────────────────────
// 38 个场景覆盖原版 _main_phase / _open / _handoff 的全部分支。两端用同样的脚本化 runner 与
// LLM 回复驱动，比对：每一发派了哪段、续/新会话、打断线、费用刹车线；停机结果与计数；
// 落盘事件类型序列（含每条 log 的位置）；session_state.json 与 report.json 的字段。

/**
 * 有意差异白名单（每条写明原因，不许悄悄加）：
 * 回复被 max_tokens 截断时，原版让人"调高 SUPERVISOR_MAX_TOKENS"（.env 变量）；
 * WebTmux 不走 .env，凭据与参数在面板/CC Switch 里，提示文案随之不同。
 */
const INTENTIONAL_NEEDS = { '截断的回复→叫人': ['调高 SUPERVISOR_MAX_TOKENS 后重试', '调高监督者 max_tokens 后重试'] };

async function runNodeScenario(sc, prompts) {
  const { LongRunLoop } = await import('../server/services/LongRunLoop.js');
  const { CONTINUE_PROMPT } = await import('../server/services/LongRunPrompts.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parity_node_'));
  const spec = {
    root, memoryDir: path.join(root, '.memory'), runDir: path.join(root, '.run'), extraDirs: [],
    verifyClean() {}, childEnv: () => ({ ...process.env }),
  };
  for (const d of [spec.memoryDir, spec.runDir]) fs.mkdirSync(d, { recursive: true });

  const script = sc.script.map((x) => [...x]);
  const sent = [];
  const verdicts = [...sc.verdicts];
  const supervisor = verdicts.length ? new Supervisor({
    systemPrompt: 'x',
    complete: async () => {
      const v = verdicts.length === 1 ? verdicts[0] : verdicts.shift();
      if (v && !Array.isArray(v) && typeof v === 'object') {
        if (v.error) throw new Error(v.error);
        return { text: v.raw, stopReason: v.stop || 'end_turn', inputTokens: 10, outputTokens: 10 };
      }
      const [verdict, conf] = Array.isArray(v) ? v : [v, 0.95];
      const reply = verdict === 'decide' ? '用 InstancedMesh 实现，不引入额外依赖' : '';
      return { text: `{"verdict":"${verdict}","confidence":${conf},"reason":"stub","reply":"${reply}","needs_from_human":"确认方案"}`,
        stopReason: 'end_turn', inputTokens: 10, outputTokens: 10 };
    },
  }) : null;

  const kw = { total_budget_usd: 999, ask_human: false, ...(sc.kw || {}) };
  const camel = { total_budget_usd: 'totalBudgetUsd', ask_human: 'askHuman', skip_init: 'skipInit', max_legs: 'maxLegs',
    handoff_floor: 'handoffFloor', handoff_ceiling: 'handoffCeiling', hard_kill: 'hardKill', maintenance_every: 'maintenanceEvery' };
  const opts = {};
  for (const [k, v] of Object.entries(kw)) opts[camel[k]] = v;

  const loop = new LongRunLoop({
    sandbox: spec, prompts, requirementText: '做一个缓存装饰器。', supervisor, ...opts,
    runnerFactory: (ro) => ({
      run: async (prompt, sessionId, resume) => {
        sent.push([prompt, resume, ro.contextLimit, ro.costCeiling]);
        if (!script.length) throw new Error('脚本已空但仍在派发');
        const [reason, peak, text] = script.shift();
        return { sessionId: sessionId || `sid-${sent.length}`, exitReason: reason, exitCode: 0, contextPeak: peak,
          finalText: text, stopReason: 'end_turn', costUsd: sc.cost_each || 0, costEstimate: sc.estimate_each || 0,
          injectText: reason === 'interrupted_by_human' ? (sc.inject_next || '') : '',
          pendingTasks: [], numTurns: 0, error: '', durationS: 0, permissionDenials: [] };
      },
    }),
  });
  const known = [[prompts.init, 'init'], [prompts.wrapup, 'wrapup'], [prompts.resume, 'resume'],
    [prompts.maintain_1, 'maintain1'], [prompts.maintain_2, 'maintain2'], [CONTINUE_PROMPT, 'continue']];
  const label = (t) => known.find(([b]) => b === t)?.[1] || (t.includes('缓存装饰器') ? 'requirement' : t);
  let res;
  try {
    const rep = await loop.run();
    res = { stop: rep.stop, needs: rep.needs_from_human, legs: rep.legs, handoffs: rep.handoffs,
      maintenances: rep.maintenances, decisions: rep.decisions, spent: Math.round(loop.spentUsd * 1e6) / 1e6 };
  } catch (e) { res = { crash: e.name }; }
  res.sent = sent.map(([p, r, k, c]) => [label(p), r, k, c == null ? null : Math.round(c * 1e6) / 1e6]);
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  res.events = read(path.join(spec.runDir, 'orchestrator.jsonl')).split('\n').filter(Boolean).map((l) => JSON.parse(l).kind);
  const keys = (f) => { const t = read(f); return t ? Object.keys(JSON.parse(t)).sort() : []; };
  res.state_keys = keys(path.join(spec.runDir, 'session_state.json'));
  res.report_keys = keys(path.join(spec.runDir, 'report.json'));
  fs.rmSync(root, { recursive: true, force: true });
  return res;
}

test('会话循环 38 个场景与原版行为逐项一致', async () => {
  const scenarios = JSON.parse(fs.readFileSync(new URL('./fixtures/longrun-loop-scenarios.json', import.meta.url), 'utf8'));
  const harness = fileURLToPath(new URL('./fixtures/longrun_loop_harness.py', import.meta.url));
  // LC_ALL=C：原版靠英文 "nothing to commit" 判断无改动，中文 git 下每次都误报快照失败。
  // Node 版已固定 LC_ALL=C 修掉，这里让原版在同一前提下跑，两边才可比
  const r = spawnSync('python3', [harness, ROOT], { input: JSON.stringify(scenarios), encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', LC_ALL: 'C' }, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`原版驱动出错: ${r.stderr.slice(-1200)}`);
  const expected = JSON.parse(r.stdout);
  const { loadPrompts } = await import('../server/services/LongRunPrompts.js');
  const prompts = loadPrompts(path.join(ROOT, '提示词.txt'));
  const problems = [];
  for (let i = 0; i < scenarios.length; i++) {
    const sc = scenarios[i];
    const got = await runNodeScenario(sc, prompts);
    const exp = expected[i];
    const allow = INTENTIONAL_NEEDS[sc.name];
    if (allow && exp.needs === allow[0] && got.needs === allow[1]) got.needs = exp.needs;
    for (const k of ['crash', 'stop', 'needs', 'legs', 'handoffs', 'maintenances', 'decisions', 'spent', 'sent', 'events', 'state_keys', 'report_keys']) {
      if (JSON.stringify(exp[k]) !== JSON.stringify(got[k])) {
        problems.push(`「${sc.name}」${k}\n      原版: ${JSON.stringify(exp[k])}\n      Node: ${JSON.stringify(got[k])}`);
      }
    }
  }
  assert(problems.length === 0, `${problems.length} 处不一致:\n    ${problems.join('\n    ')}`);
});

await Promise.all(pending);
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

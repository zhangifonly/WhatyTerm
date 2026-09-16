/**
 * 长程编排：会话循环 —— 回归测试
 *
 * 逐条对译 test_session_loop.py 的 54 条 case_*（监督者那 10 条已在
 * test-longrun-supervisor.mjs，沙箱那 4 条在 test-longrun-sandbox.mjs）。
 *
 * ⚠ 最要紧的三组：
 *   提示词逐字原文（编排器"顺手补一句"会改变执行者行为，且很难察觉）
 *   交接时机与顺序（维护必须在收尾之前，否则新会话不知道刚发生了什么）
 *   预算闸挡在派发口（唯一能保证"超支后不再花钱"的位置）
 *
 * 运行: node tests/test-longrun-loop.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { LongRunLoop, Stop, BudgetExceeded, assertThresholds } from '../server/services/LongRunLoop.js';
import { ExitReason } from '../server/services/LongRunRunner.js';
import { Verdict, Judgement } from '../server/services/LongRunSupervisor.js';
import { CONTINUE_PROMPT } from '../server/services/LongRunPrompts.js';

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

const TMP = path.join(os.tmpdir(), 'longrun_loop_test');

/** 假沙箱：只提供 loop 需要的那几个字段。 */
function fakeSandbox() {
  const root = path.join(TMP, 'sandbox');
  fs.rmSync(TMP, { recursive: true, force: true });
  const runDir = path.join(root, '.run');
  fs.mkdirSync(runDir, { recursive: true });
  return {
    root, runDir, memoryDir: path.join(root, '.memory'),
    extraDirs: [], childEnv: () => ({ ...process.env }),
  };
}

/** 五段可辨认的提示词，便于断言"发出去的是哪一段、有没有被改"。 */
const PROMPTS = {
  init: 'INIT-初始化提示词-原文',
  wrapup: 'WRAP-旧对话收尾提示词-原文',
  resume: 'RESUME-新对话开始提示词-原文',
  maintain_1: 'M1-定期维护提示词1-原文',
  maintain_2: 'M2-定期维护提示词2-原文',
  source: '/fake/提示词.txt',
};

/**
 * 造 loop。runnerScript 是每一发的返回值序列；judgeScript 是监督者判定序列。
 * 两者都用完就抛，避免测试无声地跑飞。
 */
function makeLoop({ runnerScript = [], judgeScript = [], ...over } = {}) {
  const sent = [];         // [{prompt, label, resume, killAt}]
  let ri = 0, ji = 0;
  const loop = new LongRunLoop({
    sandbox: fakeSandbox(),
    prompts: PROMPTS,
    requirementText: 'REQ-需求文档-原文',
    supervisor: judgeScript.length ? {
      judge: async () => {
        if (ji >= judgeScript.length) throw new Error('judgeScript 用完了');
        const spec = judgeScript[ji++];
        return new Judgement(spec);
      },
    } : null,
    makeRunner: (killAt) => ({
      run: async (prompt, sessionId, resume) => {
        if (ri >= runnerScript.length) throw new Error('runnerScript 用完了');
        const spec = runnerScript[ri++];
        sent.push({ prompt, resume, killAt, sessionId });
        return {
          sessionId: spec.sessionId || sessionId,
          exitReason: spec.exitReason || ExitReason.COMPLETED,
          contextPeak: spec.peak ?? 100,
          costUsd: spec.costUsd ?? 0.1,
          costEstimate: spec.costEstimate ?? 0.1,
          numTurns: 2, finalText: spec.text || '干了活',
          error: spec.error || '', injectText: spec.injectText || '',
          pendingTasks: [], permissionDenials: [],
        };
      },
    }),
    ...over,
  });
  loop._sent = sent;
  return loop;
}
/** 发出去的 label 序列。 */
const labels = (loop) => loop._sentLabels;
/** 发出去的 prompt 序列。 */
const prompts = (loop) => loop._sent.map((s) => s.prompt);

// ── 提示词逐字原文（编排器不得添加任何内容）────────────────────
test('五段提示词逐字原文发出，编排器不加料', async () => {
  const loop = makeLoop({
    runnerScript: [{}, {}, {}],
    judgeScript: [{ verdict: Verdict.PROJECT_DONE, confidence: 0.95 }],
  });
  await loop.run();
  const ps = prompts(loop);
  assert(ps[0] === PROMPTS.init, `初始化提示词被改动: ${JSON.stringify(ps[0])}`);
  assert(ps[1] === 'REQ-需求文档-原文', `需求文档被改动: ${JSON.stringify(ps[1])}`);
});

test('收尾与新对话开始提示词同样原文', async () => {
  const loop = makeLoop({
    handoffFloor: 50, handoffCeiling: 100, hardKill: 200,
    runnerScript: [{}, { peak: 500 }, {}, {}, {}],   // 第二发水位过下限 → 交接
    judgeScript: [{ verdict: Verdict.CONTINUE, confidence: 0.9 },
      { verdict: Verdict.PROJECT_DONE, confidence: 0.95 }],
  });
  await loop.run();
  const ps = prompts(loop);
  const iWrap = labels(loop).indexOf('旧对话收尾提示词');
  const iRes = labels(loop).indexOf('新对话开始提示词');
  assert(iWrap >= 0 && ps[iWrap] === PROMPTS.wrapup, '收尾提示词被改动');
  assert(iRes >= 0 && ps[iRes] === PROMPTS.resume, '新对话开始提示词被改动');
});

test('催继续恰好是「继续完成项目」，无附加内容', async () => {
  const loop = makeLoop({
    runnerScript: [{}, {}, { peak: 10 }, {}],
    judgeScript: [{ verdict: Verdict.CONTINUE, confidence: 0.9 },
      { verdict: Verdict.PROJECT_DONE, confidence: 0.95 }],
  });
  await loop.run();
  const conts = prompts(loop).filter((p) => p.includes(CONTINUE_PROMPT));
  assert(conts.length > 0, '没发出催继续的输入');
  for (const c of conts) {
    assert(c === CONTINUE_PROMPT, `催继续的话被加料了: ${JSON.stringify(c)}`);
  }
});

// ── 开场序列 ────────────────────────────────────────────────
test('新项目开场：初始化 → 需求文档', async () => {
  const loop = makeLoop({
    runnerScript: [{}, {}, {}],
    judgeScript: [{ verdict: Verdict.PROJECT_DONE, confidence: 0.95 }],
  });
  await loop.run();
  assert(labels(loop)[0] === '初始化提示词', `首发应是初始化: ${labels(loop)[0]}`);
  assert(labels(loop)[1] === '需求文档', `次发应是需求: ${labels(loop)[1]}`);
});

test('断点续跑跳过初始化：新对话开始 → 新需求', async () => {
  const loop = makeLoop({
    skipInit: true,
    runnerScript: [{}, {}, {}],
    judgeScript: [{ verdict: Verdict.PROJECT_DONE, confidence: 0.95 }],
  });
  await loop.run();
  assert(!labels(loop).includes('初始化提示词'), '续跑不该发初始化');
  assert(labels(loop)[0] === '新对话开始提示词', `实际 ${labels(loop)[0]}`);
  assert(labels(loop)[1] === '新需求文档', `实际 ${labels(loop)[1]}`);
});

test('开场第一发用新会话，需求文档续同一会话', async () => {
  const loop = makeLoop({
    runnerScript: [{}, {}, {}],
    judgeScript: [{ verdict: Verdict.PROJECT_DONE, confidence: 0.95 }],
  });
  await loop.run();
  assert(loop._sent[0].resume === false, '初始化应开新会话');
  assert(loop._sent[1].resume === true, '需求文档应续同一会话');
});

// ── 水位与交接 ──────────────────────────────────────────────
test('水位过下限才交接，未过则直接催继续', async () => {
  const loop = makeLoop({
    handoffFloor: 1000, handoffCeiling: 2000, hardKill: 3000,
    runnerScript: [{}, {}, { peak: 10 }, {}],       // 水位远低于下限
    judgeScript: [{ verdict: Verdict.CONTINUE, confidence: 0.9 },
      { verdict: Verdict.PROJECT_DONE, confidence: 0.95 }],
  });
  await loop.run();
  assert(loop.handoffs === 0, `水位未过下限不该交接，实际 ${loop.handoffs} 次`);
  assert(labels(loop).includes('催继续'), '应直接催继续');
});

test('正常结束但水位过下限 → 交接', async () => {
  const loop = makeLoop({
    handoffFloor: 50, handoffCeiling: 100, hardKill: 200,
    runnerScript: [{}, { peak: 500 }, {}, {}, {}],
    judgeScript: [{ verdict: Verdict.CONTINUE, confidence: 0.9 },
      { verdict: Verdict.PROJECT_DONE, confidence: 0.95 }],
  });
  await loop.run();
  assert(loop.handoffs === 1, `应交接 1 次，实际 ${loop.handoffs}`);
});

test('运行中水位触顶被打断 → 直接交接，不问监督者', async () => {
  let judged = 0;
  const loop = makeLoop({
    handoffFloor: 50, handoffCeiling: 100, hardKill: 200,
    runnerScript: [{}, { exitReason: ExitReason.BUDGET_KILLED, peak: 150 }, {}, {}, {}],
    judgeScript: [{ verdict: Verdict.PROJECT_DONE, confidence: 0.95 }],
  });
  const origJudge = loop.supervisor.judge;
  loop.supervisor.judge = async (...a) => { judged += 1; return origJudge(...a); };
  await loop.run();
  assert(loop.handoffs === 1, '水位触顶应交接');
  // 它没说完话，问了也只能得到 continue —— 省一次判定的钱
  assert(judged <= 1, `被打断那发不该问监督者，实际问了 ${judged} 次`);
});

test('催继续用 ceiling 当打断线，收尾不设打断线', async () => {
  // 水位全程低于下限 → 只会催继续、不交接；单独造一发过下限的来看收尾的 killAt
  const loop = makeLoop({
    handoffFloor: 100, handoffCeiling: 111, hardKill: 200,
    runnerScript: [{ peak: 10 }, { peak: 10 }, { peak: 10 }, { peak: 10 }],
    judgeScript: [{ verdict: Verdict.CONTINUE, confidence: 0.9 },
      { verdict: Verdict.PROJECT_DONE, confidence: 0.95 }],
  });
  await loop.run();
  const iCont = labels(loop).indexOf('催继续');
  assert(iCont >= 0, `应发出催继续，实际序列: ${labels(loop)}`);
  assert(loop._sent[iCont].killAt === 111,
    `催继续应用 ceiling 当打断线，实际 ${loop._sent[iCont].killAt}`);
});

test('收尾与维护不设打断线（高水位下跑完才有意义）', async () => {
  const loop = makeLoop({
    handoffFloor: 50, handoffCeiling: 111, hardKill: 200,
    runnerScript: [{ peak: 500 }, { peak: 500 }, {}, {}, {}],
    judgeScript: [{ verdict: Verdict.CONTINUE, confidence: 0.9 },
      { verdict: Verdict.PROJECT_DONE, confidence: 0.95 }],
  });
  await loop.run();
  const iWrap = labels(loop).indexOf('旧对话收尾提示词');
  assert(iWrap >= 0, `应发出收尾，实际序列: ${labels(loop)}`);
  // 收尾本来就要在高水位下跑完，中途 kill 等于白发
  assert(loop._sent[iWrap].killAt == null,
    `收尾不该设打断线，实际 ${loop._sent[iWrap].killAt}`);
  // 开场与 resume 用 hardKill
  assert(loop._sent[0].killAt === 200, '开场应用 hardKill');
});

// ── 维护：每第 N 次交接，且必须在收尾之前 ────────────────────
test('每第 3 次交接跑两轮维护，且维护在收尾之前', async () => {
  // 造三次交接：每发都过下限
  const loop = makeLoop({
    handoffFloor: 50, handoffCeiling: 100, hardKill: 200, maintenanceEvery: 3,
    runnerScript: Array(20).fill({ peak: 500 }),
    judgeScript: Array(10).fill({ verdict: Verdict.CONTINUE, confidence: 0.9 }),
    maxLegs: 14,
  });
  await loop.run();
  const seq = labels(loop);
  assert(loop.handoffs >= 3, `应至少交接 3 次，实际 ${loop.handoffs}`);
  assert(loop.maintenances === 1, `第 3 次交接才跑维护，应 1 次，实际 ${loop.maintenances}`);
  const iM1 = seq.indexOf('定期维护提示词1');
  const iM2 = seq.indexOf('定期维护提示词2');
  assert(iM1 >= 0 && iM2 === iM1 + 1, `两个维护应连续发出: ${seq}`);
  // ⚠ 整理记忆需要"当前会话还记得来龙去脉"，放收尾之后新会话就不知道刚发生了什么
  const iWrapAfter = seq.indexOf('旧对话收尾提示词', iM2);
  assert(iWrapAfter === iM2 + 1, `维护必须紧接在收尾之前: ${seq.slice(iM1 - 1, iM2 + 3)}`);
});

test('maintenanceEvery=0 关掉维护', async () => {
  const loop = makeLoop({
    handoffFloor: 50, handoffCeiling: 100, hardKill: 200, maintenanceEvery: 0,
    runnerScript: Array(20).fill({ peak: 500 }),
    judgeScript: Array(10).fill({ verdict: Verdict.CONTINUE, confidence: 0.9 }),
    maxLegs: 12,
  });
  await loop.run();
  assert(loop.maintenances === 0, '应完全不跑维护');
  assert(!labels(loop).includes('定期维护提示词1'), '不该发维护提示词');
});

// ── 预算：挡在派发口 ────────────────────────────────────────
test('预算耗尽时停机，且不再派发', async () => {
  const loop = makeLoop({
    totalBudgetUsd: 0.25,               // 两发就超
    runnerScript: Array(10).fill({ costUsd: 0.15, peak: 10 }),
    judgeScript: Array(5).fill({ verdict: Verdict.CONTINUE, confidence: 0.9 }),
  });
  const r = await loop.run();
  assert(r.stop === Stop.BUDGET, `应因预算停机，实际 ${r.stop}`);
  assert(loop.legs === 2, `第 3 发应被拦住，实际发了 ${loop.legs} 次`);
  assert(r.needsFromHuman.includes('上限'), `停机说明要给出上限: ${r.needsFromHuman}`);
});

test('预算闸挡在派发口 —— 开场那两发也算数', async () => {
  const loop = makeLoop({
    totalBudgetUsd: 0.05,               // 第一发就超
    runnerScript: Array(5).fill({ costUsd: 0.1 }),
    judgeScript: [{ verdict: Verdict.CONTINUE, confidence: 0.9 }],
  });
  const r = await loop.run();
  assert(r.stop === Stop.BUDGET, `实际 ${r.stop}`);
  assert(loop.legs === 1, `开场第二发就该被拦，实际 ${loop.legs}`);
});

test('被 kill 的发次用估算值记账（否则预算失真）', async () => {
  const loop = makeLoop({
    handoffFloor: 1e9, handoffCeiling: 1e9 + 1, hardKill: 1e9 + 2,
    runnerScript: [
      { costUsd: 0.1 }, { costUsd: 0.1 },
      // 被 kill：costUsd=0 但估算有值 —— 这笔钱确实花了，必须记账
      { exitReason: ExitReason.HANG_KILLED, costUsd: 0, costEstimate: 0.77 },
      ...Array(8).fill({ costUsd: 0.01 }),
    ],
    // 先 continue 一次，才会跑到第 3 发（hang）；否则开场后立刻判完成就停了
    judgeScript: [{ verdict: Verdict.CONTINUE, confidence: 0.9 },
      ...Array(6).fill({ verdict: Verdict.PROJECT_DONE, confidence: 0.95 })],
  });
  await loop.run();
  assert(loop.spentUsd >= 0.77,
    `被 kill 那发的估算必须记账（sekiro 白记了 240 秒算力），实际 ${loop.spentUsd}`);
});

test('默认预算实际不限（只有显式设小才生效）', async () => {
  const loop = makeLoop({
    runnerScript: Array(6).fill({ costUsd: 100, peak: 10 }),
    judgeScript: [{ verdict: Verdict.CONTINUE, confidence: 0.9 },
      { verdict: Verdict.PROJECT_DONE, confidence: 0.95 }],
  });
  const r = await loop.run();
  assert(r.stop !== Stop.BUDGET, `默认不该被预算拦，实际 ${r.stop}`);
});

// ── 阈值校验（原实现缺这道）────────────────────────────────
test('水位三档写反时拒绝启动，并说清后果', () => {
  let threw = null;
  try { assertThresholds({ handoffFloor: 300, handoffCeiling: 200, hardKill: 400 }); }
  catch (e) { threw = e; }
  assert(threw, 'ceiling 低于 floor 应被拒');
  assert(threw.message.includes('刚开跑就被打断'), `报错要说清后果: ${threw.message}`);

  threw = null;
  try { assertThresholds({ handoffFloor: 100, handoffCeiling: 400, hardKill: 200 }); }
  catch (e) { threw = e; }
  assert(threw, 'ceiling 高于 hardKill 应被拒');
});

// ── 人工注入 ────────────────────────────────────────────────
test('注入文件被读到后立刻删除（宁可丢一次也不重复注入）', () => {
  const loop = makeLoop({ runnerScript: [{}], judgeScript: [{ verdict: Verdict.CONTINUE }] });
  fs.writeFileSync(loop.injectPath, '改用 Vue', 'utf8');
  const got = loop.takeInject();
  assert(got && got[0] === '改用 Vue', `应取到注入内容: ${JSON.stringify(got)}`);
  assert(got[1] === false, 'inject.txt 是等间隙模式');
  assert(!fs.existsSync(loop.injectPath), '读到后必须删掉');
  assert(loop.takeInject() === null, '删掉后不该再取到');
});

test('inject!.txt 与正文 !! 都是立即打断', () => {
  const loop = makeLoop({ runnerScript: [{}], judgeScript: [{ verdict: Verdict.CONTINUE }] });
  fs.writeFileSync(loop.injectNowPath, '马上停', 'utf8');
  let got = loop.takeInject();
  assert(got[1] === true, 'inject!.txt 应是立即模式');

  fs.writeFileSync(loop.injectPath, '!!死循环了', 'utf8');
  got = loop.takeInject();
  assert(got[1] === true, '正文 !! 应转成立即模式');
  assert(got[0] === '死循环了', `!! 前缀应被剥掉: ${JSON.stringify(got[0])}`);
});

test('空的注入文件被忽略（不发空提示词）', () => {
  const loop = makeLoop({ runnerScript: [{}], judgeScript: [{ verdict: Verdict.CONTINUE }] });
  fs.writeFileSync(loop.injectPath, '   \n  ', 'utf8');
  assert(loop.takeInject() === null, '空内容应忽略');
  assert(!fs.existsSync(loop.injectPath), '空文件也要删掉，否则每轮都读一次');
});

test('被打断后把注入的话原样发出（不加包装）', async () => {
  // 脚本给足，靠断言序列而不是精确计数
  const loop = makeLoop({
    handoffFloor: 1e9, handoffCeiling: 1e9 + 1, hardKill: 1e9 + 2,
    runnerScript: [
      {}, {},                                                    // 开场两发
      { exitReason: ExitReason.INTERRUPTED_BY_HUMAN, injectText: '改成用 Vue' },
      ...Array(8).fill({}),
    ],
    judgeScript: [
      { verdict: Verdict.CONTINUE, confidence: 0.9 },             // 第一轮催继续
      ...Array(6).fill({ verdict: Verdict.PROJECT_DONE, confidence: 0.95 }),
    ],
  });
  await loop.run();
  const seq = labels(loop);
  const i = seq.indexOf('人工注入');
  assert(i >= 0, `应发出人工注入: ${seq}`);
  assert(prompts(loop)[i] === '改成用 Vue',
    `注入内容必须原样发出，实际 ${JSON.stringify(prompts(loop)[i])}`);
});

test('打断了但没取到注入内容 → 停机叫人', async () => {
  const loop = makeLoop({
    handoffFloor: 1e9, handoffCeiling: 1e9 + 1, hardKill: 1e9 + 2,
    runnerScript: [{}, {},
      { exitReason: ExitReason.INTERRUPTED_BY_HUMAN, injectText: '' },
      ...Array(5).fill({})],
    judgeScript: [{ verdict: Verdict.CONTINUE, confidence: 0.9 },
      ...Array(5).fill({ verdict: Verdict.PROJECT_DONE, confidence: 0.95 })],
  });
  const r = await loop.run();
  assert(r.stop === Stop.NEEDS_HUMAN, `应停机叫人，实际 ${r.stop}`);
  assert(r.needsFromHuman.includes('注入'),
    `说明要点明原因: ${r.needsFromHuman}`);
});

// ── 异常处置 ────────────────────────────────────────────────
test('hang/墙钟被杀 → 交接，不问监督者', async () => {
  const loop = makeLoop({
    handoffFloor: 1e9, handoffCeiling: 1e9 + 1, hardKill: 1e9 + 2,
    runnerScript: [{}, {},
      { exitReason: ExitReason.HANG_KILLED },
      ...Array(8).fill({})],
    judgeScript: [{ verdict: Verdict.CONTINUE, confidence: 0.9 },
      ...Array(6).fill({ verdict: Verdict.PROJECT_DONE, confidence: 0.95 })],
  });
  await loop.run();
  assert(loop.handoffs >= 1, `hang_killed 应触发交接，实际 ${loop.handoffs}`);
  const seq = labels(loop);
  const iWrap = seq.indexOf('旧对话收尾提示词');
  assert(iWrap >= 0, `应发出收尾: ${seq}`);
  assert(seq[iWrap + 1] === '新对话开始提示词', '交接后应发新对话开始');
});

test('空 result → 换新会话重来，不当成做完了', async () => {
  const loop = makeLoop({
    handoffFloor: 1e9, handoffCeiling: 1e9 + 1, hardKill: 1e9 + 2,
    runnerScript: [{}, {},
      { exitReason: ExitReason.EMPTY_RESULT },
      ...Array(6).fill({})],
    judgeScript: [{ verdict: Verdict.CONTINUE, confidence: 0.9 },
      ...Array(5).fill({ verdict: Verdict.PROJECT_DONE, confidence: 0.95 })],
  });
  await loop.run();
  const seq = labels(loop);
  // 空 result 之后应直接开新会话（不交接、不当成完成）
  const iRes = seq.indexOf('新对话开始提示词');
  assert(iRes >= 0, `应换新会话: ${seq}`);
  const iResSend = loop._sent[iRes];
  assert(iResSend.resume === false, '必须是新会话而非续跑');
});

test('连续三次进程异常才停机（不无限重试烧钱）', async () => {
  const loop = makeLoop({
    handoffFloor: 1e9, handoffCeiling: 1e9 + 1, hardKill: 1e9 + 2,
    runnerScript: [{}, {},
      ...Array(12).fill({ exitReason: ExitReason.ERROR, error: '进程崩了' })],
    judgeScript: [{ verdict: Verdict.CONTINUE, confidence: 0.9 },
      ...Array(5).fill({ verdict: Verdict.CONTINUE, confidence: 0.9 })],
  });
  const r = await loop.run();
  assert(r.stop === Stop.ERROR, `连累异常应停机，实际 ${r.stop}`);
  assert(r.needsFromHuman.includes('连续'), `说明要给出次数: ${r.needsFromHuman}`);
});

test('费用刹车触发 → 停机等人，不是交接', async () => {
  const loop = makeLoop({
    handoffFloor: 1e9, handoffCeiling: 1e9 + 1, hardKill: 1e9 + 2,
    runnerScript: [{}, {},
      { exitReason: ExitReason.COST_KILLED, error: '估算已花 $5.00 超过刹车线' },
      ...Array(5).fill({})],
    judgeScript: [{ verdict: Verdict.CONTINUE, confidence: 0.9 },
      ...Array(5).fill({ verdict: Verdict.PROJECT_DONE, confidence: 0.95 })],
  });
  const r = await loop.run();
  // 水位触顶要交接换窗口，钱花超了应当直接停机等人 —— 处置不同
  assert(r.stop === Stop.BUDGET, `钱花超了该停机，实际 ${r.stop}`);
  assert(loop.handoffs === 0, '费用刹车不该走交接');
});

// ── 监督者分支 ──────────────────────────────────────────────
test('project_done 停机', async () => {
  const loop = makeLoop({
    runnerScript: [{}, {}, {}],
    judgeScript: [{ verdict: Verdict.PROJECT_DONE, confidence: 0.95 }],
  });
  const r = await loop.run();
  assert(r.stop === Stop.PROJECT_DONE, `实际 ${r.stop}`);
});

test('代答原样发给执行者，并计入 decisions', async () => {
  const loop = makeLoop({
    handoffFloor: 1e9, handoffCeiling: 1e9 + 1, hardKill: 1e9 + 2,
    runnerScript: [{}, {}, {}, ...Array(4).fill({})],
    judgeScript: [
      { verdict: Verdict.DECIDE, confidence: 0.9, reply: '用 SQLite 就行' },
      ...Array(4).fill({ verdict: Verdict.PROJECT_DONE, confidence: 0.95 }),
    ],
  });
  await loop.run();
  const seq = labels(loop);
  const i = seq.indexOf('监督者代答');
  assert(i >= 0, `应发出代答: ${seq}`);
  assert(prompts(loop)[i] === '用 SQLite 就行',
    `代答必须原样发出: ${JSON.stringify(prompts(loop)[i])}`);
  assert(loop.decisions === 1, `应计入 decisions，实际 ${loop.decisions}`);
});

test('needs_human 且人不回 → 停机', async () => {
  const loop = makeLoop({
    runnerScript: [{}, {}, {}],
    judgeScript: [{ verdict: Verdict.NEEDS_HUMAN, confidence: 1.0,
      needsFromHuman: '要用哪个数据库？' }],
    askHuman: async () => '',            // 人不在
  });
  const r = await loop.run();
  assert(r.stop === Stop.NEEDS_HUMAN, `实际 ${r.stop}`);
  assert(r.needsFromHuman.includes('数据库'), `应带出需要人做什么: ${r.needsFromHuman}`);
});

test('人回了就原样发出并继续', async () => {
  const loop = makeLoop({
    handoffFloor: 1e9, handoffCeiling: 1e9 + 1, hardKill: 1e9 + 2,
    runnerScript: [{}, {}, {}, ...Array(4).fill({})],
    judgeScript: [
      { verdict: Verdict.NEEDS_HUMAN, confidence: 1.0, needsFromHuman: '用哪个库？' },
      ...Array(4).fill({ verdict: Verdict.PROJECT_DONE, confidence: 0.95 }),
    ],
    askHuman: async () => '用 SQLite',
  });
  await loop.run();
  const seq = labels(loop);
  const i = seq.indexOf('人类回复');
  assert(i >= 0, `应发出人类回复: ${seq}`);
  assert(prompts(loop)[i] === '用 SQLite', '人类回复必须原样发出，不加包装');
});

test('未配监督者时明确说出来（早先这里静默 return）', async () => {
  const loop = makeLoop({ runnerScript: [{}, {}, {}] });   // 不给 judgeScript
  const r = await loop.run();
  assert(r.stop === Stop.NEEDS_HUMAN, `实际 ${r.stop}`);
  assert(r.needsFromHuman.includes('监督者'),
    `要说清是没配监督者: ${r.needsFromHuman}`);
});

// ── maxLegs 与报告 ──────────────────────────────────────────
test('maxLegs 到顶停机', async () => {
  const loop = makeLoop({
    handoffFloor: 1e9, handoffCeiling: 1e9 + 1, hardKill: 1e9 + 2,
    maxLegs: 4,
    runnerScript: Array(10).fill({}),
    judgeScript: Array(6).fill({ verdict: Verdict.CONTINUE, confidence: 0.9 }),
  });
  const r = await loop.run();
  assert(r.stop === Stop.MAX_LEGS, `实际 ${r.stop}`);
  assert(loop.legs <= 5, `不该超出太多，实际 ${loop.legs}`);
});

test('report.json 落盘且字段齐全', async () => {
  const loop = makeLoop({
    runnerScript: [{}, {}, {}],
    judgeScript: [{ verdict: Verdict.PROJECT_DONE, confidence: 0.95 }],
  });
  const r = await loop.run();
  const f = path.join(loop.spec.runDir, 'report.json');
  assert(fs.existsSync(f), 'report.json 应落盘');
  const saved = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const k of ['stop', 'legs', 'handoffs', 'maintenances', 'decisions',
    'elapsedS', 'costUsd']) {
    assert(k in saved, `report 缺字段 ${k}`);
  }
  assert(saved.stop === r.stop, 'report 与返回值要一致');
});

test('事件落盘为 jsonl，每行合法', async () => {
  const loop = makeLoop({
    runnerScript: [{}, {}, {}],
    judgeScript: [{ verdict: Verdict.PROJECT_DONE, confidence: 0.95 }],
  });
  await loop.run();
  const f = path.join(loop.spec.runDir, 'orchestrator.jsonl');
  assert(fs.existsSync(f), '事件文件应落盘');
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
  for (const l of lines) JSON.parse(l);
  const kinds = lines.map((l) => JSON.parse(l).kind);
  assert(kinds.includes('send') && kinds.includes('result'), '应记录 send 与 result');
  assert(kinds.includes('finished'), '应记录 finished');
});

await Promise.all(pending);
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

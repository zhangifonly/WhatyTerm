/**
 * 长程 ⇄ 普通会话 切换的预检。
 *
 * 失败代价不对称，所以判据要分清「不能切」与「能切但要知道」：
 *   · 转长程时 CLI 还在跑 → 编排器和人同时往一个 tmux 里按键，屏幕被搅乱
 *   · 转终端时长程还在跑 → 执行者被打断，当前这发的成果丢掉
 * 两者都必须是 blocker，不能降级成提示。
 *
 * 运行: node tests/test-longrun-switch.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { switchPlan, suggestResume, SWITCH_MODES } from '../server/services/longrunSwitch.js';
import { MODE_SWITCH_NOTICE, loadPrompts } from '../server/services/LongRunPrompts.js';
import { LongRunLoop } from '../server/services/LongRunLoop.js';

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function test(name, fn) {
  try { fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}

/** 一切正常的终端会话，要转长程 */
const OK_TO_LONGRUN = {
  to: 'longrun', from: 'terminal', rootExists: true, cliRunning: false,
  longRunRunning: false, hasSessionId: true, hasMemory: true, hasRequirement: true,
  contextPeak: 120_000, handoffFloor: 200_000,
};
const hit = (list, re) => list.some((s) => re.test(s));

test('正常情况可切，且给出推荐方式', () => {
  const p = switchPlan(OK_TO_LONGRUN);
  assert(p.ok === true, JSON.stringify(p.blockers));
  assert(p.blockers.length === 0 && p.warnings.length === 0, JSON.stringify(p));
  assert(p.suggest?.mode === SWITCH_MODES.RESUME, '水位宽裕时应推荐续同一条对话');
});

test('转长程：CLI 在跑但空闲 → **不拦**，只提醒会先让它退出（v1.4.42 回归）', () => {
  // 原来这条测试断言的是"必须拦"—— 测试把错误行为钉成了正确。
  // 实测后果：普通会话里 CLI 几乎总在跑，35 个会话 0 个能转长程，
  // 而专门处理这种情况的交接向导（写记忆→退出）被挡在预检后面永远走不到。
  const p = switchPlan({ ...OK_TO_LONGRUN, cliRunning: true, cliBusy: false });
  assert(p.ok === true, 'CLI 空闲时应放行，两种续接方式都会先让它退出：' + JSON.stringify(p.blockers));
  assert(hit(p.warnings, /先让这个会话里的 CLI 退出/), '要说清会发生什么：' + JSON.stringify(p.warnings));
});

test('转长程：非 Claude 会话明确拦住，说清原因，且不给「续同一条对话」', () => {
  // 实测：两个空闲的 Codex 会话被判成"在忙"—— 空闲判定按 Claude 输入框写的，别的 CLI 永远判成在忙。
  // 拦对了但理由错了；更要紧的是「续同一条对话」会去目录里找 Claude 的旧对话记录，
  // 目录以前跑过 Claude 就会续上一条不相干的对话。
  const p = switchPlan({ ...OK_TO_LONGRUN, cliType: 'codex', cliRunning: true, cliBusy: true });
  assert(p.ok === false, '非 Claude 会话不能转');
  assert(p.blockers.some((b) => /执行者是 Claude Code/.test(b) && /codex/.test(b)), '要说清真实原因：' + JSON.stringify(p.blockers));
  assert(!p.blockers.some((b) => /不在空闲的输入框/.test(b)), '不能再用"在忙"这种错误理由');
  assert(p.blockers.some((b) => /新开一个 Claude 会话/.test(b)), '要给出路');
  assert(p.suggest === null, '不该推荐续接 —— 那会去续一条不相干的旧 Claude 对话');
  // Claude 会话不受影响
  assert(switchPlan({ ...OK_TO_LONGRUN, cliType: 'claude' }).ok === true, 'Claude 会话被误伤');
});

test('转长程：CLI 正在干活 → 拦（不打断它）', () => {
  const p = switchPlan({ ...OK_TO_LONGRUN, cliRunning: true, cliBusy: true });
  assert(p.ok === false && hit(p.blockers, /正在干活|回到输入框/), JSON.stringify(p.blockers));
});

test('转终端：长程还在跑必须是 blocker（否则执行者被打断、成果丢掉）', () => {
  const p = switchPlan({ to: 'terminal', from: 'longrun', rootExists: true, cliRunning: false, longRunRunning: true });
  assert(p.ok === false, '不该放行');
  assert(hit(p.blockers, /长程还在跑/), JSON.stringify(p.blockers));
  assert(hit(p.blockers, /停下当前/), '要告诉人先怎么做：' + JSON.stringify(p.blockers));
});

test('转长程：没有 .memory 也**不拦** —— 需求在下一步弹窗里填（v1.4.42 回归）', () => {
  // 原来这条断言"既没需求也没记忆就拦"，而服务层拿「有没有 .memory」当需求判据。
  // 实测 35 个项目只有 1 个有 .memory，于是 34 个被这条拦死。
  const p = switchPlan({ ...OK_TO_LONGRUN, hasMemory: false });
  assert(p.ok === true, '没有 .memory 不该拦：' + JSON.stringify(p.blockers));
  assert(!hit(p.blockers, /不知道该做什么|没有需求/), '预检这一步不该查需求');
});

test('目录不存在、模式相同 → 拦住', () => {
  assert(switchPlan({ ...OK_TO_LONGRUN, rootExists: false }).ok === false, '目录不存在要拦');
  const same = switchPlan({ ...OK_TO_LONGRUN, from: 'longrun' });
  assert(same.ok === false && hit(same.blockers, /已经是长程/), JSON.stringify(same.blockers));
});

test('同一目录已有别的长程在跑 → 拦住（两个编排器抢同一份 .run）', () => {
  const p = switchPlan({ ...OK_TO_LONGRUN, otherLongRunOnRoot: true });
  assert(p.ok === false && hit(p.blockers, /同一个项目目录/), JSON.stringify(p.blockers));
});

test('转长程时 CLI 输入框有草稿 → 拦（退出/交接那一步会拒绝，不如预检就说）', () => {
  const p = switchPlan({ ...OK_TO_LONGRUN, cliRunning: true, pendingDraft: '把登录页也改一下' });
  assert(p.ok === false, '草稿在时 quitCli/handoff 都会拒绝，预检放行只会让人点了再报错');
  assert(hit(p.blockers, /把登录页/), '要把草稿内容摆出来：' + JSON.stringify(p.blockers));
});

test('上一轮被中断 → 是 warning 不是 blocker（能切，但要知道）', () => {
  const p = switchPlan({ ...OK_TO_LONGRUN, interrupted: { interrupted: true, legs: 12 } });
  assert(p.ok === true, '被中断不该阻止切换：' + JSON.stringify(p.blockers));
  assert(hit(p.warnings, /没有正常收工|12 发/), JSON.stringify(p.warnings));
  assert(hit(p.warnings, /记忆与快照|续跑能接上/), '提中断就要说清不影响什么');
});

test('推荐规则：水位低推荐续接，到线推荐交接，阈值沿用水位交接那一套', () => {
  const low = suggestResume({ hasSessionId: true, contextPeak: 100_000, handoffFloor: 200_000 });
  assert(low.mode === SWITCH_MODES.RESUME, low.reason);
  assert(/低于交接下限/.test(low.reason) && /100,000/.test(low.reason), '理由要带实测数字：' + low.reason);

  const high = suggestResume({ hasSessionId: true, contextPeak: 210_000, handoffFloor: 200_000 });
  assert(high.mode === SWITCH_MODES.HANDOFF, high.reason);
  assert(/已到交接下限/.test(high.reason), high.reason);

  // 边界：正好等于下限算"已到"，与 decideHandover 同口径
  assert(suggestResume({ hasSessionId: true, contextPeak: 200_000, handoffFloor: 200_000 }).mode === SWITCH_MODES.HANDOFF,
    '等于下限应判为已到，与水位交接同口径');
});

test('推荐方式：两个选项都要列出来，人可以改', () => {
  const s = suggestResume({ hasSessionId: true, contextPeak: 100_000, handoffFloor: 200_000 });
  assert(s.options?.length === 2, '要把两种方式都摆出来');
  assert(s.options.every((o) => o.label && o.detail), '每项都要说清是什么');
});

test('拿不到会话 id 或水位 → 退回交接，且标明是被迫的', () => {
  const noId = suggestResume({ hasSessionId: false, contextPeak: 100_000, handoffFloor: 200_000 });
  assert(noId.mode === SWITCH_MODES.HANDOFF && noId.forced === true, '找不到会话 id 时只能交接，且要标 forced');
  const noPeak = suggestResume({ hasSessionId: true });
  assert(noPeak.mode === SWITCH_MODES.HANDOFF, '取不到水位要稳妥选交接');
  assert(/取不到当前水位/.test(noPeak.reason), noPeak.reason);
});

test('推荐续接但水位已接近交接线 → 额外提醒代价', () => {
  const p = switchPlan({ ...OK_TO_LONGRUN, contextPeak: 200_000, handoffFloor: 200_000 });
  // 这一档推荐的是交接，所以不该有"续了马上要交接"的提醒
  assert(p.suggest.mode === SWITCH_MODES.HANDOFF, p.suggest.reason);
});

test('转终端方向不给续接推荐（那是转长程才要决定的事）', () => {
  const p = switchPlan({ to: 'terminal', from: 'longrun', rootExists: true, longRunRunning: false });
  assert(p.suggest === null, '转终端不该给 suggest');
  assert(p.ok === true, JSON.stringify(p.blockers));
});

test('空参数不炸，且默认不放行（信息不足时宁可拦住）', () => {
  const p = switchPlan();
  assert(p.ok === false, '什么都不知道时不该放行');
  assert(Array.isArray(p.blockers) && Array.isArray(p.warnings), JSON.stringify(p));
  assert(suggestResume() && suggestResume(null).mode === SWITCH_MODES.HANDOFF, 'suggestResume 空参数要有兜底');
});

test('续用旧对话前必须声明规则变了（权限白名单不同，静默换会让它反复撞墙）', () => {
  assert(/权限|白名单/.test(MODE_SWITCH_NOTICE), '没说权限变严');
  assert(/无人值守|不再有人/.test(MODE_SWITCH_NOTICE), '没说没人盯着了');
  assert(/停下等我|不要自己挑/.test(MODE_SWITCH_NOTICE), '没说业务决策要停下问');
  assert(/记忆/.test(MODE_SWITCH_NOTICE), '没说要写记忆');
  assert(/不要改变当前任务|继续做下去/.test(MODE_SWITCH_NOTICE), '声明不该让它中断手上的活');
});

// ── loop 层：续接终端那条对话 ─────────────────────────────────────
const PROMPTS = loadPrompts(fileURLToPath(new URL('../server/prompts/longrun/提示词.txt', import.meta.url)));

/** 只跑开场（open）就停：script 第一发给 project_done，避免真去跑循环 */
function openWith(over) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lrsw_'));
  const spec = { root, memoryDir: path.join(root, '.memory'), runDir: path.join(root, '.run'), extraDirs: [],
    verifyClean() {}, childEnv: () => ({ ...process.env }) };
  for (const d of [spec.memoryDir, spec.runDir]) fs.mkdirSync(d, { recursive: true });
  const calls = [];
  const loop = new LongRunLoop({
    sandbox: spec, prompts: PROMPTS, requirementText: '把登录页补上测试', askHuman: false, supervisor: null,
    runnerFactory: () => ({
      abort() {},
      run: async (prompt, sessionId, resume) => {
        calls.push({ prompt, sessionId, resume });
        return { sessionId: sessionId || 'new-sid', exitReason: 'completed', contextPeak: 10, finalText: '好',
          stopReason: 'end_turn', costUsd: 0.1, costEstimate: 0, injectText: '', pendingTasks: [], numTurns: 1,
          error: '', durationS: 0, permissionDenials: [] };
      },
    }),
    ...over,
  });
  return { loop, calls, root };
}

await (async () => {
  const RESUME_ID = '58215909-4156-48e6-91de-baa87326328f';
  const { loop, calls } = openWith({ resumeSessionId: RESUME_ID });
  await loop.open();

  test('续接：第一发就用终端那条会话 id，且 resume=true（上下文不丢）', () => {
    assert(calls.length === 1, `开场应只发一发，实际 ${calls.length} 发`);
    assert(calls[0].sessionId === RESUME_ID, `没续那条会话：${calls[0].sessionId}`);
    assert(calls[0].resume === true, '没带 resume —— 那会开一条新对话，上下文全丢');
  });

  test('续接：不发初始化、不发新对话开始提示词（那会让它从头来）', () => {
    const p = calls[0].prompt;
    assert(!p.includes(PROMPTS.init.slice(0, 40)), '发了初始化提示词');
    assert(!p.includes(PROMPTS.resume.slice(0, 40)), '发了新对话开始提示词 —— 它正记着上下文，不需要从记忆重建');
  });

  test('续接：第一发必须带上规则变更声明，且新需求也捎过去', () => {
    const p = calls[0].prompt;
    assert(p.includes(MODE_SWITCH_NOTICE), '没声明运行方式变了');
    assert(p.includes('把登录页补上测试'), '新增需求没发出去');
    assert(p.indexOf(MODE_SWITCH_NOTICE) < p.indexOf('把登录页补上测试'), '声明要在需求之前，先立规则再派活');
  });
})();

await (async () => {
  // 不给 resumeSessionId 时必须走原来的路径，不能被新分支影响
  const { loop, calls } = openWith({ skipInit: true });
  await loop.open();
  test('不传 resumeSessionId 时行为不变（续跑仍发新对话提示词 + 需求）', () => {
    assert(calls.length === 2, `续跑应发两发，实际 ${calls.length}`);
    assert(calls[0].resume === false && calls[1].resume === true, JSON.stringify(calls.map((c) => c.resume)));
    assert(!calls[0].prompt.includes(MODE_SWITCH_NOTICE), '不该出现规则声明');
  });
})();

// ── 服务层：事实由 switchPlanFor 自己算，不是测试喂的 ─────────────────
// ⚠ v1.4.42 的回归就出在这一层：上面的纯逻辑测试全绿，因为它们直接喂「事实」；
//   而服务层算出的真实事实是错的（拿「有没有 .memory」当需求判据）。
//   所以这里用一个真实的临时目录（**不建 .memory**，和 34/35 个真实项目一样）走一遍。
const { LongRunService } = await import('../server/services/LongRunService.js');

function serviceFor(root, aiType = 'claude') {
  const io = { emit() {}, to() { return { emit() {} }; } };
  const svc = new LongRunService({
    io, aiEngine: null,
    sessionBinder: { get: () => ({ id: 's1', workingDir: root, runMode: 'terminal', aiType }) },
  });
  return svc;
}

await (async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lrsw_svc_'));   // 普通项目：没有 .memory、没有 .run
  const svc = serviceFor(root);

  test('服务层：没有 .memory 的普通项目、CLI 空闲 → 能转长程（真实项目的常态）', () => {
    const p = svc.switchPlanFor('s1', { to: 'longrun', cliRunning: true, cliBusy: false });
    assert(p.ok === true, `普通项目被拦了 —— 这正是 35 个会话 0 个能转的回归：${JSON.stringify(p.blockers)}`);
    assert(p.cliRunning === true, 'cliRunning 要带回界面，续接前据此决定是否先让 CLI 退出');
  });

  test('服务层：CLI 在忙才拦', () => {
    const p = svc.switchPlanFor('s1', { to: 'longrun', cliRunning: true, cliBusy: true });
    assert(p.ok === false && p.blockers.some((b) => /不在空闲的输入框/.test(b)), JSON.stringify(p.blockers));
  });

  test('服务层：会话的 CLI 类型要从条目里取出来传下去（Codex 会话按真实原因拦）', () => {
    const p = serviceFor(root, 'codex').switchPlanFor('s1', { to: 'longrun', cliRunning: true, cliBusy: true });
    assert(p.ok === false && p.blockers.some((b) => /执行者是 Claude Code/.test(b)),
      '服务层没把 aiType 传下去，Codex 会话又会被"在忙"这种错误理由拦：' + JSON.stringify(p.blockers));
  });

  fs.rmSync(root, { recursive: true, force: true });
})();

// ── 守卫 ──────────────────────────────────────────────────────────
const SRC = fs.readFileSync(new URL('../server/services/longrunSwitch.js', import.meta.url), 'utf8');

test('守卫：预检是纯逻辑，不自己做 IO（事实由调用方查好传进来）', () => {
  assert(!/require\(|readFileSync|existsSync|execSync|spawn/.test(SRC),
    '预检里出现了 IO —— 那样就没法单测，也会把"查不到"和"不允许"混成一件事');
});

const IDX = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
const DLG = fs.readFileSync(new URL('../src/components/longrun/LongRunSwitchDialog.jsx', import.meta.url), 'utf8');

test('守卫：预检接口要算出「在忙」并传下去（只有在忙才拦）', () => {
  const at = IDX.indexOf("socket.on('longrun:switchPlan'");
  const seg = IDX.slice(at, at + 1500);
  assert(/cliBusy = cliRunning && !isClaudeInputReady\(/.test(seg), '没按"CLI 在跑但不在输入框"算在忙');
  assert(/switchPlanFor\(sessionId, \{[^}]*cliBusy/.test(seg), '算了没传给服务层');
});

test('守卫：续同一条对话前，CLI 在跑就先让它退出（否则长程与它抢同一条对话）', () => {
  const at = DLG.indexOf("mode === 'resume_session'");
  const seg = DLG.slice(at, at + 700);
  assert(/plan\.cliRunning/.test(seg) && /longrun:quitCli/.test(seg), '续接路径没有先退 CLI');
  assert(seg.indexOf('longrun:quitCli') < seg.indexOf('onNeedStart'), '必须先退出、再开长程');
});

test('守卫：退出 CLI 的接口在发 /quit 前查草稿、等空闲（不搅草稿、不打断干活）', () => {
  const at = IDX.indexOf("socket.on('longrun:quitCli'");
  assert(at > 0, '缺 longrun:quitCli');
  const seg = IDX.slice(at, at + 1800);
  const q = seg.indexOf('quitCliAndWait(');
  assert(q > 0, '没调公共退出函数');
  // 查的是「拒绝动作」而不是「调用了判定函数」：只算不拒等于没查（变异测试当场漏过一次）
  const refuseDraft = seg.search(/if \(pending\) return reply\(/);
  assert(refuseDraft > 0 && refuseDraft < q, '发 /quit 前没有「有草稿就拒绝」');
  const refuseBusy = seg.search(/if \(!ready\) return reply\(/);
  assert(refuseBusy > 0 && refuseBusy < q, '发 /quit 前没有「不空闲就拒绝」');
});

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

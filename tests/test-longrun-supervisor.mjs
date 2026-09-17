/**
 * 长程编排：监督者 —— 回归测试
 *
 * 逐条对译 test_session_loop.py 里的监督者用例：
 *   case_supervisor_decides_on_requirement / case_done_judged_only_by_executor_words /
 *   case_decide_sends_reply_verbatim / case_decide_low_confidence_asks_human /
 *   case_decide_without_reply_asks_human / case_requirement_reaches_supervisor /
 *   case_no_supervisor_stops / case_done_low_confidence_downgraded /
 *   case_broken_json_salvaged / case_llm_down_asks_human
 *
 * ⚠ 这些断言防的是两类事故：
 *   误判 project_done → 整个项目提前停摆；
 *   没把握却代答 → 错误的"人类意图"被原样写进记忆库，比这次运行活得更久。
 *
 * 运行: node tests/test-longrun-supervisor.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  Supervisor, Verdict, Judgement, extractJson, loadSystemPrompt,
  SupervisorPromptError, REQUIRED_MARKERS,
  DONE_CONFIDENCE_FLOOR, DECIDE_CONFIDENCE_FLOOR, REQUIREMENT_BUDGET,
} from '../server/services/LongRunSupervisor.js';
import { ExitReason } from '../server/services/LongRunRunner.js';

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

/** 造一个回固定 JSON 的假监督者 LLM。 */
function stubSupervisor(payload, over = {}) {
  const seen = [];
  const sup = new Supervisor({
    systemPrompt: 'verdict continue project_done decide needs_human',   // 满足契约校验
    maxTokens: 4000,
    requirementText: over.requirement || '',
    complete: async (sys, user) => {
      seen.push({ sys, user });
      if (over.throwError) throw new Error(over.throwError);
      return {
        text: typeof payload === 'string' ? payload : JSON.stringify(payload),
        inputTokens: 1000, outputTokens: 50,
        stopReason: over.stopReason || 'end_turn',
      };
    },
  });
  sup._seen = seen;
  return sup;
}

const runOk = (over = {}) => ({
  exitReason: ExitReason.COMPLETED, numTurns: 3, contextPeak: 50000,
  finalText: '做了一部分', error: '', pendingTasks: [], permissionDenials: [], ...over,
});

// ── 提示词契约 ──────────────────────────────────────────────
test('真实监督者提示词满足输出契约', () => {
  const { text } = loadSystemPrompt();
  for (const m of REQUIRED_MARKERS) {
    assert(text.includes(m), `提示词缺关键词 ${m}`);
  }
});

test('缺输出契约的提示词硬失败（否则每次判定都降级成叫人）', () => {
  let threw = null;
  try {
    new Supervisor({ systemPrompt: '随便写点什么', complete: async () => ({}) });
    // systemPrompt 直接给时不校验，改成走 loadSystemPrompt 的路径
    loadSystemPrompt('/nope/不存在.txt');
  } catch (e) { threw = e; }
  assert(threw instanceof SupervisorPromptError, '应抛 SupervisorPromptError');
});

// ── 四类判定 ────────────────────────────────────────────────
test('continue：还没做完就催继续，且不给答案', async () => {
  const sup = stubSupervisor({ verdict: 'continue', confidence: 0.9, reason: '还有剩余工作' });
  const j = await sup.judge(runOk());
  assert(j.shouldContinue, `应判 continue，实际 ${j.verdict}`);
  assert(j.confidence === 0.9);
});

test('project_done：置信度够就认（哪怕说得笼统）', async () => {
  const sup = stubSupervisor({ verdict: 'project_done', confidence: 0.95, reason: '它说全做完了' });
  const j = await sup.judge(runOk({ finalText: '全部需求已实现，测试通过' }));
  assert(j.projectDone, `应判完成，实际 ${j.verdict}`);
});

// 误判成完成会让整个项目提前停摆，误判成未完成只是多跑一轮 —— 代价不对称
test('project_done 置信度不足时降级为继续', async () => {
  const low = DONE_CONFIDENCE_FLOOR - 0.1;
  const sup = stubSupervisor({ verdict: 'project_done', confidence: low, reason: '看着像做完了' });
  const j = await sup.judge(runOk());
  assert(j.shouldContinue, `应降级为继续，实际 ${j.verdict}`);
  assert(j.reason.includes('低于下限'), `理由要说明降级原因: ${j.reason}`);
  assert(j.reason.includes('原依据'), '要保留监督者原本的依据，便于事后查');
});

test('decide：代答内容原样带出，供上层不加包装地发出', async () => {
  const sup = stubSupervisor({
    verdict: 'decide', confidence: 0.9,
    reason: '需求文档里写了用 Postgres', reply: '用 Postgres，不要 SQLite',
  });
  const j = await sup.judge(runOk({ finalText: '用哪个数据库？' }));
  assert(j.decided, `应判代答，实际 ${j.verdict}`);
  assert(j.reply === '用 Postgres，不要 SQLite', '代答内容必须原样保留');
});

// 代答会被原样当成人类意图执行并写进记忆库，所以宁可停机
test('decide 置信度不足时改为叫人，并把拟答告诉人', async () => {
  const low = DECIDE_CONFIDENCE_FLOOR - 0.1;
  const sup = stubSupervisor({
    verdict: 'decide', confidence: low, reason: '文档没写清', reply: '大概用 Redis 吧',
  });
  const j = await sup.judge(runOk());
  assert(j.needsHuman, `应改为叫人，实际 ${j.verdict}`);
  assert(j.needsFromHuman.includes('大概用 Redis 吧'),
    '要把拟答给人看，否则人不知道它想答什么');
  assert(j.reason.includes('低于下限'), `理由要说明: ${j.reason}`);
});

test('decide 却没给答复 = 没答上来，必须叫人（不能当 continue 放过）', async () => {
  const sup = stubSupervisor({ verdict: 'decide', confidence: 0.95, reason: '问了个实质问题', reply: '' });
  const j = await sup.judge(runOk());
  assert(j.needsHuman, `应叫人，实际 ${j.verdict}`);
  assert(j.reason.includes('未给出答复内容'), `理由要点明: ${j.reason}`);
  // 它确实问了个实质问题，只是答案没拿到 —— 当成 continue 会让问题被无视
  assert(!j.shouldContinue, '绝不能降级成 continue');
});

test('needs_human：原样传出需要人做什么', async () => {
  const sup = stubSupervisor({
    verdict: 'needs_human', confidence: 1.0,
    reason: '要动生产数据库', needs_from_human: '请确认是否允许改生产库',
  });
  const j = await sup.judge(runOk());
  assert(j.needsHuman && j.needsFromHuman.includes('生产库'));
});

// ── 容错：拿不准就停机，绝不猜判定 ──────────────────────────
test('LLM 不可用时叫人，不猜判定', async () => {
  const sup = stubSupervisor({}, { throwError: '连接超时' });
  const j = await sup.judge(runOk());
  assert(j.needsHuman, '应叫人');
  assert(j.reason.includes('监督者不可用'), `理由要点明: ${j.reason}`);
  // 拿不到判断 ≠ 判断为继续；降级判定的置信度是 0（原版 _fallback），不是 1
  assert(j.confidence === 0, `降级判定置信度应为 0，实际 ${j.confidence}`);
});

test('回复被 max_tokens 截断时给出可操作的提示', async () => {
  const sup = stubSupervisor('{"verdict":"cont', { stopReason: 'max_tokens' });
  const j = await sup.judge(runOk());
  assert(j.needsHuman, '应叫人');
  assert(j.reason.includes('max_tokens'), `要指出是截断而非格式错: ${j.reason}`);
  assert(j.needsFromHuman.includes('调高'), '要告诉人怎么修');
});

test('未知判定值时叫人', async () => {
  const sup = stubSupervisor({ verdict: '差不多了', confidence: 0.9 });
  const j = await sup.judge(runOk());
  assert(j.needsHuman, '应叫人');
  assert(j.reason.includes('未知判定'), `理由要点明: ${j.reason}`);
});

test('置信度非法（缺失/非数字/越界）时归 0 而非崩', async () => {
  for (const bad of [undefined, 'abc', null, NaN]) {
    const sup = stubSupervisor({ verdict: 'continue', confidence: bad });
    const j = await sup.judge(runOk());
    assert(j.confidence === 0, `非法置信度 ${bad} 应归 0，实际 ${j.confidence}`);
  }
  // 越界要夹到 [0,1]
  const hi = await stubSupervisor({ verdict: 'continue', confidence: 5 }).judge(runOk());
  assert(hi.confidence === 1, `超过 1 应夹到 1，实际 ${hi.confidence}`);
});

// ── JSON 抢救 ───────────────────────────────────────────────
test('JSON 抢救：围栏、前后解释文字、嵌套花括号都能救回', () => {
  const want = { verdict: 'continue', confidence: 0.9 };
  assert(extractJson(JSON.stringify(want)).verdict === 'continue', '裸 JSON');
  assert(extractJson('```json\n' + JSON.stringify(want) + '\n```').verdict === 'continue', '围栏');
  assert(extractJson('我的判断是：\n' + JSON.stringify(want) + '\n以上。').verdict === 'continue', '前后有文字');
  // 嵌套对象
  const nested = { verdict: 'decide', confidence: 0.9, reply: 'x', meta: { a: { b: 1 } } };
  assert(extractJson('说明\n' + JSON.stringify(nested)).meta.a.b === 1, '嵌套花括号');
  // 字符串里的花括号不该干扰配平
  const tricky = { verdict: 'continue', confidence: 0.9, reason: '代码里有 { 和 }' };
  assert(extractJson('前言 ' + JSON.stringify(tricky)).reason.includes('{'), '字符串内花括号');
});

test('救不回来时抛错（由调用方降级叫人，不猜）', () => {
  for (const bad of ['', '完全没有 JSON', '{ 残缺', '[1,2,3]']) {
    let threw = null;
    try { extractJson(bad); } catch (e) { threw = e; }
    assert(threw, `"${bad}" 应抛错`);
  }
});

test('破损 JSON 走抢救后仍能正常判定', async () => {
  const sup = stubSupervisor('好的，我的判定是：\n```json\n{"verdict":"continue","confidence":0.9}\n```\n完毕');
  const j = await sup.judge(runOk());
  assert(j.shouldContinue, `抢救后应正常判定，实际 ${j.verdict}`);
});

// ── 输入组装 ────────────────────────────────────────────────
test('需求文档送到监督者，标题写明只供代答、不许拿来核对完成度', async () => {
  const sup = stubSupervisor({ verdict: 'continue', confidence: 0.9 }, { requirement: '必须用 Postgres 而非 SQLite' });
  await sup.judge(runOk(), '开发中');
  const user = sup._seen[0].user;
  assert(user.includes('必须用 Postgres'), '需求文档必须进输入（代答能力的前提）');
  // tafang 实测：没写用途边界时，监督者拿需求逐项比对，把已完成的项目判成 continue
  assert(user.includes('不要用它核对项目是否做完'), '标题要写明用途边界');
  assert(user.includes('当前所处阶段: 开发中'), '阶段要送到');
});

test('没给需求文档时显式告知无代答依据', async () => {
  const sup = stubSupervisor({ verdict: 'continue', confidence: 0.9 });
  await sup.judge(runOk());
  assert(sup._seen[0].user.includes('本次未提供需求文档'), '要说出来而不是静默');
});

test('需求文档超长时截断但保留开头；执行者输出只送末尾 6000 字', async () => {
  const head = '开头有验收标准';
  const sup = stubSupervisor({ verdict: 'continue', confidence: 0.9 },
    { requirement: head + 'x'.repeat(REQUIREMENT_BUDGET + 5000) });
  await sup.judge(runOk({ finalText: '旧'.repeat(7000) + '最新一句' }));
  const user = sup._seen[0].user;
  assert(user.includes(head) && user.includes('后续截断'), '开头保留且标明截断');
  assert(user.includes('最新一句') && !user.includes('旧'.repeat(6001)), '输出只送末尾 6000 字（尾部是最新一轮）');
});

test('现场含退出原因、stop_reason、遗留 agent 名字与两段指引，不注入记忆全文', async () => {
  const sup = stubSupervisor({ verdict: 'continue', confidence: 0.9 });
  await sup.judge(runOk({
    exitReason: ExitReason.HANG_KILLED, stopReason: 'tool_use', error: '静默 300s',
    finalText: '我正在写 parser', pendingTasks: [{ task_id: 'a1', description: '子系统A' }],
  }));
  const user = sup._seen[0].user;
  for (const k of [ExitReason.HANG_KILLED, 'stop_reason: tool_use', '静默 300s', '我正在写 parser', '子系统A']) {
    assert(user.includes(k), `现场缺: ${k}`);
  }
  // diablo 实测：不告诉监督者遗留 agent，它只看到正常汇报；但也不许拿这条否决「完成」
  assert(user.includes('不要用这条去否决它说的「完成」'), '遗留任务的使用边界要写明');
  assert(!user.includes('MEMORY.md'), '不该注入记忆全文');
});

test('token 用量被累计（供预算核算）', async () => {
  const sup = stubSupervisor({ verdict: 'continue', confidence: 0.9 });
  await sup.judge(runOk());
  await sup.judge(runOk());
  assert(sup.calls === 2, `调用数应为 2，实际 ${sup.calls}`);
  assert(sup.spentTokens === 2 * 1050, `token 应累计，实际 ${sup.spentTokens}`);
});

test('decided 要求 reply 非空（空 reply 的 decide 是没答上来）', () => {
  assert(!new Judgement({ verdict: Verdict.DECIDE, reply: '' }).decided, '空 reply 不算代答成立');
  assert(new Judgement({ verdict: Verdict.DECIDE, reply: '用 SQLite' }).decided);
  const r = new Judgement({ verdict: Verdict.DECIDE, confidence: 0.9, reason: '文档写了', reply: '用 SQLite' }).render();
  assert(r.startsWith('判定: decide（置信度 0.90）') && r.includes('依据: 文档写了') && r.includes('代委托人答复: 用 SQLite'), r);
});

test('提示词：显式路径读不到硬失败；空文件与缺契约都报错；默认来源标"内置默认"', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-prompt-'));
  const expectThrow = (fn, kw) => {
    let e = null; try { fn(); } catch (x) { e = x; }
    assert(e instanceof SupervisorPromptError && e.message.includes(kw), `应抛含「${kw}」的错: ${e?.message}`);
  };
  // 人以为换了提示词而实际跑的是默认那份，是最难察觉的一类错 —— 不能静默回落
  expectThrow(() => loadSystemPrompt(path.join(dir, '不存在.txt')), '不存在');
  fs.writeFileSync(path.join(dir, 'empty.txt'), '  \n', 'utf8');
  expectThrow(() => loadSystemPrompt(path.join(dir, 'empty.txt')), '空的');
  fs.writeFileSync(path.join(dir, 'bad.txt'), '随便判断一下', 'utf8');
  expectThrow(() => loadSystemPrompt(path.join(dir, 'bad.txt')), 'verdict');
  assert(loadSystemPrompt().source === '内置默认', '默认来源文案');
  fs.rmSync(dir, { recursive: true, force: true });
});

await Promise.all(pending);
console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

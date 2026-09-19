/**
 * 供应商侧故障的自动恢复：先等，再换模型，绝不换供应商。
 *
 * 事故数据（Hitech 2026-09-18/19）摊开看，问题不是"重试不够"，而是重试方式错：
 *   · CLI 内部已指数退避重试 10 次（1s→1s→2s→4s→10s→17s→35s…约 3 分钟）
 *   · 它失败返回后我们**零等待**紧接着又发 3 发，每发再各自内部重试 3 分钟
 *   → 12 分钟全撞在同一个坏渠道（503 无可用渠道）上，然后停机等人，白花 $0.94
 *
 * 运行: node tests/test-longrun-recovery.mjs
 */

import fs from 'fs';
import { planRecovery, pickModel, WAIT_LADDER, SWITCH_MODEL_AFTER } from '../server/services/longrunRecovery.js';

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function test(name, fn) {
  try { fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}

const NO_CHANNEL = 'API Error: 503 分组 zhangzong 下模型 claude-fable-5-1 无可用渠道（distributor）';
const MODELS = ['claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5'];

test('事故现场第一次失败 → 等待，且等的不是几秒（CLI 自己已经耗了 3 分钟）', () => {
  const r = planRecovery({ error: NO_CHANNEL, providerFailures: 1, available: MODELS });
  assert(r.action === 'wait', `应先等待，实际 ${r.action}`);
  assert(r.waitMs >= 60_000, `只等了 ${r.waitMs}ms —— 对"渠道掉了"这种故障，几秒的等待只是把钱烧得更快`);
  assert(/无可用渠道|渠道/.test(r.reason), r.reason);
});

test('等待间隔递增，不会一直用同一个短间隔死磕', () => {
  const waits = [1, 2, 3, 4, 5, 6].map((n) => planRecovery({ error: NO_CHANNEL, providerFailures: n, available: [] }).waitMs);
  const nonZero = waits.filter((w) => w > 0);
  for (let i = 1; i < nonZero.length; i += 1) {
    assert(nonZero[i] >= nonZero[i - 1], `第 ${i + 1} 档 ${nonZero[i]}ms 比前一档 ${nonZero[i - 1]}ms 还短`);
  }
  assert(WAIT_LADDER[WAIT_LADDER.length - 1] >= 300_000, '最后一档太短，扛不过稍长的供应商故障');
  const total = WAIT_LADDER.reduce((a, b) => a + b, 0);
  assert(total <= 40 * 60_000, `总等待 ${(total / 60000).toFixed(0)} 分钟太长，一次夜跑会白等一整晚`);
});

test('等过几轮仍不行 → 换同一供应商下没试过的模型', () => {
  const r = planRecovery({
    error: NO_CHANNEL, providerFailures: SWITCH_MODEL_AFTER + 1,
    triedModels: ['claude-fable-5-1'], available: MODELS,
  });
  assert(r.action === 'switch_model', `应换模型，实际 ${r.action}：${r.reason}`);
  assert(r.model && r.model !== 'claude-fable-5-1', `不能换回试过的那个：${r.model}`);
  assert(MODELS.includes(r.model), `换的模型必须来自清单，不能凭名字规律拼：${r.model}`);
  assert(/同一供应商/.test(r.reason), '要说明没换供应商：' + r.reason);
});

test('拿不到模型清单时继续等，绝不编一个模型名', () => {
  const r = planRecovery({ error: NO_CHANNEL, providerFailures: SWITCH_MODEL_AFTER + 1, available: [] });
  assert(r.action === 'wait', `没有清单就只能等，实际 ${r.action}`);
  assert(r.model === '', `编了模型名「${r.model}」—— 拼出来的名字同样会撞「无可用渠道」`);
});

test('限流只能等，不靠换模型（同池同限，换了照样被限）', () => {
  const r = planRecovery({ error: 'API Error: 429 rate limit exceeded', providerFailures: 5, available: MODELS });
  assert(r.action === 'wait', `限流应该等，实际 ${r.action}`);
  assert(r.model === '', '限流时不该换模型');
});

test('不是供应商侧故障的一律不重试 —— 等和换模型都治不了，白烧钱', () => {
  const cases = [
    ['API Error: 401 unauthorized: invalid api key', '认证'],
    ['prompt is too long: 250000 tokens > 200000 maximum', '上下文'],
    ['panic: runtime error: index out of range', '代码'],
    ['spawn claude ENOENT', 'CLI'],
  ];
  for (const [err, label] of cases) {
    const r = planRecovery({ error: err, providerFailures: 1, available: MODELS });
    assert(r.action === 'stop', `${label}类错误不该自动重试，实际 ${r.action}`);
    assert(r.reason.length > 6, `${label}：要说清为什么不重试 →「${r.reason}」`);
  }
});

test('手段用尽后如实停机，并告诉人该做什么', () => {
  const r = planRecovery({
    error: NO_CHANNEL, providerFailures: WAIT_LADDER.length + 3,
    triedModels: MODELS, available: MODELS,
  });
  assert(r.action === 'stop', `全试过了应停机，实际 ${r.action}`);
  assert(/试过全部可用模型|未恢复/.test(r.reason), r.reason);
  assert(/换.*供应商|等/.test(r.reason), '要给下一步建议：' + r.reason);
});

test('挑模型：按清单顺序挑第一个没试过的，全试过给空', () => {
  assert(pickModel(MODELS, []) === 'claude-opus-5');
  assert(pickModel(MODELS, ['claude-opus-5']) === 'claude-fable-5-1');
  assert(pickModel(MODELS, MODELS) === '', '全试过必须给空，不能循环回第一个无限重试');
  assert(pickModel([], []) === '' && pickModel(null, null) === '', '空值不炸');
});

// ── 源码守卫 ──────────────────────────────────────────────────────
const LOOP = fs.readFileSync(new URL('../server/services/LongRunLoop.js', import.meta.url), 'utf8');
const REC = fs.readFileSync(new URL('../server/services/longrunRecovery.js', import.meta.url), 'utf8');

test('守卫：绝不自动换供应商（会把代码发往另一家、费用记在那边，且发生在无人值守时）', () => {
  assert(!/switch_provider|providerId\s*=/.test(REC), '恢复策略里出现了换供应商的动作');
  const at = LOOP.indexOf('planRecovery({');
  const seg = LOOP.slice(at, at + 1200);
  assert(!/applySessionProvider|providerId\s*=/.test(seg), '自救分支里改了供应商：' + seg.slice(0, 120));
});

test('守卫：没有错误正文时不介入，走原版重试路径（否则 38 个 parity 场景会红）', () => {
  const at = LOOP.indexOf('planRecovery({');
  const head = LOOP.slice(Math.max(0, at - 700), at);
  assert(/last\.error\s*\n?\s*\?/.test(head) || /last\.error\s*\?/.test(head),
    '没有"有正文才自救"的判断 —— 拿不到正文时介入会改变原版行为');
});

test('守卫：等待期间要能被终止，且自救记录会进收工报告', () => {
  const at = LOOP.indexOf('planRecovery({');
  const seg = LOOP.slice(at, at + 1400);
  assert(/_checkAborted\(\)/.test(seg), '等待后没查终止 —— 人点了终止还要等满 10 分钟');
  assert(/this\.recoveries\.push/.test(seg), '自救没记账，人看不到这一轮中途等过/换过');
  assert(/recoveries/.test(LOOP.slice(LOOP.indexOf('_failureBrief()'))), '自救记录没进 outcome');
});

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

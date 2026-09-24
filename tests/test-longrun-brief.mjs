/**
 * 手机用的长程精简快照。
 *
 * 由来：手机上看不到也答不了长程的提问，而长程本来就是你不在电脑前时跑的。
 * 整份看板给手机太大（实测 ERP 那轮 435 KB、小项目 jsonfmt2 也有 94 KB），
 * 精简后 1.6~2.9 KB。
 *
 * 运行: node tests/test-longrun-brief.mjs
 */

import fs from 'fs';
import { longRunBrief, RECENT_N, BODY_MAX, QUESTION_MAX } from '../server/services/longrunBrief.js';

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function test(name, fn) {
  try { fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}

const entry = (i, stream = 'main') => ({ id: i, at: 1000 + i, role: 'executor', label: `第${i}步`, head: `h${i}`, body: `b${i}`, stream });
const NH = { needs: '部署用哪家云', reason: '需求没写', question: '1. 阿里云\n2. 腾讯云\n选哪个？' };
const board = (o = {}) => ({
  title: 'demo', legs: 5, handoffs: 1, decisions: 2, spent_usd: 3.21, running_cost: 0.4,
  context: { occupied: 120000, peak: 150000, limit: 350000 }, current_label: '继续完成项目',
  elapsed_s: 3600, timeline: [], need_human: null, finished: null, ...o,
});

test('在等你时带上问题原文 —— 这是手机上唯一的判断依据', () => {
  const b = longRunBrief({ id: 't1', state: 'running', awaitingHuman: true }, board({ need_human: NH }));
  assert(b.awaitingHuman === true, '在等你没标出来');
  assert(b.needHuman?.question.includes('阿里云'), '问题原文丢了 —— 手机上只看到"在等你"却不知道等什么');
  assert(b.needHuman.needs === '部署用哪家云' && b.needHuman.reason === '需求没写', JSON.stringify(b.needHuman));
});

test('没在等时不给问题（广播与看板有时序差，免得手机上出现一个已答过的问题）', () => {
  const b = longRunBrief({ id: 't1', state: 'running', awaitingHuman: false }, board({ need_human: NH }));
  assert(b.needHuman === null, '已经答过的问题又冒出来，人会再答一遍');
});

test('最近进展只取主时间线、最多 N 条、按时间顺序（最近的在后）', () => {
  const tl = [...Array.from({ length: 15 }, (_, i) => entry(i)), entry(99, 'trace')];
  const b = longRunBrief({ id: 't', state: 'running' }, board({ timeline: tl }));
  assert(b.recent.length === RECENT_N, `条数 ${b.recent.length}`);
  assert(b.recent.every((e) => e.label !== '第99步'), '过程明细（trace）混进来了，手机上一屏全是工具调用');
  assert(b.recent[0].label === '第5步' && b.recent[RECENT_N - 1].label === '第14步', '顺序或截取错了');
});

test('长正文与超长问题都截断，快照不会被一条撑大', () => {
  const long = 'x'.repeat(10000);
  const b = longRunBrief({ id: 't', state: 'running', awaitingHuman: true },
    board({ timeline: [{ ...entry(1), body: long }], need_human: { ...NH, question: long } }));
  assert(b.recent[0].body.length <= BODY_MAX + 1, `正文没截：${b.recent[0].body.length}`);
  assert(b.needHuman.question.length <= QUESTION_MAX + 1, `问题没截：${b.needHuman.question.length}`);
  assert(JSON.stringify(b).length < 8 * 1024, `快照 ${JSON.stringify(b).length} 字节，太大`);
});

test('数字都带上：发数、代答次数、已结算与进行中花费分开、水位', () => {
  const b = longRunBrief({ id: 't', state: 'running' }, board());
  assert(b.legs === 5 && b.handoffs === 1, JSON.stringify(b));
  assert(b.decisions === 2, '代答次数要看得见 —— 那是"有 N 个决定不是你做的"');
  assert(b.spentUsd === 3.21 && b.runningCost === 0.4, '已结算与进行中要分开，合成一个数会低估');
  assert(b.context.peak === 150000 && b.context.limit === 350000, JSON.stringify(b.context));
});

test('收工后带上结论材料，交给共享的 longrunAdvice 渲染（与电脑同一套说法）', () => {
  const report = { stop: 'project_done', legs: 5, cost_usd: 3.21, elapsed_s: 3600 };
  const b = longRunBrief({ id: 't', state: 'done', report, outcome: { commit: 'abc1234' } }, board({ finished: report }));
  assert(b.state === 'done' && b.report?.stop === 'project_done' && b.outcome?.commit === 'abc1234', JSON.stringify(b));
});

test('看板缺失（服务重启后）与空参数都不炸', () => {
  const b = longRunBrief({ id: 't', state: 'running', awaitingHuman: true }, null);
  assert(b.recent.length === 0 && b.needHuman === null && b.legs === 0, JSON.stringify(b));
  const e = longRunBrief(null, null);
  assert(e.state === 'unknown' && Array.isArray(e.recent), JSON.stringify(e));
});

// ── 接线守卫 ──────────────────────────────────────────────────────
const IDX = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
const SVC = fs.readFileSync(new URL('../server/services/LongRunService.js', import.meta.url), 'utf8');

test('守卫：socket 接口在，且服务层用 longRunBrief 而不是把整份看板发出去', () => {
  assert(/socket\.on\('longrun:brief'/.test(IDX), '缺 longrun:brief 接口');
  const at = SVC.indexOf('  brief(taskId) {');
  assert(at > 0, '服务层缺 brief()');
  assert(/longRunBrief\(task\.toJSON\(\), task\.board\.snapshot\(\)\)/.test(SVC.slice(at, at + 300)),
    'brief() 没经过精简 —— 直接发看板给手机会是几百 KB');
});

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

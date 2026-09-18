/**
 * 长程收工的结论与建议 —— 回归测试
 *
 * 为什么要逐条测：原来跑完只显示一句英文停机码（project_done / needs_human …），
 * 人看不出结束、更不知道接着该干什么。六种停机原因里有四种是"没跑完"，
 * 恰恰最需要告诉人现在做什么 —— 少一种就是一次"界面上没交代"。
 *
 * 运行: node tests/test-longrun-advice.mjs
 */

import { longRunAdvice, outcomeLine, suggestBudget } from '../src/components/longrun/longrunAdvice.js';
import { Stop } from '../server/services/LongRunLoop.js';

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function test(name, fn) {
  try { fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}
const rep = (o) => ({ stop: 'project_done', legs: 3, elapsed_s: 4320, cost_usd: 1.5388, handoffs: 0, maintenances: 0, decisions: 0, ...o });

test('六种停机原因都有结论、一句话总结和明确的下一步，且都给得出动作', () => {
  for (const stop of Object.values(Stop)) {
    const a = longRunAdvice(rep({ stop, needs_from_human: '部署用哪个云厂商' }));
    assert(a && a.title && a.summary && a.next, `${stop} 缺文案: ${JSON.stringify(a)}`);
    assert(a.actions.length >= 1 && a.actions.every((x) => x.label && x.hint), `${stop} 缺动作`);
    assert(!/undefined|NaN|\[object/.test(JSON.stringify(a)), `${stop} 文案里混进了未定义值: ${JSON.stringify(a)}`);
    assert(!a.title.includes(stop), `${stop} 的标题直接把英文停机码甩给用户了：${a.title}`);
  }
});

test('等人停机：把「它要你提供什么」原样放进结论，并说清答案要写到哪', () => {
  const a = longRunAdvice(rep({ stop: 'needs_human', needs_from_human: '部署用哪个云厂商的账号' }));
  assert(a.summary.includes('部署用哪个云厂商的账号'), a.summary);
  assert(/续跑长程/.test(a.next) && /转为终端/.test(a.next), '要说清两条路：' + a.next);
  const blank = longRunAdvice(rep({ stop: 'needs_human', needs_from_human: '' }));
  assert(blank.summary && !blank.summary.includes('undefined'), '没给需求时也不能露馅：' + blank.summary);
});

test('预算停机：给出按已花 1.5 倍算的建议预算，且严格大于已花', () => {
  const a = longRunAdvice(rep({ stop: 'budget', cost_usd: 4.51 }));
  assert(a.next.includes('$7'), `4.51 × 1.5 = 6.77 → 建议 $7：${a.next}`);
  assert(suggestBudget(4.51) === 7 && suggestBudget(0.2) === 2 && suggestBudget(10) === 15, String(suggestBudget(0.2)));
  assert(suggestBudget(3) > 3, '建议值必须严格大于已花，否则续跑立刻又停');
});

test('异常停机：劝人先看再跑，并给出日志位置（直接续跑多半再撞同一个坑）', () => {
  const a = longRunAdvice(rep({ stop: 'error', needs_from_human: 'ECONNRESET' }));
  assert(a.tone === 'bad' && a.summary.includes('ECONNRESET'), JSON.stringify(a));
  assert(/loop\.log/.test(a.next) && /别直接续跑/.test(a.next), a.next);
});

test('事实行只列真有的：交接/维护/代答为 0 时不占位，非 0 时必须出现', () => {
  const plain = longRunAdvice(rep({}));
  const keys = plain.facts.map(([k]) => k);
  assert(keys.join() === '耗时,调用执行者,花费', keys.join());
  const rich = longRunAdvice(rep({ handoffs: 2, maintenances: 1, decisions: 3 }));
  const richKeys = rich.facts.map(([k]) => k);
  assert(richKeys.includes('上下文交接') && richKeys.includes('记忆维护'), richKeys.join());
  assert(richKeys.includes('监督者代你作答'), '代答次数必须单独列出：那是有 N 个决定不是人做的');
  assert(rich.facts.find(([k]) => k === '耗时')[1] === '1h12m', JSON.stringify(rich.facts));
});

test('没有报告就不给结论（宁可不显示，也不显示编出来的）；board.finished 可兜底', () => {
  assert(longRunAdvice(null, {}) === null);
  const fromBoard = longRunAdvice(null, { finished: { stop: 'project_done', legs: 2, cost_usd: 0.5, elapsed_s: 60 } });
  assert(fromBoard.title.includes('项目已完成') && fromBoard.facts.length === 3, JSON.stringify(fromBoard));
});

test('成果摘要：有改动列文件与增删行，没改动如实说，拿不到就整行不显示', () => {
  assert(outcomeLine(null) === '', '拿不到统计时不能显示这一行');
  const line = outcomeLine({ commit: 'abc1234', fileCount: 7, files: ['a.py', 'b.py'], insertions: 120, deletions: 5, memoryCount: 3 });
  assert(line.includes('改动 7 个文件') && line.includes('+120/−5') && line.includes('a.py、b.py') && line.includes('等'), line);
  assert(line.includes('记忆 3 个文件'), line);
  assert(outcomeLine({ commit: 'abc', fileCount: 0 }).includes('没有文件改动'), '没改动要如实说，不能留白让人以为丢了');
});

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

/**
 * 长程停机要给出**能据以行动**的原因。
 *
 * 事故（Hitech 2026-09-18）：四发全失败停机，界面只说「最后的错误：连续 3 次进程异常」，
 * loop.log 里也只有四行 `error`。真因一直躺在 .run/events/*.jsonl 里：
 *   API Error: 503 分组 zhangzong 下模型 claude-fable-5-1 无可用渠道（distributor）
 * 那是供应商没有该模型的渠道，该做的是换模型/换供应商；而界面却建议
 * 「先转为终端手工跑一下看报什么错」—— 手工跑必然再撞同一个 503，纯浪费。
 *
 * 两个根因：① CLI 把 API 错误写进 result 事件而非 stderr，而我们只读 stderr；
 *           ② 停机原因与每发日志都没带错误正文。
 *
 * 运行: node tests/test-longrun-error-brief.mjs
 */

import fs from 'fs';
import { briefLine, classifyError } from '../server/services/longrunErrorBrief.js';
import { errorDetail } from '../server/services/LongRunRunner.js';
import { longRunAdvice } from '../src/components/longrun/longrunAdvice.js';

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function test(name, fn) {
  try { fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}

// 事故现场 result 事件（照 .run/events 里的原文节选）
const REAL_EV = {
  type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error',
  result: 'API Error: 503 分组 zhangzong 下模型 claude-fable-5-1 无可用渠道（distributor） '
    + '(request id: 20260918234334320076521KzZeKCH3). This is a server-side issue, usually temporary — try again in a moment.',
};

test('错误正文要从 result 事件里取 —— stderr 是空的（事故的根因之一）', () => {
  assert(errorDetail(REAL_EV, '') .includes('无可用渠道'), '只读 stderr 会拿到空串，停机原因就只剩「连续 3 次进程异常」');
  assert(errorDetail({ is_error: true, result: '' }, 'spawn claude ENOENT').includes('ENOENT'), 'stderr 仍要作兜底');
  assert(errorDetail(null, '') === '', '都没有时给空串，不编');
});

test('正常完成时 result 字段是成果文本，不能当错误报出去', () => {
  const ok = { type: 'result', is_error: false, terminal_reason: 'completed', result: '已完成登录页改造，三个用例通过。' };
  assert(errorDetail(ok, '') === '', `把成果当错误报了：${errorDetail(ok, '')}`);
});

test('供应商没渠道 → 归类为 provider，建议换模型而不是「转终端手工跑」', () => {
  const c = classifyError(REAL_EV.result);
  assert(c.kind === 'provider_no_channel', c.kind);
  assert(c.actionable === 'provider', '归到 project 就会劝人手工跑，而手工跑必然再撞同一个 503');
  assert(/换.*模型|换供应商/.test(c.advice), c.advice);
  assert(c.detail.includes('claude-fable-5-1'), '模型名要留着 —— 人靠它决定换成哪个');
});

test('其余几类供应商侧错误都要认出来，别一律劝人手工跑', () => {
  const cases = [
    ['API Error: 429 rate limit exceeded', 'rate_limit'],
    ['API Error: 401 unauthorized: invalid api key', 'auth'],
    ['fetch failed: ENOTFOUND api.example.com', 'network'],
    ['API Error: 502 Bad Gateway', 'provider_overloaded'],
    ['prompt is too long: 250000 tokens > 200000 maximum', 'context_overflow'],
  ];
  for (const [text, kind] of cases) {
    const c = classifyError(text);
    assert(c.kind === kind, `「${text.slice(0, 30)}」归成了 ${c.kind}，应为 ${kind}`);
    assert(c.actionable === 'provider', `${kind} 应归 provider`);
    assert(c.advice.length > 6, `${kind} 的建议太空：${c.advice}`);
  }
});

test('认不出来的错误才建议转终端手工跑（那时确实该人去看）', () => {
  const c = classifyError('panic: runtime error: index out of range [3] with length 2');
  assert(c.kind === 'unknown' && c.actionable === 'project', JSON.stringify(c));
  assert(/转为终端/.test(c.advice), c.advice);
});

test('完全没有错误正文时如实说，不假装知道原因', () => {
  const c = classifyError('');
  assert(c.detail === '', '没正文就别编');
  assert(/没给出错误正文/.test(c.label), c.label);
  assert(/events/.test(c.advice), '要指到能自己查的地方：' + c.advice);
});

test('摘要单行化并截断，长 API 错误不撑破面板一行', () => {
  assert(briefLine('a\n\nb   c') === 'a b c', briefLine('a\n\nb   c'));
  const long = briefLine('x'.repeat(400));
  assert(long.length <= 161 && long.endsWith('…'), `长度 ${long.length}`);
  assert(briefLine(null) === '' && briefLine(undefined) === '', '空值不炸');
});

test('结论卡：带归类时标题说清是什么错，建议不再劝人手工跑', () => {
  const report = {
    stop: 'error', legs: 4, elapsed_s: 735, cost_usd: 0.9404,
    needs_from_human: '连续 3 次进程异常：API Error: 503 …无可用渠道',
    outcome: { commit: '1d03cbe', fileCount: 0, failure: classifyError(REAL_EV.result) },
  };
  const a = longRunAdvice(report);
  assert(a.title.includes('供应商没有这个模型的渠道'), a.title);
  assert(a.summary.includes('claude-fable-5-1'), '原话要摆在面上：' + a.summary);
  assert(!/转为终端.*手工跑/.test(a.next), '供应商侧错误不该再劝人手工跑：' + a.next);
  assert(/换/.test(a.next), a.next);
  assert(a.tone === 'bad', a.tone);
});

test('结论卡：没有归类时退回原来的说法（不能因为缺字段就空着）', () => {
  const a = longRunAdvice({ stop: 'error', legs: 4, elapsed_s: 735, cost_usd: 0.94, needs_from_human: '连续 3 次进程异常' });
  assert(a.title.includes('连续异常'), a.title);
  assert(a.summary.includes('连续 3 次进程异常'), a.summary);
  assert(a.next.length > 10, a.next);
});

// ── 源码守卫：这三条断了不会有别的测试红，但人又会拿不到原因 ─────────────
const LOOP = fs.readFileSync(new URL('../server/services/LongRunLoop.js', import.meta.url), 'utf8');
const RUNNER = fs.readFileSync(new URL('../server/services/LongRunRunner.js', import.meta.url), 'utf8');

test('守卫：停机原因必须带错误正文', () => {
  const at = LOOP.indexOf('consecutiveErrors >= 3');
  assert(at > 0, '没找到连续异常分支，守卫失效了');
  // 只看这一分支到 return 结束的那一段，别让文件别处的同名调用把守卫糊过去
  const seg = LOOP.slice(at, LOOP.indexOf('this.log(`  进程异常', at));
  assert(/Stop\.ERROR/.test(seg), '守卫锚点漂了：' + seg.slice(0, 100));
  assert(/briefLine\(last\.error\)/.test(seg), '停机原因又不带错误正文了，人只能去翻 events：' + seg.slice(-140));
});

test('守卫：每发结果都要把错误正文落进 loop.log', () => {
  assert(/if \(result\.error\) this\.log\(/.test(LOOP),
    'loop.log 每发不落错误正文，「编排日志在 .run/loop.log」这句提示就是空话（事故时那里只有四行 error）');
});

test('守卫：_assemble 的 error 字段必须走 errorDetail，不能只读 stderr', () => {
  // 纯函数测过了不等于接上了：事故原状就是 errorDetail 不存在、这里只有 stderr.slice，
  // CLI 把 API 错误写进 result 事件，于是字段恒为空串。
  const at = RUNNER.indexOf('error: reason === ExitReason.ERROR');
  assert(at > 0, '没找到 error 字段赋值');
  assert(/errorDetail\(ev, stderr\)/.test(RUNNER.slice(at, at + 200)),
    '又退回只读 stderr 了 —— API 错误不在 stderr 里，字段会恒空：' + RUNNER.slice(at, at + 120));
});

test('守卫：collectOutcome 的两个 return 都要带 failure 归类', () => {
  const at = LOOP.indexOf('collectOutcome(stop)');
  assert(at > 0, '没找到 collectOutcome');
  const body = LOOP.slice(at, LOOP.indexOf('_failureBrief() {', at));
  // 两条返回路径：有 startCommit 的正常路径，和没有时的早退路径。漏掉任一条，
  // 那种停机的结论卡就拿不到归类，又会去劝人「转终端手工跑」。
  const hits = body.split('this._failureBrief()').length - 1;
  assert(hits === 2, `collectOutcome 里只有 ${hits} 处带归类，应为 2 处（正常路径 + 无 startCommit 的早退）`);
  assert(/classifyError\(raw\)/.test(LOOP), '归类没算，结论卡只能退回默认建议');
});

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

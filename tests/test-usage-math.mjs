/**
 * 会话用量：纯算术与扫描 —— 回归测试
 *
 * 每条都对着一个实测踩过的坑：
 *   · 同一条 assistant 消息写成多行、每行都带同一份 usage：不去重折算虚高 53%（实测 2100 行里 752 组重复）
 *   · 每条消息的 usage 是当轮上下文占用，不能当增量累加
 *   · 价格表四列是 TEXT；`claude-opus-5[1m]` 表里没有，要归一到 claude-opus-5
 *   · 日期必须按本地日切分（UTC 日会让"今天"从早上 8 点开始）
 *
 * 运行: node tests/test-usage-math.mjs
 */

import { normalizeModelId, priceUsage, codexBillable, diffCumulative, localDayKey, MAX_STEP_USD } from '../server/services/usage/costMath.js';
import { scanChunk, pickUsage, sliceBalanced, SEEN_CAP } from '../server/services/usage/transcriptScan.js';
import { decideBinding, siblingsOf, isSupportedCli } from '../server/services/usage/UsageAttribution.js';

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function test(name, fn) {
  try { fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}
const KNOWN = ['claude-opus-5', 'claude-sonnet-5', 'gpt-5.6-sol'];
const line = (o) => JSON.stringify(o);
const assistant = (id, model, u) => line({ type: 'assistant', requestId: `req_${id}`, message: { id, model, usage: u } });
const U = (input, output, cacheRead = 0, cacheWrite = 0) => ({ input_tokens: input, output_tokens: output,
  cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite });

test('模型名归一化：带上下文档位/日期后缀的都能落到价格表里的条目', () => {
  assert(normalizeModelId('claude-opus-5', KNOWN) === 'claude-opus-5');
  assert(normalizeModelId('claude-opus-5[1m]', KNOWN) === 'claude-opus-5', '1m 档位表里没有，要归一');
  assert(normalizeModelId('claude-sonnet-5-20260115', KNOWN) === 'claude-sonnet-5');
  assert(normalizeModelId('gpt-5.6-sol-preview', KNOWN) === 'gpt-5.6-sol', '最长前缀兜底');
  assert(normalizeModelId('gemini-3-pro', KNOWN) === '', '认不出就返回空，让调用方标不完整');
});

test('查不到价格返回 null —— 绝不按 0 计价（$0 会被读成"没花钱"）', () => {
  assert(priceUsage({ input: 100 }, null) === null);
  const usd = priceUsage({ input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 }, { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 });
  assert(Math.abs(usd - 36.75) < 1e-9, String(usd));
  assert(priceUsage({ input: 1e6 }, { in: '5' }) === 5, '价格列在库里是 TEXT，要能吃字符串');
});

test('Codex 折算：cached 与 cache_write 是 input 的子集、reasoning 已含在 output 里，都不叠加', () => {
  const b = codexBillable({ input_tokens: 196923839, cached_input_tokens: 167506307, cache_write_input_tokens: 0,
    output_tokens: 797570, reasoning_output_tokens: 104504, total_tokens: 197721409 });
  assert(b.input === 29417532 && b.cacheRead === 167506307 && b.output === 797570, JSON.stringify(b));
  assert(b.input + b.cacheRead + b.cacheWrite === 196923839, '拆出来的三份要正好等于累计输入');
  assert(codexBillable({ input_tokens: 10, cached_input_tokens: 99 }).input === 0, '缓存大于输入时不得出负数');
});

test('累计值 → 增量：五种异常一律不产生负数，改为重新定基线', () => {
  const base = { inode: '1', fileSize: 100, cumUsd: 10 };
  assert(diffCumulative(null, base).rebase === true, '首次见只定基线');
  assert(diffCumulative(base, { inode: '1', fileSize: 200, cumUsd: 12 }).delta === 2);
  assert(diffCumulative(base, { inode: '2', fileSize: 200, cumUsd: 99 }).delta === 0, '文件被删后重建');
  assert(diffCumulative(base, { inode: '1', fileSize: 50, cumUsd: 3 }).delta === 0, '被截断');
  assert(diffCumulative(base, { inode: '1', fileSize: 200, cumUsd: 4 }).delta === 0, '累计回退（/clear）');
  const big = diffCumulative(base, { inode: '1', fileSize: 200, cumUsd: 10 + MAX_STEP_USD * 3 });
  assert(big.delta === MAX_STEP_USD && big.rebase, '一轮涨几千刀必是 bug，钳住并重定基线');
});

test('日期按本地日切分；时钟回拨不回填历史', () => {
  const ts = new Date(2026, 8, 18, 0, 30).getTime();   // 本地 09-18 00:30
  assert(localDayKey(ts) === '2026-09-18', localDayKey(ts));
  assert(localDayKey(new Date(2026, 8, 17, 23, 59).getTime()) === '2026-09-17', '跨本地午夜分两桶');
  assert(localDayKey(ts, '2026-09-19') === '2026-09-19', '时钟回拨时写进已记过的那天，不回填历史');
});

test('扫描：同一条消息的多行只计一次（不去重实测虚高 53%）', () => {
  const text = [assistant('msg_1', 'claude-opus-5', U(10, 5, 1000)),
    assistant('msg_1', 'claude-opus-5', U(10, 5, 1000)),   // 同一条消息的第二行（思考/工具调用）
    assistant('msg_2', 'claude-opus-5', U(20, 7, 2000))].join('\n') + '\n';
  const s = scanChunk(text, {}, 0);
  assert(s.byModel['claude-opus-5'].input === 30, JSON.stringify(s.byModel));
  assert(s.byModel['claude-opus-5'].cacheRead === 3000, '缓存读同样只能计一次');
});

test('扫描：遇到锚点清空折算累计（锚点是 CLI 的权威账，漂移不累积）', () => {
  const text = [assistant('msg_1', 'claude-opus-5', U(10, 5)),
    line({ type: 'cost-state', totalCostUSD: 150.55, sessionId: 'x' }),
    assistant('msg_2', 'claude-opus-5', U(20, 7))].join('\n') + '\n';
  const s = scanChunk(text, {}, 0);
  assert(s.anchor?.totalCostUSD === 150.55 && s.anchorAt >= 0);
  assert(s.byModel['claude-opus-5'].input === 20, '锚点之前的折算要作废');
});

test('扫描：跨块的半行留到下一块拼接，不丢不重', () => {
  const text = assistant('msg_1', 'claude-opus-5', U(10, 5)) + '\n' + assistant('msg_2', 'claude-opus-5', U(20, 7)) + '\n';
  const cut = Math.floor(text.length * 0.6);
  let s = scanChunk(text.slice(0, cut), {}, 0);
  s = scanChunk(text.slice(cut), s, cut);
  assert(s.byModel['claude-opus-5'].input === 30, JSON.stringify(s.byModel));
  assert(SEEN_CAP >= 100, '去重窗口太小会让长会话重复计');
});

test('扫描：只截 usage 那一小段，字符串里的花括号不干扰（巨行不整行解析）', () => {
  const huge = line({ type: 'user', message: { content: 'x'.repeat(5000) + '{"fake":"{"}' } });
  assert(pickUsage(huge) === null, '没有 usage 的巨行直接跳过');
  const s = sliceBalanced('{"a":"}{","b":{"c":1}}', 0);
  assert(s === '{"a":"}{","b":{"c":1}}', s);
});

test('归属：hook 给了会话 id 就精确认领；同目录同类型多会话判归属不明；Grok 不支持', () => {
  const claude = { id: 's1', aiType: 'claude', workingDir: '/p', claudeSessionId: 'abc', claudeTranscriptPath: '/t.jsonl' };
  const b = decideBinding(claude, []);
  assert(b.kind === 'bound' && b.runKey === 'abc' && b.source === 'hook', JSON.stringify(b));
  const noHook = { id: 's2', aiType: 'codex', workingDir: '/p' };
  assert(decideBinding(noHook, []).kind === 'exclusive', '同目录只有自己 → 可按目录认领');
  const amb = decideBinding(noHook, [{ id: 's3' }]);
  assert(amb.kind === 'ambiguous' && /无法区分/.test(amb.reason), JSON.stringify(amb));
  assert(decideBinding({ id: 's4', aiType: 'grok' }, []).kind === 'unsupported' && !isSupportedCli('grok'));
  const all = [{ id: 's1', status: 'running', aiType: 'claude', workingDir: '/p' },
    { id: 's9', status: 'running', aiType: 'claude', workingDir: '/p' },
    { id: 's8', status: 'running', aiType: 'codex', workingDir: '/p' },
    { id: 's7', status: 'closed', aiType: 'claude', workingDir: '/p' }];
  assert(siblingsOf(all[0], all).map((s) => s.id).join() === 's9', '只算同目录、同 CLI、仍在跑的');
});

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

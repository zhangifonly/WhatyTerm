/**
 * 自动价格（LiteLLM）：新模型不用人工补价；CC Switch 仍优先；拉取失败不丢价。
 *
 * 由来（2026-09-24）：用户问"以后有新模型能否自动"。实测 LiteLLM 有 CC Switch 缺的 claude-opus-5-5（$4/$20）
 * 与 gpt-6-sol（$2/$10），与 OpenRouter 独立报价一致；共有的 59 个模型 55 个一致。
 *
 * 运行: node tests/test-auto-pricing.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseLiteLLM, AutoPricing, SOURCES, REFRESH_MS } from '../server/services/usage/AutoPricing.js';
import { resolvePrice, priceConflict } from '../server/services/usage/priceResolve.js';
import { PricingTable } from '../server/services/usage/PricingTable.js';

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
const queue = [];
const test = (name, fn) => queue.push([name, fn]);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprice_'));
const quiet = { log() {}, warn() {} };

/** 造一份像样的 LiteLLM 原始 JSON（每 token 单价），n 条凑数 + 指定条目 */
function rawTable(extra = {}, n = 400) {
  const raw = { sample_spec: { input_cost_per_token: 0, output_cost_per_token: 0 } };
  for (let i = 0; i < n; i++) raw[`filler-${i}`] = { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 };
  return { ...raw, ...extra };
}
const P = (i, o, cr = 0, cw = 0) => ({ input_cost_per_token: i / 1e6, output_cost_per_token: o / 1e6,
  cache_read_input_token_cost: cr / 1e6, cache_creation_input_token_cost: cw / 1e6 });

test('解析：换算成每百万美元并去掉浮点尾巴；平台前缀条目、单位错的、缺价的都不收', () => {
  const p = parseLiteLLM({ 'claude-opus-5-5': P(4, 20, 0.2, 5), 'bedrock/claude-opus-5-5': P(9, 9),
    'weird': { input_cost_per_token: 5, output_cost_per_token: 25 }, 'no-price': { max_tokens: 1 }, sample_spec: P(1, 1) });
  assert(JSON.stringify(p) === JSON.stringify({ 'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.2, cacheWrite: 5 } }), JSON.stringify(p));
});

/** 假 fetch：按 URL 给结果 */
const fetcherOf = (plan, calls = []) => async (url) => {
  calls.push(url);
  const r = plan[url];
  if (r instanceof Error) throw r;
  return { ok: r.status === 200, status: r.status, json: async () => r.body };
};

test('拉取：首选源失败自动换备用源；成功后缓存落盘，新实例启动即可用（不必等联网）', async () => {
  const dir = path.join(TMP, 'a');
  const calls = [];
  const ap = new AutoPricing({ dir, log: quiet, fetcher: fetcherOf({
    [SOURCES[0]]: Object.assign(new Error('timeout'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }),
    [SOURCES[1]]: { status: 200, body: rawTable({ 'gpt-6-sol': P(2, 10) }) } }, calls) });
  assert(await ap.refresh() === true && calls.length === 2, `应先试首选再换备用：${calls}`);
  assert(ap.prices['gpt-6-sol'].in === 2 && ap.status.ok && ap.status.source === SOURCES[1], JSON.stringify(ap.status));
  let netCalls = 0;
  const again = new AutoPricing({ dir, log: quiet, fetcher: async () => { netCalls += 1; throw new Error('不该联网'); } });
  assert(again.prices?.['gpt-6-sol']?.out === 10, '缓存没被新实例读到');
  // ⚠ 断言"没联网"要数调用次数：refresh 会吞掉 fetch 的异常，只看返回值测不出它其实去拉了
  await again.refresh({ now: again.status.fetchedAt + 1000 });
  assert(netCalls === 0, `缓存未满 24 小时不该重拉，实际联网 ${netCalls} 次`);
  await again.refresh({ now: again.status.fetchedAt + REFRESH_MS + 1 });
  assert(netCalls === SOURCES.length, '缓存满 24 小时应当重拉');
});

test('拉取全失败或拿到残缺文件：保留上次的价格，只记错误（网络问题不能让价格变成"无"）', async () => {
  const dir = path.join(TMP, 'b');
  const ok = new AutoPricing({ dir, log: quiet, fetcher: fetcherOf({ [SOURCES[0]]: { status: 200, body: rawTable({ x1: P(1, 2) }) } }) });
  await ok.refresh();
  const v = ok.version;
  ok.fetcher = fetcherOf({ [SOURCES[0]]: { status: 200, body: { only: P(1, 1) } }, [SOURCES[1]]: { status: 503, body: {} } });
  assert(await ok.refresh({ force: true }) === false, '残缺文件不该被采用');
  assert(ok.prices.x1?.in === 1 && ok.version === v && ok.status.ok, '失败后把旧价格丢了');
  assert(/疑似残缺/.test(ok.status.error) && /HTTP 503/.test(ok.status.error), ok.status.error);
  const cached = JSON.parse(fs.readFileSync(path.join(dir, 'litellm.json'), 'utf8'));
  assert(cached.prices.x1, '失败的拉取覆盖了缓存文件');
});

test('选价：CC Switch 确切命中优先；它没有的由自动表补；确切的价胜过借来的价', () => {
  const ccs = { 'claude-opus-5': { in: 5, out: 25 }, 'gpt-5.6-sol': { in: 4, out: 20 } };
  const auto = { 'claude-opus-5': { in: 9, out: 9 }, 'claude-opus-5-5': { in: 4, out: 20 }, 'gpt-5.6-sol-preview': { in: 3, out: 3 } };
  const r = (m) => resolvePrice(m, ccs, auto);
  assert(r('claude-opus-5').source === 'ccswitch' && r('claude-opus-5').price.in === 5, '两边都有时要听 CC Switch');
  assert(r('claude-opus-5-5[1m]').source === 'litellm' && r('claude-opus-5-5[1m]').price.in === 4, 'CC Switch 没有的要自动补');
  assert(r('gpt-5.6-sol-preview').source === 'litellm', '自动表有确切价时，不该拿 CC Switch 的 gpt-5.6-sol 去借');
  assert(r('gpt-5.6-sol-beta').source === 'ccswitch' && r('gpt-5.6-sol-beta').how === 'suffix', '都只能借时 CC Switch 优先');
  assert(r('gpt-7').source === '' && r('gpt-7').price === null, '两边都没有才缺价');
  assert(resolvePrice('claude-opus-5-5', null, auto).price.in === 4, '没有 CC Switch 库时自动表照样可用');
});

test('不一致：只比输入/输出价；一致或一边没有都不报', () => {
  const c = priceConflict('m', { m: { in: 1.25, out: 10, cacheWrite: 0 } }, { m: { in: 0.25, out: 2, cacheWrite: 9 } });
  assert(c && c.ccswitch.in === 1.25 && c.auto.in === 0.25, JSON.stringify(c));
  assert(priceConflict('m', { m: { in: 1, out: 2, cacheWrite: 0 } }, { m: { in: 1, out: 2, cacheWrite: 9 } }) === null, '缓存价不同不算');
  assert(priceConflict('m', { m: { in: 1, out: 2 } }, {}) === null);
});

test('价格表：自动表更新 → 版本号变（用量按新价重算）；汇总列出自动价、不一致、缺价（只含在用的）', () => {
  const auto = { prices: { 'claude-opus-5-5': { in: 4, out: 20 }, 'o3-mini': { in: 1.1, out: 4.4 }, 'unused-x': { in: 1, out: 1 } },
    version: 1, status: { ok: true, count: 3 } };
  const t = new PricingTable({ dbPath: path.join(TMP, 'none.db'), auto });
  t.prices = { 'o3-mini': { in: 0.55, out: 2.2 } }; t.loadedAt = Date.now(); t.mtime = -1;   // 模拟 CC Switch 已读入
  const v0 = t.version;
  t.get('claude-opus-5-5', 1000); t.get('o3-mini', 1000); t.get('gpt-7', 1000);
  const r = t.report(2000);
  assert(r.autoPriced.map((x) => x.model).join() === 'claude-opus-5-5', JSON.stringify(r.autoPriced));
  assert(r.conflicts.map((x) => x.model).join() === 'o3-mini', JSON.stringify(r.conflicts));
  assert(r.missing.map((x) => x.model).join() === 'gpt-7', JSON.stringify(r.missing));
  assert(!JSON.stringify(r).includes('unused-x'), '没在用的模型不该出现');
  auto.prices = { ...auto.prices, 'gpt-7': { in: 1, out: 2 } }; auto.version = 2;
  assert(t.version !== v0, '自动表更新了版本号却没变');
  assert(t.get('gpt-7').price?.out === 2 && t.report(2000).missing.length === 0, '自动表补上后仍报缺价（缓存没失效）');
});

for (const [name, fn] of queue) {
  try { await fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}
console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

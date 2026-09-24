/**
 * 模型更新后的价格表：不静默借旧价、缺价看得见、补价后自动重算。
 *
 * 由来（2026-09-24 实测）：claude-opus-5-5（3572 条记录）被最长前缀悄悄按 claude-opus-5 计价，界面不报缺价；
 * gpt-6 / gpt-6-sol 查不到时"费用不完整"只闪一分钟（文件没动的那轮标志就丢了），也不说缺的是哪个模型。
 *
 * 运行: node tests/test-pricing-missing.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { matchModelId, normalizeModelId } from '../server/services/usage/costMath.js';
import { PricingTable, MISS_TTL_MS } from '../server/services/usage/PricingTable.js';
import { UsageLedger } from '../server/services/usage/UsageLedger.js';
import { SessionUsageService, encodeCwd } from '../server/services/usage/SessionUsageService.js';

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function test(name, fn) {
  try { fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pricing_test_'));
const K = ['claude-opus-5', 'claude-opus-4-8', 'gpt-5.6-sol', 'gpt-5'];

test('新版本号 / 不同档位不借旧价：opus-5-5、gpt-5-mini、gpt-5.6 一律查不到', () => {
  for (const m of ['claude-opus-5-5', 'claude-opus-5-5[1m]', 'gpt-5-mini', 'gpt-5.6', 'claude-opus-5.5']) {
    assert(normalizeModelId(m, K) === '', `${m} 借到了 ${normalizeModelId(m, K)} 的价`);
  }
  // 点号换横线只对 claude-：gpt 的点号是正式名的一部分，gpt-5.6 与 gpt-5-6 是两个东西
  assert(normalizeModelId('gpt-5.6', ['gpt-5-6']) === '', 'gpt 的点号被换成了横线');
});

test('合法的放宽仍然有效：上下文档位、日期、预览/思考后缀、claude 的点号写法', () => {
  const cases = { 'claude-opus-5[1m]': ['claude-opus-5', 'context'], 'claude-opus-5-20260101': ['claude-opus-5', 'date'],
    'gpt-5.6-sol-preview': ['gpt-5.6-sol', 'suffix'], 'claude-opus-5-thinking': ['claude-opus-5', 'suffix'],
    'claude-opus-4.8': ['claude-opus-4-8', 'dots'], 'gpt-5.6-sol': ['gpt-5.6-sol', 'exact'] };
  for (const [m, [id, how]] of Object.entries(cases)) {
    const r = matchModelId(m, K);
    assert(r.id === id && r.how === how, `${m} → ${JSON.stringify(r)}，期望 ${id}/${how}`);
  }
});

/** 临时价格库，形状与 CC Switch 的 model_pricing 一致（价格列是 TEXT） */
function priceDb(rows) {
  const file = path.join(TMP, `p${Math.random().toString(36).slice(2)}.db`);
  const db = new Database(file);
  db.exec(`CREATE TABLE model_pricing (model_id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
    input_cost_per_million TEXT NOT NULL, output_cost_per_million TEXT NOT NULL,
    cache_read_cost_per_million TEXT NOT NULL DEFAULT '0', cache_creation_cost_per_million TEXT NOT NULL DEFAULT '0')`);
  const add = (id, i, o) => db.prepare('INSERT INTO model_pricing VALUES (?,?,?,?,?,?)').run(id, id, String(i), String(o), '0', '0');
  rows.forEach((r) => add(...r));
  db.close();
  return { file, add: (...r) => { const d = new Database(file); d.prepare('INSERT INTO model_pricing VALUES (?,?,?,?,?,?)').run(r[0], r[0], String(r[1]), String(r[2]), '0', '0'); d.close(); } };
}
/** 让下一次 load() 必定重读：过了复查间隔 + mtime 变了 */
const expire = (t, file) => { t.loadedAt = 0; const s = fs.statSync(file); fs.utimesSync(file, s.atime, new Date(s.mtimeMs + 5000)); };

test('价格表：查不到的模型记进缺价清单；<synthetic> 不记；补上后重读即清掉且版本号 +1', () => {
  const db = priceDb([['claude-opus-5', 5, 25]]);
  const t = new PricingTable({ dbPath: db.file });
  assert(t.get('claude-opus-5-5', 1000).price === null, '新版本不该有价');
  t.get('<synthetic>', 1000); t.get('gpt-6', 2000);
  const m = t.missing(3000);
  assert(m.tableFound && m.models.map((x) => x.model).join() === 'gpt-6,claude-opus-5-5', JSON.stringify(m));
  const v0 = t.version;
  db.add('claude-opus-5-5', 5, 25); expire(t, db.file);
  assert(t.get('claude-opus-5-5').price?.in === 5, '补价后没读到');
  assert(t.version === v0 + 1, '重读后版本号没变 —— 用量采集不会按新价重算');
  assert(t.missing(3000).models.map((x) => x.model).join() === 'gpt-6', '补上的没从缺价清单里清掉');
});

test('缺价清单只列最近 7 天用过的；没有价格表时明说', () => {
  const t = new PricingTable({ dbPath: priceDb([]).file });
  t.get('old-model', 0); t.get('new-model', MISS_TTL_MS + 10);
  assert(t.missing(MISS_TTL_MS + 20).models.map((x) => x.model).join() === 'new-model');
  const none = new PricingTable({ dbPath: path.join(TMP, 'nope.db') });
  assert(none.missing().tableFound === false, '找不到库要让界面说出来');
});

// ── 采集服务：缺价不闪、补价即重算、重启后仍知道缺价 ─────────────────────
const PROJECTS = path.join(TMP, 'projects');
const SESSION = { id: 's1', aiType: 'claude', workingDir: '/work/p', claudeSessionId: 'run-x', status: 'running' };
const msg = (id, model, out) => JSON.stringify({ type: 'assistant', message: { id, model,
  usage: { input_tokens: 0, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) + '\n';
/** 假价格表：可随时补价，并像真的一样带版本号 */
function livePricing() {
  const prices = { 'claude-opus-5': { in: 5, out: 25, cacheRead: 0, cacheWrite: 0 } };
  return { version: 1, prices, get(m) { const id = normalizeModelId(m, Object.keys(prices)); return { price: id ? prices[id] : null, modelId: id }; },
    addPrice(id, p) { prices[id] = p; this.version += 1; } };
}

test('缺价的会话：文件不动的轮次也持续标「不完整」并点名模型；补价后不等文件变动就按新价计入', () => {
  const dir = path.join(PROJECTS, encodeCwd(SESSION.workingDir));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'run-x.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'cost-state', totalCostUSD: 0 }) + '\n');
  const ledger = new UsageLedger({ dbPath: path.join(TMP, 'l1.db') });
  const pricing = livePricing();
  const svc = new SessionUsageService({ ledger, pricing, claudeProjectsRoot: PROJECTS });
  svc.collect(SESSION, [SESSION]);                                  // 认领
  fs.appendFileSync(file, msg('m1', 'claude-opus-5-5', 40000));    // 新模型花了 40000 输出 token
  const r1 = svc.collect(SESSION, [SESSION]);
  assert(r1.incomplete && r1.unknownModels.join() === 'claude-opus-5-5', JSON.stringify(r1));
  const r2 = svc.collect(SESSION, [SESSION]);                       // 文件没动
  assert(r2.incomplete && r2.unknownModels.join() === 'claude-opus-5-5', '文件没动的一轮把「不完整」丢了（只闪一分钟）');
  // 服务重启：新实例、同一本账、文件仍没动
  const svc2 = new SessionUsageService({ ledger, pricing, claudeProjectsRoot: PROJECTS });
  const r3 = svc2.collect(SESSION, [SESSION]);
  assert(r3.incomplete && r3.unknownModels.join() === 'claude-opus-5-5', '重启后不知道这个会话缺价了');
  pricing.addPrice('claude-opus-5-5', { in: 5, out: 25, cacheRead: 0, cacheWrite: 0 });   // 在 CC Switch 补价
  const r4 = svc2.collect(SESSION, [SESSION]);
  assert(!r4.incomplete && r4.unknownModels.length === 0, `补价后仍标不完整：${JSON.stringify(r4)}`);
  assert(Math.abs(r4.sessionUsd - 1) < 1e-6, `40000 输出 × $25/M 应补记 $1，实际 ${r4.sessionUsd}`);
});

test('零用量条目不算缺价；有用量却没标模型名的显示为「(未标模型名)」而不是空串', () => {
  const dir = path.join(PROJECTS, encodeCwd('/work/z'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'run-z.jsonl');
  // 实测 Hitech：一行有 usage 没 model、token 全 0 —— 以前被当成缺价模型 ''，列表里多出一个空名
  fs.writeFileSync(file, JSON.stringify({ type: 'cost-state', totalCostUSD: 3 }) + '\n' + msg('m0', '', 0) + msg('m1', 'claude-opus-5', 40000));
  const S = { ...SESSION, id: 'sz', workingDir: '/work/z', claudeSessionId: 'run-z' };
  const svc = new SessionUsageService({ ledger: new UsageLedger({ dbPath: path.join(TMP, 'l2.db') }), pricing: livePricing(), claudeProjectsRoot: PROJECTS });
  const r = svc.collect(S, [S]);
  assert(!r.incomplete && r.unknownModels.length === 0, `零用量行被当成缺价：${JSON.stringify(r)}`);
  fs.appendFileSync(file, msg('m2', '', 1000));
  const r2 = svc.collect(S, [S]);
  assert(r2.unknownModels.join() === '(未标模型名)', `应显示「(未标模型名)」：${JSON.stringify(r2.unknownModels)}`);
});

test('接线：面板点名缺价模型并列出全局清单；服务端推 usage:missingPrices（连上即推一份）', () => {
  const card = fs.readFileSync(new URL('../src/components/SessionUsageCard.jsx', import.meta.url), 'utf8');
  assert(/usage\.incomplete && usage\.unknownModels\?\.length > 0 && \([\s\S]{0,200}usage\.unknownModels\.join/.test(card),
    '面板没点名缺价模型，或没缺价模型时也说"不在价格表里"（实测 5 个 $0 会话被误报）');
  assert(/<MissingPrices data=\{missingPrices\} \/>/.test(card) && /CC Switch「模型定价」/.test(card), '没列全局缺价清单/没说去哪补');
  const idx = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  assert((idx.match(/emit\('usage:missingPrices', /g) || []).length >= 2, '缺价清单要在变化时推、新客户端连上时也推');
  assert(/unknownModels: r\.unknownModels \|\| \[\]/.test(idx), '会话用量视图没带缺价模型名');
});

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

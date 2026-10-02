/**
 * 同一会话用多个模型：按模型分开的用量与成本（v1.4.78）。临时目录里的假 rollout，行格式照真实记录。
 *
 * 会坏的方式：
 *   ① 中途换模型，整段历史按新模型重算（旧版按尾部模型计价）→ 前一个模型的钱算错
 *   ② 两轮采集之间换了模型 → 一笔增量整笔记到其中一个模型名下
 *   ③ 分模型之和 ≠ 会话累计 → 面板两处数字对不上
 *   ④ 升级后首轮按新算法重扫，新旧累计之差被当成「本轮新花的钱」
 *   ⑤ 大记录分轮扫描期间把半截累计当成增量记账
 *   ⑥ 真实记录：各模型 token 之和与 Codex 自己的末条累计对不上
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { UsageLedger } from '../server/services/usage/UsageLedger.js';
import { SessionUsageService } from '../server/services/usage/SessionUsageService.js';
import { readCodexRun } from '../server/services/usage/CodexUsageReader.js';
import { splitDelta, mergeModelAliases, mainModelOf, UNNAMED_MODEL } from '../server/services/usage/usageSplit.js';

let pass = 0, fail = 0;
const test = (name, fn) => { try { fn(); pass++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n    ${e.message}`); } };
const near = (a, b, msg, eps = 1e-6) => { if (Math.abs(a - b) > eps) throw new Error(`${msg}：期望 ${b}，实际 ${a}`); };
const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); };

const PRICES = {   // 每百万 token：sol 与 luna 价差 20 倍，算错模型一眼可见
  'gpt-6-sol': { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'gpt-6-luna': { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};
const PRICING = { version: 1, get: (m) => (PRICES[m] ? { price: PRICES[m], modelId: m, source: 'ccswitch' } : { price: null, modelId: '' }) };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'usage_model_'));
const CODEX = path.join(TMP, 'codex');
const CWD = '/work/multi';

/** 一份 rollout：session_meta 头 + 若干回合。total 是 Codex 写的累计值（只增不减） */
function rollout(name, { subagent = false } = {}) {
  const dir = path.join(CODEX, '2026', '10', '02');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${name}.jsonl`);
  const source = subagent ? { subagent: { thread_spawn: { parent_thread_id: 'main' } } } : 'vscode';
  fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { cwd: CWD, id: name, source } }) + '\n');
  const total = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
  return {
    file,
    turn(model, turnId) { fs.appendFileSync(file, JSON.stringify({ type: 'turn_context', payload: { turn_id: turnId, model, cwd: CWD } }) + '\n'); },
    /** 一次请求：output 个输出 token（便于心算：sol 每 1M 输出 $10） */
    call(output) {
      total.output_tokens += output; total.total_tokens += output;
      fs.appendFileSync(file, JSON.stringify({ type: 'response_item', payload: { type: 'message', content: 'x'.repeat(200) } }) + '\n');
      fs.appendFileSync(file, JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { ...total } } } }) + '\n');
    },
  };
}
const SESSION = (id) => ({ id, aiType: 'codex', workingDir: CWD, status: 'running', createdAt: new Date(Date.now() - 3600e3).toISOString() });
const fresh = (opts = {}) => {
  fs.rmSync(CODEX, { recursive: true, force: true });
  const ledger = new UsageLedger({ dbPath: path.join(TMP, `l${Math.random().toString(36).slice(2)}.db`) });
  return { ledger, svc: new SessionUsageService({ ledger, pricing: PRICING, codexRoot: CODEX, ...opts }) };
};
const byModel = (r) => Object.fromEntries((r.byModel || []).map((m) => [m.model, m.usd]));
const bump = (file) => { const t = new Date(Date.now() + Math.random() * 1000); fs.utimesSync(file, t, t); };

test('①③ 中途换模型：两段各按自己的价格算，分模型之和等于会话累计', () => {
  const { svc } = fresh();
  const r = rollout('a'); r.turn('gpt-6-sol', 't0'); r.call(1000);
  const s = SESSION('s-a');
  svc.collect(s, [s]);                                   // 认领：只记基线
  r.call(1_000_000); bump(r.file); svc.collect(s, [s]);  // sol 100 万输出 = $10
  r.turn('gpt-6-luna', 't1'); r.call(2_000_000); bump(r.file);
  const out = svc.collect(s, [s]);                       // luna 200 万输出 = $1
  const m = byModel(out);
  near(m['gpt-6-sol'], 10, 'sol 那段');
  near(m['gpt-6-luna'], 1, 'luna 那段（旧版会按尾部模型把 sol 那段也重算成 luna 价）');
  near(out.sessionUsd, 11, '会话累计');
  near(Object.values(m).reduce((a, b) => a + b, 0), out.sessionUsd, '分模型之和');
});

test('② 两轮之间连换两次模型：一笔增量按模型拆开，不整笔记给一个', () => {
  const { svc } = fresh();
  const r = rollout('b'); r.turn('gpt-6-sol', 't0'); r.call(10);
  const s = SESSION('s-b');
  svc.collect(s, [s]);
  r.call(500_000);                                       // sol $5
  r.turn('gpt-6-luna', 't1'); r.call(4_000_000);         // luna $2
  r.turn('gpt-6-sol', 't2'); r.call(300_000);            // sol $3
  bump(r.file);
  const m = byModel(svc.collect(s, [s]));
  near(m['gpt-6-sol'], 8, 'sol 两段合计');
  near(m['gpt-6-luna'], 2, 'luna');
});

test('④ 升级后首轮重扫只重定基线：新旧算法的累计差不算新花的钱，之后照常记', () => {
  const { ledger, svc } = fresh();
  const r = rollout('c'); r.turn('gpt-6-sol', 't0'); r.call(1_000_000); r.turn('gpt-6-luna', 't1'); r.call(1_000_000);
  const s = SESSION('s-c');
  // 模拟旧版留下的状态：整份按尾部模型（luna）计价 = $1，认领时基线 $0.4，已记 $0.6；游标是旧格式
  ledger.claim(s.id, 'codex', r.file, 0.4, 'exclusive');
  ledger.record({ sessionId: s.id, cli: 'codex', runKey: r.file, deltaUsd: 0.6, model: 'gpt-6-luna',
    cursor: { filePath: r.file, inode: String(fs.statSync(r.file).ino), fileSize: 1, fileMtime: 1, cumUsd: 1, costComplete: true } });
  const first = svc.collect(s, [s]);                     // 新算法累计 = sol $10 + luna $0.5 = $10.5
  near(first.sessionUsd, 0.6, '重扫那一轮不得多记（旧版 $1 → 新版 $10.5 的差额不是本轮花的）');
  r.call(2_000_000); bump(r.file);                       // 之后 luna 又花 $1
  near(svc.collect(s, [s]).sessionUsd, 1.6, '重定基线后新增照常记');
});

test('⑤ 大记录分轮扫描：扫完前一分钱不记，扫完后只重定基线', () => {
  const { svc } = fresh({ codexScanBudget: 4096 });
  const r = rollout('d'); r.turn('gpt-6-sol', 't0');
  for (let i = 0; i < 60; i++) r.call(100_000);          // 约 30KB，4KB 一轮要扫好几轮
  const s = SESSION('s-d');
  let out, rounds = 0;
  do { out = svc.collect(s, [s]); rounds++; } while (out.scanning > 0 && rounds < 50);
  eq(rounds > 2, true, `应分多轮扫完，实际 ${rounds} 轮`);
  near(out.sessionUsd, 0, '扫描期间与扫完那一轮都不该记账');
  r.call(100_000); bump(r.file);
  near(svc.collect(s, [s]).sessionUsd, 1, '扫完后新增 sol 10 万输出 = $1');
});

test('splitDelta：合计恒等于 delta；各模型都没增长时整笔记给主模型', () => {
  const parts = splitDelta(1, { a: 1 }, { a: 1.3, b: 0.4, c: 0.3 }, 'a');
  near(parts.reduce((x, p) => x + p.usd, 0), 1, '合计', 1e-12);
  near(parts.find((p) => p.model === 'a').usd, 0.3, '按增长比例');
  eq(JSON.stringify(splitDelta(0.5, { a: 2 }, { a: 1 }, 'main').map((p) => [p.model, p.usd])), JSON.stringify([['main', 0.5]]), '无增长兜底');
});

test('⑦ 同一模型两种写法合成一行（实测 claude-opus-5.5 与 claude-opus-5-5 并存），未区分的放最后', () => {
  const rows = mergeModelAliases([
    { model: '', usd: 700, today: 0 }, { model: 'claude-opus-5.5', usd: 3301, today: 129 },
    { model: 'claude-opus-5-5', usd: 12, today: 0 }, { model: 'claude-opus-5', usd: 2579, today: 0 },
  ]);
  eq(JSON.stringify(rows.map((r) => r.model)), JSON.stringify(['claude-opus-5.5', 'claude-opus-5', UNNAMED_MODEL]), '顺序与合并');
  near(rows[0].usd, 3313, '合并后金额');
  eq(rows.find((r) => r.model === 'claude-opus-5'), rows[1], 'opus-5 与 opus-5.5 是不同模型，不能合');
});

test('⑧ 一轮里只多了 CLI 自记账、没有带模型名的调用：记到上一轮花得最多的模型，不记成「未区分」', () => {
  // 这正是真实面板上「(未标模型名)」那几百刀的来源：Claude 记录里的 cost-state 只有总数没有模型名
  const root = path.join(TMP, 'claude');
  const dir = path.join(root, '-work-cl');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'run-x.jsonl');
  const msg = (id, out) => JSON.stringify({ type: 'assistant', message: { id, model: 'claude-opus-5', usage: { input_tokens: 0, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) + '\n';
  fs.writeFileSync(f, JSON.stringify({ type: 'cost-state', totalCostUSD: 1, sessionId: 'run-x' }) + '\n' + msg('m0', 10));
  const ledger = new UsageLedger({ dbPath: path.join(TMP, 'claude.db') });
  const price = { version: 1, get: () => ({ price: { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 }, modelId: 'claude-opus-5', source: 'ccswitch' }) };
  const svc = new SessionUsageService({ ledger, pricing: price, claudeProjectsRoot: root });
  const s = { id: 's-cl', aiType: 'claude', workingDir: '/work/cl', claudeSessionId: 'run-x', status: 'running' };
  svc.collect(s, [s]);
  fs.appendFileSync(f, msg('m1', 40000)); bump(f); svc.collect(s, [s]);              // opus-5 花 $1
  fs.appendFileSync(f, JSON.stringify({ type: 'cost-state', totalCostUSD: 5, sessionId: 'run-x' }) + '\n'); bump(f);
  const out = svc.collect(s, [s]);                                                   // 只有自记账涨了
  const rows = ledger.sessionByModel(s.id, '2099-01-01');
  eq(rows.some((x) => !x.model), false, `出现了无模型名的行：${JSON.stringify(rows)}`);
  near(rows.reduce((a, x) => a + x.usd, 0), out.sessionUsd, '分模型之和等于会话累计');
});

test('⑨ 子代理另起一份记录（更新、用便宜模型）：花费都算进会话，「当前模型」仍是主线程的', () => {
  const { svc } = fresh();
  const main = rollout('main'); main.turn('gpt-6-sol', 't0'); main.call(10);
  const s = SESSION('s-f');
  svc.collect(s, [s]);
  main.call(1_000_000); bump(main.file);
  const sub = rollout('sub', { subagent: true }); sub.turn('gpt-6-luna', 'u0'); sub.call(10);
  const t = new Date(Date.now() + 5000); fs.utimesSync(sub.file, t, t);       // 子代理记录更新，排在最前
  svc.collect(s, [s]);
  sub.call(2_000_000); fs.utimesSync(sub.file, new Date(Date.now() + 9000), new Date(Date.now() + 9000));
  const out = svc.collect(s, [s]);
  eq(out.model, 'gpt-6-sol', '当前模型（旧版取最新记录，会显示成子代理的 luna）');
  const m = byModel(out);
  near(m['gpt-6-sol'], 10, '主线程'); near(m['gpt-6-luna'], 1, '子代理');
});

const tokOf = (ledger, sid, model) => ledger.sessionByModel(sid, '2099-01-01').find((r) => r.model === model) || {};

test('⑩ Codex token：只记认领之后新增的，每轮不重复累加累计值（旧版一个会话记出 9 万亿）', () => {
  const { ledger, svc } = fresh();
  const r = rollout('g'); r.turn('gpt-6-sol', 't0'); r.call(5_000_000);   // 认领前的历史
  const s = SESSION('s-g');
  svc.collect(s, [s]);
  for (let i = 0; i < 5; i++) { r.call(100_000); bump(r.file); svc.collect(s, [s]); }
  r.turn('gpt-6-luna', 't1'); r.call(70_000); bump(r.file); svc.collect(s, [s]);
  eq(tokOf(ledger, s.id, 'gpt-6-sol').output_tokens, 500_000, 'sol 输出 token（5 轮 × 10 万）');
  eq(tokOf(ledger, s.id, 'gpt-6-luna').output_tokens, 70_000, 'luna 输出 token');
});

test('⑪ Claude token：如实累加（旧版一直是 0），遇到 CLI 自记账刷新也不丢', () => {
  const root = path.join(TMP, 'claude2');
  const dir = path.join(root, '-work-tk');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'run-t.jsonl');
  const msg = (id, model, out) => JSON.stringify({ type: 'assistant', message: { id, model, usage: { input_tokens: 100, output_tokens: out, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } } }) + '\n';
  fs.writeFileSync(f, JSON.stringify({ type: 'cost-state', totalCostUSD: 1, sessionId: 'run-t' }) + '\n' + msg('h0', 'claude-opus-5', 999));
  const ledger = new UsageLedger({ dbPath: path.join(TMP, 'claude2.db') });
  const price = { version: 1, get: (m) => ({ price: { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 }, modelId: m, source: 'ccswitch' }) };
  const svc = new SessionUsageService({ ledger, pricing: price, claudeProjectsRoot: root });
  const s = { id: 's-tk', aiType: 'claude', workingDir: '/work/tk', claudeSessionId: 'run-t', status: 'running' };
  svc.collect(s, [s]);                                                         // 认领：h0 是历史，不计
  fs.appendFileSync(f, msg('m1', 'claude-opus-5', 2000)); bump(f); svc.collect(s, [s]);
  fs.appendFileSync(f, msg('m2', 'claude-sonnet-5', 300)
    + JSON.stringify({ type: 'cost-state', totalCostUSD: 2, sessionId: 'run-t' }) + '\n'      // 自记账刷新（折算费用清零重算）
    + msg('m3', 'claude-sonnet-5', 400)); bump(f); svc.collect(s, [s]);
  const o = tokOf(ledger, s.id, 'claude-opus-5'), so = tokOf(ledger, s.id, 'claude-sonnet-5');
  eq(o.output_tokens, 2000, 'opus 输出（不含认领前的 999）');
  eq(so.output_tokens, 700, 'sonnet 输出（锚点前后两条都要算）');
  eq(so.cache_read_tokens, 2000, 'sonnet 缓存读');
});

test('⑫ 升级时一次性清掉错的历史 token 并记下起点；之后再启动不会再清', () => {
  const db = path.join(TMP, 'migrate.db');
  const l1 = new UsageLedger({ dbPath: db });
  l1.db.exec("DELETE FROM cli_usage_meta");                                   // 模拟升级前的库
  l1.db.prepare("INSERT INTO cli_usage_daily (day, session_id, cli, model, cost_usd, input_tokens, output_tokens, cache_read_tokens) VALUES ('2026-09-30','x','codex','gpt-6-sol',5,9e12,3e10,9e12)").run();
  const l2 = new UsageLedger({ dbPath: db });
  const row = l2.db.prepare('SELECT * FROM cli_usage_daily').get();
  eq(row.cache_read_tokens, 0, '错的 token 清零'); near(row.cost_usd, 5, '费用不动');
  const since = l2.tokensSince();
  eq(since > 0, true, '记下起点');
  l2.db.prepare("UPDATE cli_usage_daily SET output_tokens=123").run();
  const l3 = new UsageLedger({ dbPath: db });
  eq(l3.db.prepare('SELECT output_tokens o FROM cli_usage_daily').get().o, 123, '第二次启动不得再清');
  eq(l3.tokensSince(), since, '起点不变');
});

const REAL = path.join(os.homedir(), '.codex/sessions/2026/09/26/rollout-2026-09-26T07-47-26-01a0daf7-789d-7d70-b89b-b0b8a549d63f.jsonl');
if (fs.existsSync(REAL)) {
  test('⑥ 真实记录（iSpring，三个模型）：各模型 token 之和 = Codex 末条累计', () => {
    const any = { version: 1, get: (m) => ({ price: { in: 1, out: 1, cacheRead: 1, cacheWrite: 1 }, modelId: m, source: 'ccswitch' }) };
    const r = readCodexRun({ filePath: REAL }, any, '', Infinity);
    const sum = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    for (const t of Object.values(r.modelTokens)) for (const k of Object.keys(sum)) sum[k] += t[k];
    for (const k of Object.keys(sum)) eq(sum[k], r.tokens[k], `${k} 合计`);
    eq(Object.keys(r.modelTokens).length >= 3, true, `应拆出至少 3 个模型，实际 ${Object.keys(r.modelTokens)}`);
  });
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);

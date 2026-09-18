/**
 * 会话用量：账本与采集 —— 回归测试（临时目录里的假 transcript，绝不碰真实会话与真实库）
 *
 * 核心不变式：**会话花费 = Σ 各 run 的认领后增量**。认领时记基线，所以
 * `claude --resume` 一个花过几千刀的老会话、codex 目录里堆着几十份历史 rollout，都不会算进这个会话。
 *
 * 运行: node tests/test-usage-ledger.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { UsageLedger } from '../server/services/usage/UsageLedger.js';
import { SessionUsageService, encodeCwd } from '../server/services/usage/SessionUsageService.js';
import { localDayKey } from '../server/services/usage/costMath.js';

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function test(name, fn) {
  try { fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'usage_test_'));
const PROJECTS = path.join(TMP, 'projects');
const PRICE = { get: () => ({ price: { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 }, modelId: 'claude-opus-5' }) };
const newLedger = () => new UsageLedger({ dbPath: path.join(TMP, `l${Math.random().toString(36).slice(2)}.db`) });
const svcOf = (ledger) => new SessionUsageService({ ledger, pricing: PRICE, claudeProjectsRoot: PROJECTS });
const SESSION = { id: 's1', aiType: 'claude', workingDir: '/work/demo', claudeSessionId: 'run-a', status: 'running' };

/** 写一份假 transcript：anchor 为 CLI 自记累计，msgs 为其后的调用 */
function writeTranscript(runKey, { anchor = null, msgs = [], cwd = '/work/demo' } = {}) {
  const dir = path.join(PROJECTS, encodeCwd(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const rows = [];
  if (anchor !== null) rows.push(JSON.stringify({ type: 'cost-state', totalCostUSD: anchor, sessionId: runKey }));
  for (const [id, out] of msgs) {
    rows.push(JSON.stringify({ type: 'assistant', message: { id, model: 'claude-opus-5', usage: { input_tokens: 0, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }));
  }
  const file = path.join(dir, `${runKey}.jsonl`);
  fs.writeFileSync(file, rows.join('\n') + '\n');
  return file;
}
const append = (file, id, out) => fs.appendFileSync(file,
  JSON.stringify({ type: 'assistant', message: { id, model: 'claude-opus-5', usage: { input_tokens: 0, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) + '\n');

test('认领一个已花过 $3457 的老会话（claude --resume）：首轮记 0，不把历史算进来', () => {
  const file = writeTranscript('run-a', { anchor: 3457.12 });
  const ledger = newLedger(); const svc = svcOf(ledger);
  const r1 = svc.collect(SESSION, [SESSION]);
  assert(r1.ok && Math.abs(r1.sessionUsd) < 1e-9, `首轮应为 0，实际 ${r1.sessionUsd}`);
  append(file, 'm1', 40000);                               // 之后花了 40000 输出 token = $1
  const r2 = svc.collect(SESSION, [SESSION]);
  assert(Math.abs(r2.sessionUsd - 1) < 1e-6, `只该算认领之后的 $1，实际 ${r2.sessionUsd}`);
});

test('/clear 换新会话文件：旧账保留、新账从 0 起算，总额不回退', () => {
  const ledger = newLedger(); const svc = svcOf(ledger);
  const fileA = writeTranscript('run-b', { anchor: 0 });
  svc.collect({ ...SESSION, claudeSessionId: 'run-b' }, []);
  append(fileA, 'm1', 40000);
  const before = svc.collect({ ...SESSION, claudeSessionId: 'run-b' }, []).sessionUsd;
  writeTranscript('run-c', { anchor: 99 });                // /clear 后是全新文件，CLI 自记 99（别的会话花的）
  svc.collect({ ...SESSION, claudeSessionId: 'run-c' }, []);
  const after = svc.collect({ ...SESSION, claudeSessionId: 'run-c' }, []).sessionUsd;
  assert(Math.abs(before - 1) < 1e-6, `旧 run 应记 $1，实际 ${before}`);
  assert(Math.abs(after - before) < 1e-9, `新 run 认领当轮不得加钱，实际 ${after}`);
});

test('同一个 CLI 记录被另一个会话接管：旧持有者保留已记的钱，新持有者从当前值起算', () => {
  const ledger = newLedger(); const svc = svcOf(ledger);
  const file = writeTranscript('run-d', { anchor: 0 });
  svc.collect({ ...SESSION, claudeSessionId: 'run-d' }, []);
  append(file, 'm1', 40000);
  const a = svc.collect({ ...SESSION, claudeSessionId: 'run-d' }, []).sessionUsd;
  const other = { ...SESSION, id: 's2', claudeSessionId: 'run-d' };
  svc.collect(other, []);                                   // s2 接管
  append(file, 'm2', 40000);
  const b = svc.collect(other, []).sessionUsd;
  assert(Math.abs(ledger.sessionTotal('s1') - a) < 1e-9, 's1 已记的钱不能被回收');
  assert(Math.abs(b - 1) < 1e-6, `s2 只该记接管之后的 $1，实际 ${b}`);
  assert(ledger.activeBinding('claude', 'run-d').session_id === 's2', '同一个 run 同时只能属于一个会话');
});

test('同一轮跑两次不重复计；文件被截断不出负数', () => {
  const ledger = newLedger(); const svc = svcOf(ledger);
  const file = writeTranscript('run-e', { anchor: 0 });
  svc.collect({ ...SESSION, claudeSessionId: 'run-e' }, []);
  append(file, 'm1', 40000);
  const once = svc.collect({ ...SESSION, claudeSessionId: 'run-e' }, []).sessionUsd;
  const twice = svc.collect({ ...SESSION, claudeSessionId: 'run-e' }, []).sessionUsd;   // 文件没动 → 读到 null
  assert(Math.abs(once - twice) < 1e-9, `重复采集不得加钱：${once} → ${twice}`);
  fs.writeFileSync(file, '');                                // 被截断
  const after = svc.collect({ ...SESSION, claudeSessionId: 'run-e' }, []).sessionUsd;
  assert(after >= twice - 1e-9, `截断后不得倒扣：${twice} → ${after}`);
});

test('游标比认领还旧时不得把认领前的钱算进来（第二道闸：不超过当前累计 − 认领基线）', () => {
  const ledger = newLedger(); const svc = svcOf(ledger);
  const file = writeTranscript('run-h', { anchor: 10 });
  svc.collect({ ...SESSION, claudeSessionId: 'run-h' }, []);            // 认领，基线 $10
  ledger.db.prepare('UPDATE cli_run_cursor SET cum_usd=2 WHERE run_key=?').run('run-h');   // 伪造一个陈旧游标
  append(file, 'm1', 40000);                                            // 之后真花了 $1
  const r = svc.collect({ ...SESSION, claudeSessionId: 'run-h' }, []);
  assert(Math.abs(r.sessionUsd - 1) < 1e-6, `只该算认领之后的 $1，实际 ${r.sessionUsd}`);
});

test('每日总额按本地日累加；归属不明与不支持的 CLI 不记账', () => {
  const ledger = newLedger(); const svc = svcOf(ledger);
  const file = writeTranscript('run-f', { anchor: 0 });
  svc.collect({ ...SESSION, claudeSessionId: 'run-f' }, []);
  append(file, 'm1', 40000);
  const r = svc.collect({ ...SESSION, claudeSessionId: 'run-f' }, []);
  assert(Math.abs(ledger.dayTotal(localDayKey(Date.now()), 's1') - 1) < 1e-6, '今日总额应含这 $1');
  assert(Math.abs(r.todayUsd - 1) < 1e-6, JSON.stringify(r));
  const grok = svc.collect({ id: 'g1', aiType: 'grok', workingDir: '/work/demo' }, []);
  assert(grok.ok === false && grok.kind === 'unsupported', JSON.stringify(grok));
  const amb = svc.collect({ id: 'c1', aiType: 'codex', workingDir: '/work/demo', status: 'running' },
    [{ id: 'c2', aiType: 'codex', workingDir: '/work/demo', status: 'running' }]);
  assert(amb.ok === false && amb.kind === 'ambiguous', JSON.stringify(amb));
});

test('没有锚点的文件标 estimated（整份都是折算值），不得把 0 当真值', () => {
  const ledger = newLedger(); const svc = svcOf(ledger);
  const file = writeTranscript('run-g', { msgs: [['m0', 40000]] });     // 没有 cost-state
  svc.collect({ ...SESSION, claudeSessionId: 'run-g' }, []);
  append(file, 'm1', 40000);
  const r = svc.collect({ ...SESSION, claudeSessionId: 'run-g' }, []);
  assert(r.estimated === true, '没有锚点必须标估算');
  assert(Math.abs(r.sessionUsd - 1) < 1e-6, `认领后新增 $1，实际 ${r.sessionUsd}`);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

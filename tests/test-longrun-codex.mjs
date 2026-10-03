/**
 * 长程 Codex 执行者（LongRunCodexRunner）。事件样本 tests/fixtures/longrun/codex-stream.jsonl 是 codex-cli 0.160.0 实抓
 * （开头两条是 config.toml 过时配置项的警告，接着建文件 + 跑 shell）。
 *   ① 事件：线程 id、工具在飞（shell 记 bash）与收回、开头的配置警告不算失败、中途重连后成功不算失败、turn.failed 算失败
 *   ② 参数：新对话与续接都走 workspace-write 沙箱、不弹确认、提示词走标准输入；续接不带 resume 不认的参数
 *   ③ rollout：按 thread_id 找文件、只读尾部；水位取最近一次调用、花费按累计差值 × 单价（续接时减去开始前的累计）
 *   ④ 真起子进程（假 codex）：提示词确实从标准输入进去、完成、水位与花费从 rollout 来
 *   ⑤ 开跑前：调不通就拒绝；窗口比交接线小时收紧；监督者也用 Codex
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { handleCodexEvent, buildCodexArgs, findRollout, readRolloutTail, LongRunCodexRunner } from '../server/services/LongRunCodexRunner.js';
import { ExitReason } from '../server/services/LongRunRunner.js';
import { prepareExecutor } from '../server/services/longrunExecutorSetup.js';
import { makeSupervisorChannel } from '../server/services/LongRunSupervisorCreds.js';

let pass = 0, fail = 0;
const test = async (n, fn) => { try { await fn(); pass++; console.log(`✅ ${n}`); } catch (e) { fail++; console.log(`❌ ${n}\n    ${e.message}`); } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); };
const FIX = new URL('./fixtures/longrun/codex-stream.jsonl', import.meta.url);
const events = fs.readFileSync(FIX, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const fresh = () => ({ inFlight: {}, toolNames: {}, toolCalls: 0, texts: [], finalText: '', warnings: [], usage: {} });

await test('① 实抓事件：工具、文字、配置警告不算失败', () => {
  const st = fresh(), seen = [];
  let bash = false;
  for (const ev of events) { handleCodexEvent(ev, st, (k, d) => seen.push(`${k}:${d.names || d.name || ''}`)); if (st.toolInFlight === 'bash') bash = true; }
  eq(seen, ['text:', 'tool:edit', 'tool_result:edit', 'tool:shell', 'tool_result:shell', 'text:'], '顺序');
  eq([st.sessionId, st.done, st.finalText, st.warnings.length, bash, st.toolInFlight, st.errorText], ['01a10253-c102-7233-9ac5-68aecf7ce4cc', true, 'done', 2, true, null, ''], '收尾');
});

await test('① 中途重连后成功不算失败；turn.failed 算失败', () => {
  const a = fresh();
  for (const ev of [{ type: 'error', message: 'Reconnecting... 1/5' }, { type: 'turn.completed', usage: {} }]) handleCodexEvent(ev, a);
  eq([a.done, a.errorText], [true, ''], '重连后成功');
  const b = fresh();
  for (const ev of [{ type: 'error', message: 'stream error: 503 无可用渠道' }, { type: 'turn.failed', error: { message: '503 无可用渠道' } }]) handleCodexEvent(ev, b);
  eq([b.done, /无可用渠道/.test(b.errorText)], [true, true], 'turn.failed');
});

await test('② 参数：沙箱与审批两种都带，提示词走标准输入', () => {
  const n = buildCodexArgs({ model: 'm', extraDirs: ['/r'] });
  eq([n[0], n.includes('sandbox_mode="workspace-write"'), n.includes('approval_policy="never"'), n.at(-1), n.includes('--add-dir')], ['exec', true, true, '-', true], '新对话');
  const r = buildCodexArgs({ sessionId: 'tid', resume: true });
  eq([r.slice(0, 2), r.at(-2), r.at(-1), r.includes('--add-dir'), r.includes('-s')], [['exec', 'resume'], 'tid', '-', false, false], '续接');
});

// 假 CODEX_HOME：一份 rollout，两条 token_count（续接前 / 本发结束）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-codex-'));
const HOME = path.join(TMP, 'codex');
const DAY = path.join(HOME, 'sessions', '2026', '10', '03');
fs.mkdirSync(DAY, { recursive: true });
const TID = '01a10253-c102-7233-9ac5-68aecf7ce4cc';
const RO = path.join(DAY, `rollout-2026-10-03T23-13-25-${TID}.jsonl`);
const tc = (total, last, win = 258400) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last, model_context_window: win } } });
fs.writeFileSync(RO, [JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-x' } }),
  tc({ input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100 }, { input_tokens: 1000, output_tokens: 100 })].join('\n') + '\n');

await test('③ rollout：按 id 找、读尾部的最新读数', () => {
  eq(findRollout(TID, HOME), RO, '找到文件');
  eq(findRollout('nope', HOME), null, '找不到');
  eq(readRolloutTail(RO), { occupied: 1100, window: 258400, total: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100 }, model: 'gpt-x' }, '读数');
});

const BIN = path.join(TMP, 'codex-bin');
fs.writeFileSync(BIN, `#!/bin/sh
cat > "${TMP}/stdin"
printf '%s\\n' '${tc({ input_tokens: 31000, cached_input_tokens: 20000, output_tokens: 300 }, { input_tokens: 16642, output_tokens: 5 })}' >> "${RO}"
cat "${FIX.pathname}"
`, { mode: 0o755 });
const pricing = { get: () => ({ price: { in: 2, out: 10, cacheRead: 0.5, cacheWrite: 0 } }) };

await test('④ 续接：提示词从标准输入进去；水位取 rollout 最新、花费 = 累计差值 × 单价', async () => {
  const r = await new LongRunCodexRunner({ cwd: TMP, env: { ...process.env, CODEX_HOME: HOME }, codexBin: BIN, pricing, watchdogInterval: 0.1 }).run('- 长需求', TID, true);
  eq(fs.readFileSync(`${TMP}/stdin`, 'utf8'), '- 长需求', '标准输入原样（只有放进命令行参数时才需要垫换行）');
  eq([r.exitReason, r.sessionId, r.executor, r.contextPeak], [ExitReason.COMPLETED, TID, 'codex', 16647], '结果与水位');
  // 本发：input 30000（其中缓存 20000）、output 200 → (10000×2 + 20000×0.5 + 200×10) / 1e6
  eq(r.costEstimate, 0.032, '花费');
});

await test('⑤ 开跑前：调不通拒绝；窗口小时收紧；监督者用 Codex', async () => {
  const O = { executor: 'codex', handoffFloor: 200_000, handoffCeiling: 350_000, hardKill: 400_000, model: '' };
  let msg = '';
  try { await prepareExecutor({ o: O, root: TMP, deps: { codexPing: async () => { throw new Error('401'); }, codexWindow: () => 0 } }); } catch (e) { msg = e.message; }
  eq(/config\.toml.*401/.test(msg), true, '调不通');
  const ok = await prepareExecutor({ o: O, root: TMP, deps: { codexPing: async () => ({ text: 'ok' }), codexWindow: () => 258400 } });
  eq([ok.thresholds, ok.modelLister], [{ handoffFloor: 155040, handoffCeiling: 206720, hardKill: 232560 }, null], '收紧');
  const made = [];
  const ch = makeSupervisorChannel({ executor: 'codex', executorOpts: { model: 'gpt-x' }, otherFactory: (o) => { made.push(o); return { complete: async () => ({ text: 'ok' }) }; } });
  eq([made[0].cli, made[0].model, ch.info.cliLabel], ['codex', 'gpt-x', 'Codex'], '监督者');
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);

/**
 * 长程 Kiro / OpenCode 执行者与执行者准备（LongRunKiroRunner、LongRunOpencodeRunner、longrunExecutorSetup）。
 * 事件样本 tests/fixtures/longrun/{kiro,opencode}-*.jsonl 是 2026-10-03 实抓（建文件 + 跑 shell；OpenCode 另有一份供应商 503）。
 *   ① Kiro：对话 id、工具在飞（shell 记 bash）与收回、占用百分比按窗口换 token、credits 取最后一份不累加
 *   ② OpenCode：每次调用的 token 记水位与估算费用、reason=stop 才算完、error 事件带出供应商原文
 *   ③ 真起子进程（假 CLI 回放样本）：Kiro 完成带 credits；OpenCode 503 → ERROR 且正文含「无可用渠道」（loop 据此自救换模型）；
 *      OpenCode 水位到线在调用间隙结束本发；提示词以「-」开头不会被当成选项
 *   ④ 提示词按执行者改写规则文件位置；Kiro 窗口小于交接线时收紧水位线
 *   ⑤ 开跑前准备：没登录 / 模型不存在 / 官方登录配不了 OpenCode 都拒绝；OpenCode 配置 0600 且不在项目里
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { handleKiroEvent, buildKiroArgs, LongRunKiroRunner } from '../server/services/LongRunKiroRunner.js';
import { handleOpencodeEvent, buildOpencodeArgs, LongRunOpencodeRunner } from '../server/services/LongRunOpencodeRunner.js';
import { ContextMeter, ExitReason } from '../server/services/LongRunRunner.js';
import { promptsFor, normalizeExecutor } from '../server/services/longrunExecutor.js';
import { prepareExecutor, fitThresholds, opencodeConfigPath } from '../server/services/longrunExecutorSetup.js';
import { loadPrompts } from '../server/services/LongRunPrompts.js';

let pass = 0, fail = 0;
const test = async (n, fn) => { try { await fn(); pass++; console.log(`✅ ${n}`); } catch (e) { fail++; console.log(`❌ ${n}\n    ${e.message}`); } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); };
const fx = (n) => new URL(`./fixtures/longrun/${n}`, import.meta.url);
const events = (n) => fs.readFileSync(fx(n), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const fresh = () => ({ inFlight: {}, toolNames: {}, toolCalls: 0, texts: [], finalText: '', contextNow: 0, credits: 0, costEstimate: 0,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });

await test('① Kiro 实抓事件：工具、水位、credits', () => {
  const st = fresh(), seen = [];
  let bash = false, peak = 0;
  for (const ev of events('kiro-stream.jsonl')) {
    handleKiroEvent(ev, st, (k, d) => seen.push(`${k}:${d.names || d.name || ''}`), { contextWindow: 1_000_000 });
    if (st.toolInFlight === 'bash') bash = true;
    peak = Math.max(peak, st.contextNow);
  }
  eq(st.sessionId, '6bd57c2f-1004-4b1e-9625-ab01a3c715e8', '对话 id');
  eq(seen, ['tool:write', 'tool_result:write', 'tool:shell', 'tool_result:shell', 'text:'], '工具与文字');
  eq([bash, st.toolInFlight, st.done, st.finalText], [true, null, true, 'Done.'], 'shell 在飞记 bash、收尾');
  eq(Math.round(st.contextNow), 13819, '1.3819% × 100 万');
  eq(Math.round(st.credits * 1e4) / 1e4, 0.1202, '三次调用的 credits 之和（只取最后一份）');
});

await test('② OpenCode 实抓事件：token、水位、估算费用、收尾', () => {
  const st = fresh(), meter = new ContextMeter({ pricing: { get: () => ({ price: { in: 1, out: 2, cacheRead: 0.1, cacheWrite: 0 } }) } });
  let inStepBash = false;
  for (const ev of events('opencode-stream.jsonl')) {
    handleOpencodeEvent(ev, st, () => {}, { meter, model: 'm' });
    if (ev.type === 'step_start') inStepBash = st.toolInFlight === 'bash';
  }
  eq([st.done, st.stopReason, st.finalText, st.toolCalls, st.toolInFlight], [true, 'stop', 'done', 2, null], '收尾');
  eq(inStepBash, true, '调用期间按 Bash 档容忍静默');
  eq(st.contextNow, 45 + 19175, '最后一次调用的 input + cache.read');
  eq(st.usage, { input: 17279, output: 111, cacheRead: 40194, cacheWrite: 0 }, 'token 累计（reasoning 计入 output）');
  eq(Math.round(st.costEstimate * 1e6) / 1e6, Math.round((17279 * 1 + 111 * 2 + 40194 * 0.1) / 1e6 * 1e6) / 1e6, '按单价估算');
  const e = fresh();
  for (const ev of events('opencode-error.jsonl')) handleOpencodeEvent(ev, e, () => {}, { meter: new ContextMeter() });
  eq([e.done, /无可用渠道/.test(e.errorText)], [true, true], '供应商 503 带出原文');
});

// 假 CLI：按 FAKE 回放样本；ARGS 文件记下实际收到的参数
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-exec-'));
const fake = (name) => {
  const bin = path.join(TMP, name);
  fs.writeFileSync(bin, `#!/bin/sh
printf '%s\\n' "$@" > "${TMP}/${name}.args"
printf '%s' "$OPENCODE_CONFIG" > "${TMP}/${name}.env"
case "$FAKE" in
  kiro) cat "${fx('kiro-stream.jsonl').pathname}" ;;
  oc) cat "${fx('opencode-stream.jsonl').pathname}" ;;
  ocerr) cat "${fx('opencode-error.jsonl').pathname}"; exit 1 ;;
  kirohang) head -4 "${fx('kiro-stream.jsonl').pathname}"; sleep 30 ;;
  ochang) head -3 "${fx('opencode-stream.jsonl').pathname}"; sleep 30 ;;
esac
`, { mode: 0o755 });
  return bin;
};
const KIRO = fake('kiro-cli'), OC = fake('opencode');
const base = (f, extra = {}) => ({ cwd: TMP, env: { ...process.env, FAKE: f }, watchdogInterval: 0.1, ...extra });

await test('③ Kiro 子进程：完成、续接参数、credits 进结果', async () => {
  const r = await new LongRunKiroRunner(base('kiro', { kiroBin: KIRO, contextWindow: 1_000_000, model: 'auto' })).run('做事', 'old-id', true);
  eq([r.exitReason, r.sessionId, r.executor, r.costUsd, r.credits], [ExitReason.COMPLETED, '6bd57c2f-1004-4b1e-9625-ab01a3c715e8', 'kiro', 0, 0.1202], '结果');
  eq(r.contextPeak, 44800, '峰值含新对话那次 4.48% 的启动估计（远低于交接线）');
  eq(fs.readFileSync(`${TMP}/kiro-cli.args`, 'utf8').trim().split('\n'), buildKiroArgs({ prompt: '做事', sessionId: 'old-id', resume: true, model: 'auto' }), '参数');
});

await test('③ Kiro 被插话打断：结束本发，credits 记「未知」而不是 0', async () => {
  let given = false;
  const r = await new LongRunKiroRunner(base('kirohang', { kiroBin: KIRO, contextWindow: 1_000_000,
    checkInject: () => (given ? null : (given = true, ['改一下', false])) })).run('做事');
  eq([r.exitReason, r.injectText, r.credits, r.creditsUnknown], [ExitReason.INTERRUPTED_BY_HUMAN, '改一下', 0, true], '打断');
});

await test('③ OpenCode 子进程：完成、配置经环境变量传入、模型带供应商前缀', async () => {
  const r = await new LongRunOpencodeRunner(base('oc', { opencodeBin: OC, opencodeConfig: '/x/opencode.json', model: 'claude-opus-5-5' })).run('做事');
  eq([r.exitReason, r.sessionId, r.executor], [ExitReason.COMPLETED, 'ses_efde6a47dffe0Mvd7Z4bXyGXYK', 'opencode'], '结果');
  eq(r.costEstimate > 0 && r.costUsd === 0, true, '自定义供应商不报价：按估算记账');
  eq(fs.readFileSync(`${TMP}/opencode.env`, 'utf8'), '/x/opencode.json', 'OPENCODE_CONFIG 进了子进程环境');
  eq(buildOpencodeArgs({ prompt: 'p', sessionId: 's', resume: true, model: 'm' }), ['run', '--format', 'json', '--auto', '-s', 's', '-m', 'ccswitch/m', 'p'], '参数');
});

await test('③ OpenCode 供应商 503：ERROR，正文含「无可用渠道」', async () => {
  const r = await new LongRunOpencodeRunner(base('ocerr', { opencodeBin: OC })).run('做事');
  eq([r.exitReason, /无可用渠道/.test(r.error)], [ExitReason.ERROR, true], '报错');
});

await test('③ OpenCode 水位到线：在调用间隙结束本发', async () => {
  const r = await new LongRunOpencodeRunner(base('ochang', { opencodeBin: OC, contextLimit: 10_000 })).run('做事');
  eq(r.exitReason, ExitReason.BUDGET_KILLED, '第一次调用后水位 19,078 > 10,000');
});

await test('③ 子进程的 PWD 是项目目录（OpenCode 按 PWD 认目录，继承服务的 PWD 会在 WebTmux 仓库里干活）', () => {
  const env = { PWD: '/Users/x/WebTmux', KEEP: '1' };
  for (const R of [LongRunKiroRunner, LongRunOpencodeRunner]) {
    const e = new R({ cwd: '/proj', env, opencodeConfig: '/c.json' }).childEnv();
    eq([e.PWD, e.KEEP], ['/proj', '1'], R.name);
  }
  eq(new LongRunOpencodeRunner({ cwd: '/proj', env, opencodeConfig: '/c.json' }).childEnv().OPENCODE_CONFIG, '/c.json', '配置照带');
});

await test('③ 水位与费用刹车只在工具间隙动手', () => {
  const r = new LongRunOpencodeRunner({ contextLimit: 100, costCeiling: 1 });
  const st = { toolInFlight: 'bash', contextNow: 500, costEstimate: 5, killReason: null };
  r._checkLimits(st);
  eq(st.killReason, null, '工具在飞：不动');
  st.toolInFlight = null; r._checkLimits(st);
  eq(st.killReason, ExitReason.BUDGET_KILLED, '间隙：水位先到');
  const c = { toolInFlight: null, contextNow: 0, costEstimate: 5, killReason: null }; r._checkLimits(c);
  eq([c.killReason, /超过刹车线/.test(c.costDetail)], [ExitReason.COST_KILLED, true], '费用刹车');
});

await test('③ 提示词以「-」开头：垫一个换行，不被当成选项', async () => {
  await new LongRunKiroRunner(base('kiro', { kiroBin: KIRO })).run('- 第一条需求');
  eq(fs.readFileSync(`${TMP}/kiro-cli.args`, 'utf8').includes('\n- 第一条需求'), true, '参数里是换行开头');
});

await test('④ 提示词改写：规则文件按执行者；Kiro 窗口小时收紧水位线', () => {
  const orig = loadPrompts(path.resolve('server/prompts/longrun/提示词.txt'));
  eq(/\.kiro\/steering/.test(promptsFor('kiro', orig).maintain_2), true, 'Kiro steering');
  eq(/AGENTS\.md/.test(promptsFor('opencode', orig).maintain_2) && !/CLAUDE\.md|Auto Memory/.test(Object.values(promptsFor('opencode', orig)).join('')), true, 'OpenCode');
  eq(normalizeExecutor('kiro'), 'kiro', 'kiro');
  const o = { handoffFloor: 200_000, handoffCeiling: 350_000, hardKill: 400_000 };
  eq(fitThresholds(o, 1_000_000), null, '窗口够大不动');
  eq(fitThresholds(o, 200_000), { handoffFloor: 120_000, handoffCeiling: 160_000, hardKill: 180_000 }, '20 万窗口');
});

const O = (x) => ({ handoffFloor: 200_000, handoffCeiling: 350_000, hardKill: 400_000, model: '', providerId: '', ...x });
const rejects = async (p, re, m) => { try { await p; } catch (e) { if (re.test(e.message)) return; throw new Error(`${m}：报错不对：${e.message}`); } throw new Error(`${m}：应当拒绝`); };

await test('⑤ 准备：没登录、模型不存在都拒绝；Kiro 带出窗口', async () => {
  await rejects(prepareExecutor({ o: O({ executor: 'cursor' }), root: TMP, deps: { cursorAccount: async () => null } }), /cursor-agent login/, 'Cursor 没登录');
  const kiroDeps = { kiroAccount: async () => ({ method: 'Google' }), listKiroModels: async () => ({ ok: true, models: ['auto', 'claude-sonnet-4.5'], windows: { auto: 1_000_000, 'claude-sonnet-4.5': 200_000 } }) };
  await rejects(prepareExecutor({ o: O({ executor: 'kiro', model: 'nope' }), root: TMP, deps: kiroDeps }), /悄悄换成默认模型/, 'Kiro 模型不存在');
  const k = await prepareExecutor({ o: O({ executor: 'kiro', model: 'claude-sonnet-4.5' }), root: TMP, deps: kiroDeps });
  eq([k.extra.contextWindow, k.thresholds?.hardKill, k.modelLister], [200_000, 180_000, null], 'Kiro 窗口与收紧');
});

await test('⑤ 准备 OpenCode：官方登录拒绝；配置 0600、不在项目里、验证失败就拒绝', async () => {
  const oauth = { getSettings: () => ({ claude: { apiUrl: '', apiKey: '' } }) };
  await rejects(prepareExecutor({ o: O({ executor: 'opencode' }), root: TMP, engine: oauth, deps: { home: TMP } }), /官方登录/, '官方登录');
  const engine = { resolveSessionSettings: () => ({ _providerName: 'Relay', claude: { apiUrl: 'https://r.example.com', apiKey: 'tok-placeholder', model: '' } }) };
  const deps = { home: TMP, listProviderModels: async () => ({ ok: true, models: ['gpt-5.6', 'claude-opus-5-5'] }), verify: async () => ({ ok: true }) };
  const root = path.join(TMP, 'proj');
  const r = await prepareExecutor({ o: O({ executor: 'opencode', providerId: 'p1' }), root, engine, deps });
  const file = opencodeConfigPath(root, TMP);
  eq([r.extra.opencodeConfig, r.extra.defaultModel], [file, 'claude-opus-5-5'], '配置路径与模型');
  eq([fs.statSync(file).mode & 0o777, file.startsWith(root)], [0o600, false], '0600、不在项目里');
  eq(await r.modelLister(), ['claude-opus-5-5'], '自动换模型只在 Claude 系里挑');
  await rejects(prepareExecutor({ o: O({ executor: 'opencode', providerId: 'p1' }), root, engine, deps: { ...deps, verify: async () => ({ ok: false, error: '供应商返回 401' }) } }), /401/, '验证失败');
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);

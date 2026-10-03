/**
 * Cursor / Kiro / OpenCode 的纯文本调用（OtherCliText.js），以及长程监督者、终端监控按 CLI 选通道。
 *   ① 提示词：开头明说「没有工作区、不要用工具」（Cursor 实测不说就去翻空目录、判没做完）；要 JSON 时带上 schema；超长截开头
 *   ② 参数：都是只读 / 不给工具的模式（Cursor --mode ask、Kiro 不带 --trust-all-tools、OpenCode --agent plan）
 *   ③ 解析：实抓输出取得到正文与对话 id；报错带出原文
 *   ④ 真起子进程（假 CLI）：返回正文、PWD 指向临时目录、OpenCode 带配置；调用后 Kiro 的那段对话被删
 *   ⑤ 监督者：执行者是谁就用谁（Kiro 执行者 → Kiro 监督者，模型跟执行者）；Claude 执行者照旧走 claude CLI
 *   ⑥ 终端监控：Cursor / Kiro / OpenCode 会话各有自己的通道，OpenCode 用本会话的配置
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { composePrompt, CLI_TEXT, OtherCliTextClient, NO_WORKSPACE, sessionIdOf } from '../server/services/OtherCliText.js';
import { makeSupervisorChannel } from '../server/services/LongRunSupervisorCreds.js';
import { AIEngine } from '../server/services/AIEngine.js';

let pass = 0, fail = 0;
const test = async (n, fn) => { try { await fn(); pass++; console.log(`✅ ${n}`); } catch (e) { fail++; console.log(`❌ ${n}\n    ${e.message}`); } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); };
const fx = (n) => fs.readFileSync(new URL(`./fixtures/longrun/${n}`, import.meta.url), 'utf8');

await test('① 提示词：先说没有工作区，带 schema，超长截开头', () => {
  const p = composePrompt('系统', '材料', { type: 'object' });
  eq([p.startsWith(NO_WORKSPACE), p.includes('系统'), p.includes('{"type":"object"}'), p.endsWith('材料')], [true, true, true, true], '结构');
  const long = composePrompt('系统', `开头${'x'.repeat(500_000)}结尾`);
  eq([long.length <= 400_000, long.endsWith('结尾'), long.includes('开头')], [true, true, false], '截开头留结尾');
});

await test('② 参数都是只读 / 不给工具的模式', () => {
  eq(CLI_TEXT.cursor.args({ prompt: 'p', model: 'm' }), ['-p', '--mode', 'ask', '--trust', '--output-format', 'json', '--model', 'm', 'p'], 'cursor');
  const k = CLI_TEXT.kiro.args({ prompt: 'p' });
  eq([k.includes('--trust-all-tools'), k.includes('-a'), k.includes('--no-interactive')], [false, false, true], 'kiro 不放行工具');
  eq(CLI_TEXT.opencode.args({ prompt: 'p', model: 'claude-x' }), ['run', '--format', 'json', '--agent', 'plan', '-m', 'ccswitch/claude-x', 'p'], 'opencode');
});

await test('③ 解析实抓输出', () => {
  const c = CLI_TEXT.cursor.parse(JSON.stringify({ type: 'result', is_error: false, result: '{"verdict":"done"}', session_id: 's1', usage: { inputTokens: 10, cacheReadTokens: 5, outputTokens: 3 } }));
  eq([c.text, c.sessionId, c.inputTokens, c.outputTokens], ['{"verdict":"done"}', 's1', 15, 3], 'cursor');
  const k = CLI_TEXT.kiro.parse(fx('kiro-stream.jsonl'));
  eq([k.text, k.sessionId, Math.round(k.credits * 1e4)], ['Done.', '6bd57c2f-1004-4b1e-9625-ab01a3c715e8', 1202], 'kiro');
  const o = CLI_TEXT.opencode.parse(fx('opencode-stream.jsonl'));
  eq([o.text, o.sessionId], ['done', 'ses_efde6a47dffe0Mvd7Z4bXyGXYK'], 'opencode');
  let msg = '';
  try { CLI_TEXT.opencode.parse(fx('opencode-error.jsonl')); } catch (e) { msg = e.message; }
  eq(/无可用渠道/.test(msg), true, 'opencode 报错带原文');
  eq(sessionIdOf(fx('opencode-error.jsonl')), 'ses_efde516e9ffeM2mi8N2ynrX2jF', '失败时也拿得到 id 去清理');
});

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'other-text-'));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(path.join(HOME, '.kiro', 'sessions', 'cli'), { recursive: true });
for (const ext of ['json', 'jsonl']) fs.writeFileSync(path.join(HOME, '.kiro', 'sessions', 'cli', `6bd57c2f-1004-4b1e-9625-ab01a3c715e8.${ext}`), '{}');
fs.writeFileSync(path.join(HOME, '.kiro', 'sessions', 'cli', 'someone-else.json'), '{}');
const BIN = path.join(TMP, 'fake-cli');
fs.writeFileSync(BIN, `#!/bin/sh
printf '%s|%s' "$PWD" "$OPENCODE_CONFIG" > "${TMP}/env"
cat "${new URL('./fixtures/longrun/', import.meta.url).pathname}$FIX"
`, { mode: 0o755 });

await test('④ 真起子进程：正文、PWD 是临时目录、调用后 Kiro 那段对话被删（别的不动）', async () => {
  const r = await new OtherCliTextClient({ cli: 'kiro', bin: BIN, home: HOME, env: { ...process.env, FIX: 'kiro-stream.jsonl' } }).complete('系统', '材料');
  eq(r.text, 'Done.', '正文');
  const [pwd] = fs.readFileSync(`${TMP}/env`, 'utf8').split('|');
  eq([/webtmux-cli-text-/.test(pwd), fs.existsSync(pwd)], [true, false], 'PWD 是临时目录且已删');
  eq(fs.readdirSync(path.join(HOME, '.kiro', 'sessions', 'cli')), ['someone-else.json'], '只删这次的对话');
});

await test('④ OpenCode 带配置文件', async () => {
  const r = await new OtherCliTextClient({ cli: 'opencode', bin: BIN, home: HOME, opencodeConfig: '/c.json', env: { ...process.env, FIX: 'opencode-stream.jsonl' } }).complete('s', 'u');
  eq([r.text, fs.readFileSync(`${TMP}/env`, 'utf8').split('|')[1]], ['done', '/c.json'], 'OPENCODE_CONFIG');
});

await test('⑤ 监督者跟着执行者走', async () => {
  const made = [];
  const ch = makeSupervisorChannel({ executor: 'kiro', executorOpts: { model: 'claude-sonnet-4.5' }, providerId: 'p1',
    otherFactory: (o) => { made.push(o); return { complete: async () => ({ text: 'ok' }) }; },
    cliFactory: () => { throw new Error('不该走 claude'); } });
  eq([made[0].cli, made[0].model, ch.info.cli, ch.info.via], ['kiro', 'claude-sonnet-4.5', 'kiro', 'cli'], 'Kiro 执行者 → Kiro 监督者');
  eq((await ch.complete('s', 'u')).text, 'ok', '调用');
  const claude = makeSupervisorChannel({ executor: 'claude', cliFactory: (m) => ({ m, complete: async () => ({ text: m }) }), otherFactory: () => { throw new Error('不该走别家'); } });
  eq([claude.info.cli, claude.info.via], [undefined, 'cli'], 'Claude 执行者照旧');
});

await test('⑥ 终端监控：三家各有自己的通道，OpenCode 用本会话的配置', () => {
  const e = new AIEngine();
  eq(['cursor', 'kiro', 'opencode'].map((k) => e.cliChannels[k]?.source), ['cursor_cli', 'kiro_cli', 'opencode_cli'], '通道');
  eq([e.cliChannels.kiro.factory().cli, e.cliChannels.opencode.factory('no-such-session').opencodeConfig], ['kiro', ''], '没有会话配置就用它自己的全局配置');
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);

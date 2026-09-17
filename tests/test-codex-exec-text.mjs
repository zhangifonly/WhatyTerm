/**
 * codex exec 纯文本调用（AI 监控 codex 会话用）—— 回归测试（假 codex，绝不起真 CLI）
 *
 * 实测要点（codex-cli 0.154.0，2026-09-17）：--output-schema 走 OpenAI 严格模式，缺 additionalProperties:false
 * 直接 400；老的 generateTextViaCLI 调 codex 用的是 --dangerously-bypass-approvals-and-sandbox，纯文本判断不能沿用。
 *
 * 运行: node tests/test-codex-exec-text.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { CodexExecTextClient, buildCodexExecArgs, toStrictSchema, parseCodexEvents, codexTextCwd } from '../server/services/CodexExecText.js';

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
async function test(name, fn) {
  try { await fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lr_codextext_'));
const FAKE = path.join(TMP, 'fake-codex.mjs');
fs.writeFileSync(FAKE, `
import fs from 'fs';
const args = process.argv.slice(2);
const at = (f) => args[args.indexOf(f) + 1];
let input = ''; process.stdin.on('data', (b) => { input += b; });
process.stdin.on('end', () => {
  const mode = process.env.FAKE_MODE || 'ok';
  const ev = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  if (mode === 'hang') return setTimeout(() => {}, 60000);
  if (mode === 'crash') { process.stderr.write('Error: unexpected argument'); process.exit(2); }
  ev({ type: 'thread.started' }); ev({ type: 'turn.started' });
  if (mode === 'turn_failed') { ev({ type: 'error', message: 'invalid_json_schema' }); ev({ type: 'turn.failed', error: { message: 'invalid_json_schema' } }); process.exit(1); }
  if (mode === 'silent') { ev({ type: 'turn.completed', usage: {} }); return; }
  const schema = args.includes('--output-schema') ? JSON.parse(fs.readFileSync(at('--output-schema'), 'utf8')) : null;
  const echo = { args, input, cwd: process.cwd(), instructions: fs.readFileSync(JSON.parse(at('-c').split('=').slice(1).join('=')), 'utf8'),
    schema, env: { L: process.env.WEBTMUX_LONGRUN, TMUX: process.env.TMUX ?? null } };
  fs.writeFileSync(at('-o'), JSON.stringify(echo));
  ev({ type: 'turn.completed', usage: { input_tokens: 11801, output_tokens: 181 } });
});`);
const client = (mode, o = {}) => new CodexExecTextClient({ codexBin: process.execPath, binPrefixArgs: [FAKE],
  env: { ...process.env, FAKE_MODE: mode, TMUX: '/tmp/tmux-1/default,1,0' }, ...o });
const rejects = async (p) => { try { await p; } catch (e) { return e.message; } throw new Error('应当失败却成功了'); };
const SCHEMA = { type: 'object', properties: { state: { type: 'string' }, confidence: { type: 'number' }, nested: { type: 'object', properties: { a: { type: 'string' } } } }, required: ['state'] };

await test('纯文本调用：不写会话、只读沙箱、关掉 shell 等工具、固定空目录、替换基础指令、提示词走标准输入；绝不带危险放行参数', async () => {
  const r = await client('ok').complete('判定规则', '终端全文\n'.repeat(3000), { jsonSchema: SCHEMA });
  const echo = JSON.parse(r.text);
  const a = echo.args;
  assert(a[0] === 'exec' && a.includes('--ephemeral') && a.includes('--skip-git-repo-check') && a[a.indexOf('--sandbox') + 1] === 'read-only', a.join(' '));
  assert(a.includes('shell_tool') && a.includes('unified_exec') && a.includes('hooks') && a[a.length - 1] === '-', '工具能力要关、提示词从标准输入读');
  assert(!a.some((x) => /dangerously/.test(x)), '纯文本判断绝不能带 --dangerously-* 参数');
  assert(echo.instructions === '判定规则' && echo.input.length === '终端全文\n'.length * 3000, '基础指令与标准输入');
  assert(fs.realpathSync(echo.cwd) === fs.realpathSync(codexTextCwd()) && echo.env.L === '1' && echo.env.TMUX === null, JSON.stringify(echo.env));
  assert(echo.schema.additionalProperties === false && echo.schema.required.join() === 'state,confidence,nested', '要转成严格模式 schema');
  assert(r.inputTokens === 11801 && r.outputTokens === 181, JSON.stringify(r));
});

await test('严格模式 schema：每层 object 关闭额外字段且全部字段必填，原对象不被改动', () => {
  const s = toStrictSchema(SCHEMA);
  assert(s.properties.nested.additionalProperties === false && s.properties.nested.required.join() === 'a');
  assert(SCHEMA.required.join() === 'state' && SCHEMA.additionalProperties === undefined, '不能改调用方传进来的 schema');
  assert(buildCodexExecArgs({ cwd: '/d', instructionsFile: '/i', lastFile: '/o' }).indexOf('--output-schema') === -1, '不要求结构化时不带 schema');
});

await test('失败都要抛出：turn.failed、非零退出、没有输出、超时；每次调用的临时文件都清掉', async () => {
  const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('webtmux-codex-call-')).length;
  assert(/invalid_json_schema/.test(await rejects(client('turn_failed').complete('s', 'u'))));
  assert(/退出码 2.*unexpected argument/.test(await rejects(client('crash').complete('s', 'u'))));
  assert(/调用失败/.test(await rejects(client('silent').complete('s', 'u'))));
  assert(/超过 1 秒/.test(await rejects(client('hang', { timeoutMs: 1000 }).complete('s', 'u'))));
  assert(/无法启动/.test(await rejects(new CodexExecTextClient({ codexBin: path.join(TMP, 'no-such-bin') }).complete('s', 'u'))));
  const after = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('webtmux-codex-call-')).length;
  assert(after === before, `临时目录残留 ${after - before} 个`);
});

await test('事件流解析：用量、错误、最后一条回复', () => {
  const ev = parseCodexEvents(['{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}', 'not json',
    '{"type":"turn.completed","usage":{"input_tokens":5}}'].join('\n'));
  assert(ev.lastText === 'hi' && ev.usage.input_tokens === 5 && !ev.error, JSON.stringify(ev));
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

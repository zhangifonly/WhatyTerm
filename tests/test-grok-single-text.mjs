/**
 * grok -p 纯文本调用（AI 监控 grok 会话用）+ CLI 子进程公共部分 —— 回归测试（假 grok，绝不起真 CLI）
 *
 * 实测要点（grok 1.0.30，2026-09-17）：没有"不保存会话"的参数，会话写到 ~/.grok/sessions/<URL 编码的工作目录>/<id>，
 * 不清理会随监控调用无限堆积；结构化结果在 structuredOutput。
 *
 * 运行: node tests/test-grok-single-text.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { GrokSingleTextClient, buildGrokArgs, parseGrokResult, GROK_CWD_PREFIX } from '../server/services/GrokSingleText.js';
import { runCli, internalCliEnv } from '../server/services/cliProcess.js';

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
async function test(name, fn) {
  try { await fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lr_groktext_'));
const HOME = path.join(TMP, 'grok-home');
const FAKE = path.join(TMP, 'fake-grok.mjs');
// 假 grok：像真的一样在 <home>/sessions/<编码工作目录>/<id> 落会话，并回显参数、提示词文件、工作目录、环境
fs.writeFileSync(FAKE, `
import fs from 'fs'; import path from 'path';
const args = process.argv.slice(2);
const at = (f) => args[args.indexOf(f) + 1];
const mode = process.env.FAKE_MODE || 'ok';
if (mode === 'hang') setTimeout(() => {}, 60000);
else if (mode === 'crash') { process.stderr.write('not logged in'); process.exit(3); }
else {
  const cwd = at('--cwd');
  fs.mkdirSync(path.join(process.env.FAKE_HOME, 'sessions', encodeURIComponent(cwd), 'sid-1'), { recursive: true });
  const echo = { args, prompt: fs.readFileSync(at('--prompt-file'), 'utf8'), cwd: process.cwd(), env: { L: process.env.WEBTMUX_LONGRUN, CC: process.env.CLAUDECODE ?? null } };
  const out = mode === 'empty' ? { text: '', sessionId: 'sid-1' }
    : { text: 'ignored', structuredOutput: { echo }, stopReason: 'end_turn', sessionId: 'sid-1', usage: { input_tokens: 23004, output_tokens: 300 }, total_cost_usd: 0.0165 };
  process.stdout.write(JSON.stringify(out));
}`);
const client = (mode, o = {}) => new GrokSingleTextClient({ grokBin: process.execPath, binPrefixArgs: [FAKE], grokHome: HOME,
  env: { ...process.env, FAKE_MODE: mode, FAKE_HOME: HOME, CLAUDECODE: '1' }, ...o });
const rejects = async (p) => { try { await p; } catch (e) { return e.message; } throw new Error('应当失败却成功了'); };
const sessionsLeft = () => (fs.existsSync(path.join(HOME, 'sessions')) ? fs.readdirSync(path.join(HOME, 'sessions')).length : 0);
const tmpLeft = () => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith(GROK_CWD_PREFIX)).length;

await test('纯文本调用：替换系统提示词、不给工具、单轮低推理、关子智能体/计划/搜索；提示词走文件；取 structuredOutput', async () => {
  const before = tmpLeft();
  const r = await client('ok').complete('判定规则', '终端全文\n'.repeat(3000), { jsonSchema: { type: 'object' } });
  const { echo } = JSON.parse(r.text);
  const a = echo.args;
  assert(a[a.indexOf('--system-prompt-override') + 1] === '判定规则' && a[a.indexOf('--tools') + 1] === '' && a[a.indexOf('--max-turns') + 1] === '1', a.join(' '));
  assert(a.includes('--no-subagents') && a.includes('--no-plan') && a.includes('--disable-web-search') && a[a.indexOf('--reasoning-effort') + 1] === 'low');
  assert(a[a.indexOf('--json-schema') + 1] === '{"type":"object"}' && !a.some((x) => x.includes('终端全文')), '终端全文不能进命令行参数');
  assert(echo.prompt.length === '终端全文\n'.length * 3000 && echo.env.L === '1' && echo.env.CC === null, JSON.stringify(echo.env));
  assert(path.basename(echo.cwd).startsWith(GROK_CWD_PREFIX), echo.cwd);
  assert(r.inputTokens === 23004 && r.costUsd === 0.0165, JSON.stringify(r));
  assert(sessionsLeft() === 0 && tmpLeft() === before, `调用完要删掉临时工作目录与 grok 会话目录（剩 ${sessionsLeft()} 个会话目录）`);
});

await test('失败都要抛出且照样清理：非零退出、没有输出、超时', async () => {
  assert(/退出码 3.*not logged in/.test(await rejects(client('crash').complete('s', 'u'))));
  assert(/没有输出/.test(await rejects(client('empty').complete('s', 'u'))));
  assert(/超过 1 秒/.test(await rejects(client('hang', { timeoutMs: 1000 }).complete('s', 'u'))));
  assert(sessionsLeft() === 0, '失败时也要清理 grok 会话目录');
});

await test('纯函数：不带 schema 时不传 --json-schema；输出不是 JSON 报错', () => {
  assert(!buildGrokArgs({ cwd: '/d', promptFile: '/p', system: 's' }).includes('--json-schema'));
  assert((() => { try { parseGrokResult('oops'); } catch (e) { return /不是 JSON/.test(e.message); } return false; })());
});

await test('子进程公共部分：内部调用带长程头、清掉嵌套标记；启动失败与超时报错带名字', async () => {
  const env = internalCliEnv({ PATH: '/bin', CLAUDECODE: '1', TMUX: 'x', TMUX_PANE: '%1' }, { EXTRA: '1' });
  assert(env.WEBTMUX_LONGRUN === '1' && env.EXTRA === '1' && !('CLAUDECODE' in env) && !('TMUX' in env) && !('TMUX_PANE' in env));
  const r = await runCli({ label: 't', bin: process.execPath, args: ['-e', 'process.stdin.pipe(process.stdout)'], cwd: TMP, env: process.env, stdin: '回显', timeoutMs: 5000 });
  assert(r.code === 0 && r.out === '回显', JSON.stringify(r));
  assert(/无法启动 某 CLI/.test(await rejects(runCli({ label: '某 CLI', bin: path.join(TMP, 'nope'), args: [], cwd: TMP, env: process.env, timeoutMs: 5000 }))));
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

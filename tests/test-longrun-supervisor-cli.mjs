/**
 * 长程监督者经 claude CLI 调用 —— 回归测试（假 CLI，绝不起真 claude）
 *
 * 现场（2026-09-17）：监督者借用的第三方供应商连续 5 家 fetch failed（域名 DNS 被污染、AIEngine 直连不走代理），
 * 任务两次卡在"监督者不可用，叫人"。改为经 claude CLI，跟随 CC Switch 当前配置。
 * 首次真实探针还发现：空目录挡不住用户级 CLAUDE.md，监督者会拿个人编码规矩判执行者。
 *
 * 运行: node tests/test-longrun-supervisor-cli.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { CliSupervisorClient, buildSupervisorArgs, parseCliResult, supervisorCwd } from '../server/services/LongRunSupervisorCli.js';
import { makeSupervisorChannel } from '../server/services/LongRunSupervisorCreds.js';

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
async function test(name, fn) {
  try { await fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lr_supcli_'));
// 假 CLI：把收到的参数、标准输入、环境、工作目录回写进 result，按 FAKE_MODE 模拟各种失败
const FAKE = path.join(TMP, 'fake-claude.mjs');
fs.writeFileSync(FAKE, `
let input = ''; process.stdin.on('data', (b) => { input += b; });
process.stdin.on('end', () => {
  const mode = process.env.FAKE_MODE || 'ok';
  if (mode === 'hang') return setTimeout(() => {}, 60000);
  if (mode === 'crash') { process.stderr.write('Invalid API key'); process.exit(1); }
  if (mode === 'garbage') { process.stdout.write('not json'); return; }
  const echo = { args: process.argv.slice(2), input, cwd: process.cwd(),
    env: { L: process.env.WEBTMUX_LONGRUN, MDS: process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, AM: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY,
      CC: process.env.CLAUDECODE ?? null, TMUX: process.env.TMUX ?? null } };
  const err = mode === 'is_error';
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: err, result: err ? 'API Error: 401' : JSON.stringify(echo),
    stop_reason: 'end_turn', total_cost_usd: 0.02, usage: { input_tokens: 2, cache_creation_input_tokens: 500, cache_read_input_tokens: 100, output_tokens: 9 } }));
});`);
const client = (mode, o = {}) => new CliSupervisorClient({ model: 'claude-opus-5', claudeBin: process.execPath, binPrefixArgs: [FAKE],
  env: { ...process.env, FAKE_MODE: mode, CLAUDECODE: '1', TMUX: '/tmp/tmux-1/default,1,0' }, ...o });
const rejects = async (p) => { try { await p; } catch (e) { return e.message; } throw new Error('应当失败却成功了'); };

await test('纯文本调用：替换系统提示词、不给工具、不加载 MCP、不写会话记录、JSON 输出；用户消息走标准输入', async () => {
  const r = await client('ok').complete('判定规则', '执行者说：做完了\n'.repeat(2000));
  const echo = JSON.parse(r.text);
  const a = echo.args;
  assert(a[0] === '-p' && a[a.indexOf('--model') + 1] === 'claude-opus-5' && a[a.indexOf('--system-prompt') + 1] === '判定规则', a.join(' '));
  assert(a[a.indexOf('--tools') + 1] === '' && a.includes('--strict-mcp-config') && a.includes('--no-session-persistence'), '工具/MCP/会话记录');
  assert(a[a.indexOf('--output-format') + 1] === 'json' && !a.some((x) => x.includes('执行者说')), '用户消息不能进命令行参数');
  assert(echo.input.length === '执行者说：做完了\n'.length * 2000, '标准输入要完整送达');
  assert(r.stopReason === 'end_turn' && r.inputTokens === 602 && r.outputTokens === 9, JSON.stringify(r));
});

await test('子进程环境：带长程头、关掉 CLAUDE.md 与自动记忆、清掉嵌套标记；在专用空目录里跑', async () => {
  const echo = JSON.parse((await client('ok').complete('s', 'u')).text);
  assert(echo.env.L === '1' && echo.env.MDS === '1' && echo.env.AM === '1', JSON.stringify(echo.env));
  assert(echo.env.CC === null && echo.env.TMUX === null, '嵌套标记没清');
  assert(fs.realpathSync(echo.cwd) === fs.realpathSync(supervisorCwd()), echo.cwd);
});

await test('失败都要抛出（交给监督者按调用失败叫人）：is_error、非零退出、非 JSON、超时', async () => {
  assert(/401/.test(await rejects(client('is_error').complete('s', 'u'))));
  assert(/退出码 1.*Invalid API key/.test(await rejects(client('crash').complete('s', 'u'))));
  assert(/不是 JSON/.test(await rejects(client('garbage').complete('s', 'u'))));
  assert(/超过 1 秒/.test(await rejects(client('hang', { timeoutMs: 1000 }).complete('s', 'u'))));
  assert(/无法启动/.test(await rejects(new CliSupervisorClient({ model: 'm', claudeBin: path.join(TMP, 'no-such-bin') }).complete('s', 'u'))));
});

await test('解析与参数纯函数：subtype 不是 success 也算失败', () => {
  assert(/调用失败/.test((() => { try { parseCliResult('{"subtype":"error_max_turns","is_error":false}'); } catch (e) { return e.message; } return ''; })()));
  assert(buildSupervisorArgs({ model: 'x', system: 'y' }).length === 12);
});

await test('通道选择：未选供应商走 CLI 并显示 CC Switch 当前配置；选了走 HTTP；选了但没密钥报不可用', async () => {
  const engine = { getSettings: () => ({ claude: {} }),
    resolveSessionSettings: (app, id) => (id === 'p1' ? { claude: { apiUrl: 'https://p1.example.com', apiKey: 'k' }, _providerName: 'P1' } : { claude: {} }),
    callClaudeMessages: async (o) => ({ text: o.config.apiUrl }) };
  const cli = makeSupervisorChannel({ engine, cliFactory: (m) => ({ complete: async () => ({ text: `cli:${m}` }) }) });
  assert(cli.info.via === 'cli' && cli.info.providerName === 'CC Switch 当前 Claude 配置' && /OAuth/.test(cli.info.baseUrl), JSON.stringify(cli.info));
  assert((await cli.complete('s', 'u')).text === 'cli:claude-opus-5');
  const http = makeSupervisorChannel({ engine, providerId: 'p1', cliFactory: () => { throw new Error('不该起 CLI'); } });
  assert(http.info.via === 'http' && (await http.complete('s', 'u')).text === 'https://p1.example.com');
  const none = makeSupervisorChannel({ engine, providerId: 'p2', cliFactory: () => { throw new Error('不该起 CLI'); } });
  assert(!none.complete && none.info.status === 'unavailable');
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

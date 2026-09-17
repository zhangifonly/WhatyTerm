/**
 * 监控 AI 跟随会话供应商 —— 回归测试
 *
 * 背景：监控 AI 原来只读全局 ai-settings.json 里那一个 _providerId，用户在 CC Switch
 * 里删了重建（ID 会变）后整条监控链就哑掉，日志只报「未找到 AI 监控供应商配置」，
 * 所有「交给 AI 判断」的分支退化成机械发「继续」。
 *
 * 本测试锁住三件事：
 *   1. resolveSessionSettings 能按会话供应商 ID 解析出可用的 HTTP 配置
 *   2. 官方 OAuth 供应商（env 为空）必须返回 null，让上层回退 CLI，而不是发注定 401 的请求
 *   3. settingsOverride 不污染全局 this.settings（多会话各用各的凭证）
 *
 * 运行：node tests/test-session-provider.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const results = { passed: 0, failed: 0, errors: [] };

function test(name, fn) {
  try {
    fn();
    results.passed++;
    console.log(`✅ ${name}`);
  } catch (err) {
    results.failed++;
    results.errors.push({ name, error: err.message });
    console.log(`❌ ${name}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    results.passed++;
    console.log(`✅ ${name}`);
  } catch (err) {
    results.failed++;
    results.errors.push({ name, error: err.message });
    console.log(`❌ ${name}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

const { AIEngine } = await import('../server/services/AIEngine.js');
const engine = new AIEngine();

function summary() {
  console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
  if (results.failed) {
    console.log('\n失败明细：');
    for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
  }
  process.exit(results.failed ? 1 : 0);
}

// ============ 从 CC Switch 真库里挑样本（无库则跳过对应用例） ============
const CC_DB = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
let withKey = null;   // 有 URL+key 的第三方供应商
let oauthOnly = null; // env 为空的官方登录供应商

if (fs.existsSync(CC_DB)) {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(CC_DB, { readonly: true });
  const rows = db.prepare("SELECT id, name, settings_config FROM providers WHERE app_type='claude'").all();
  db.close();
  for (const r of rows) {
    let env = {};
    try { env = JSON.parse(r.settings_config).env || {}; } catch { continue; }
    const full = env.ANTHROPIC_BASE_URL && env.ANTHROPIC_AUTH_TOKEN;
    if (full && !withKey) withKey = r;
    if (!full && !oauthOnly) oauthOnly = r;
  }
}

test('第三方供应商能解析出可用的 HTTP 配置', () => {
  if (!withKey) return console.log('   （跳过：CC Switch 无带凭证的 claude 供应商）');
  const r = engine.resolveSessionSettings('claude', withKey.id);
  assert(r, '解析结果为空');
  assert(r.apiType === 'claude', `apiType 应为 claude，实际 ${r.apiType}`);
  assert(/\/v1\/messages$/.test(r.claude.apiUrl), `apiUrl 未规范化到 /v1/messages: ${r.claude.apiUrl}`);
  assert(r.claude.apiKey.length > 0, 'apiKey 为空');
  assert(r._providerId === `claude:${withKey.id}`, '_providerId 未回填');
});

test('官方 OAuth 供应商返回 null（让上层回退 CLI，不发注定 401 的请求）', () => {
  if (!oauthOnly) return console.log('   （跳过：CC Switch 无 env 为空的 claude 供应商）');
  const r = engine.resolveSessionSettings('claude', oauthOnly.id);
  assert(r === null, `env 为空的供应商应返回 null，实际 ${JSON.stringify(r && r.claude)}`);
});

test('不存在的供应商 ID 返回 null，不抛异常', () => {
  const r = engine.resolveSessionSettings('claude', 'ffffffff-dead-beef-0000-000000000000');
  assert(r === null, '不存在的 ID 应返回 null');
});

test('入参缺失时返回 null', () => {
  assert(engine.resolveSessionSettings(null, 'x') === null, 'appType 缺失应返回 null');
  assert(engine.resolveSessionSettings('claude', null) === null, 'providerId 缺失应返回 null');
});

test('同一供应商重复解析命中缓存（避免每轮监控都读 SQLite）', () => {
  if (!withKey) return console.log('   （跳过：无样本）');
  const a = engine.resolveSessionSettings('claude', withKey.id);
  const b = engine.resolveSessionSettings('claude', withKey.id);
  assert(a === b, '重复解析应返回同一对象');
});

await testAsync('settingsOverride 不污染全局 settings（多会话隔离）', async () => {
  if (!withKey) return console.log('   （跳过：无样本）');
  const before = JSON.stringify(engine.getSettings().claude);
  const override = engine.resolveSessionSettings('claude', withKey.id);
  // 只走到 _callApi 的分发逻辑即可：拦掉真实网络请求，只看它取了哪份 config
  let usedUrl = null;
  const orig = engine._callClaudeApi;
  engine._callClaudeApi = async (_p, config) => { usedUrl = config.apiUrl; return 'ok'; };
  try {
    await engine._callApi('x', { settingsOverride: override });
  } finally {
    engine._callClaudeApi = orig;
  }
  assert(usedUrl === override.claude.apiUrl, `应使用会话配置，实际 ${usedUrl}`);
  assert(JSON.stringify(engine.getSettings().claude) === before, '全局 settings 被改动了');
});

// ============ AI 监控用 CC Switch 当前配置：claude -p 纯文本调用（2026-09-17） ============
// 借用第三方供应商实测 5 家全部 fetch failed（DNS 污染 + AIEngine 直连不走代理），用户要求改用当前配置。
test('三处 analyzeStatus 调用点都传了会话供应商，不再传借用优先级', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'server/index.js'), 'utf8');
  const sp = (src.match(/sessionProviderId:\s*getSessionProviderId/g) || []).length;
  assert(sp === 3, `sessionProviderId 应出现 3 次（三个调用点），实际 ${sp}`);
  assert(!/providerPriority:\s*CLAUDE_PROVIDER_PRIORITY/.test(src), '监控上下文里还在传借用优先级');
});

test('AIEngine 不再借用、轮换、拉黑第三方供应商，也不再走 4.3 万 tokens 的老 CLI 兜底', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'server/services/AIEngine.js'), 'utf8');
  for (const gone of ['getProxyMonitorSettings', 'blacklistProxyProvider', '_proxyLastGood', 'PROXY_MAX_ATTEMPTS', '_analyzeStatusViaCLI', 'CLI_FALLBACK_INTERVAL']) {
    assert(!src.includes(gone), `残留: ${gone}`);
  }
});

/** 让 analyzeStatus 必走 AI 分支，并把 claude -p 换成假客户端（绝不起真 claude） */
function aiOnlyEngine({ cliText = '{"needsAction":false,"currentState":"空闲，等待输入"}', cliError = null, codexText = null, codexError = null } = {}) {
  const e = new AIEngine();
  e.preAnalyzeStatus = () => null;
  e.cli = [];
  e.codex = [];
  e.codexTextFactory = () => ({ complete: async (system, user, opts = {}) => {
    e.codex.push({ system, user, schema: opts.jsonSchema });
    if (codexError || codexText == null) throw new Error(codexError || '未配置 codex 桩');
    return { text: codexText };
  } });
  e.cliTextFactory = (model) => ({ complete: async (system, user, opts = {}) => {
    e.cli.push({ model, system, user, schema: opts.jsonSchema });
    if (cliError) throw new Error(cliError);
    return { text: cliText };
  } });
  return e;
}

await testAsync('没有会话级供应商：经 claude -p 用 CC Switch 当前配置分析，模型取监控默认模型', async () => {
  const e = aiOnlyEngine();
  e._callApiWithFailover = async () => { throw new Error('不该走 HTTP'); };
  const r = await e.analyzeStatus('some screen', 'claude', 's1', null, { goal: 'x' });
  assert(r && r._source === 'claude_cli' && r.currentState === '空闲，等待输入', JSON.stringify(r));
  assert(e.cli.length === 1 && e.cli[0].model && e.cli[0].user.includes('some screen') && e.cli[0].system.length > 0, JSON.stringify(e.cli));
  const props = e.cli[0].schema?.properties || {};
  assert(props.confidence && props.actionType?.enum?.includes('select'), '要带与 HTTP 路径同一份 schema（含 confidence，非对称降级靠它）');
});

await testAsync('claude -p 报上来的 workingDir 若是 CLI 自己的临时目录，按"未显示"处理', async () => {
  const { cliTextCwd } = await import('../server/services/ClaudeCliText.js');
  const e = aiOnlyEngine({ cliText: JSON.stringify({ needsAction: false, actionType: 'none', currentState: '空闲', workingDir: cliTextCwd() }) });
  const r = await e.analyzeStatus('screen', 'claude', 's1', null, {});
  assert(r.workingDir === '未显示', r.workingDir);
  const real = aiOnlyEngine({ cliText: JSON.stringify({ needsAction: false, actionType: 'none', currentState: '空闲', workingDir: '/Users/x/proj' }) });
  assert((await real.analyzeStatus('screen', 'claude', 's1', null, {})).workingDir === '/Users/x/proj', '屏上读到的真实目录要保留');
});

await testAsync('会话明确选了带凭证的供应商：先用它；它调不通再退到 CC Switch 当前配置', async () => {
  const ok = aiOnlyEngine();
  ok.resolveSessionSettings = () => ({ claude: { apiUrl: 'https://p.example.com/v1/messages', apiKey: 'k' } });
  ok._callApiWithFailover = async () => '{"needsAction":false,"currentState":"会话供应商判定"}';
  const r1 = await ok.analyzeStatus('screen', 'claude', 's1', null, { sessionProviderId: 'claude:p' });
  assert(r1.currentState === '会话供应商判定' && ok.cli.length === 0, '会话供应商可用时不该起 claude -p');
  const bad = aiOnlyEngine();
  bad.resolveSessionSettings = () => ({ claude: { apiUrl: 'https://p.example.com/v1/messages', apiKey: 'k' } });
  bad._callApiWithFailover = async () => { throw new Error('fetch failed'); };
  const r2 = await bad.analyzeStatus('screen', 'claude', 's1', null, { sessionProviderId: 'claude:p' });
  assert(r2._source === 'claude_cli' && bad.cli.length === 1, JSON.stringify(r2));
});

await testAsync('codex 会话走 codex exec（~/.codex 的当前配置）；claude 会话不碰 codex', async () => {
  const e = aiOnlyEngine({ codexText: '{"needsAction":false,"actionType":"none","currentState":"codex 判定"}' });
  const r = await e.analyzeStatus('codex screen', 'codex', 's1', null, {});
  assert(r._source === 'codex_exec' && r.currentState === 'codex 判定' && e.cli.length === 0, JSON.stringify(r));
  assert(e.codex[0].user.includes('codex screen') && e.codex[0].schema?.properties?.confidence, '要带同一份状态 schema');
  const c = aiOnlyEngine({ codexText: '{"needsAction":false}' });
  await c.analyzeStatus('screen', 'claude', 's1', null, {});
  assert(c.codex.length === 0 && c.cli.length === 1, 'claude 会话不该起 codex');
});

await testAsync('codex exec 调不通：退到 claude -p，监控不停摆', async () => {
  const e = aiOnlyEngine({ codexError: 'codex exec 调用失败: 401' });
  const r = await e.analyzeStatus('screen', 'codex', 's1', null, {});
  assert(r._source === 'claude_cli' && e.codex.length === 1 && e.cli.length === 1, JSON.stringify(r));
});

await testAsync('codex exec 报上来的 workingDir 若是它的专用空目录，同样按"未显示"处理', async () => {
  const { codexTextCwd } = await import('../server/services/CodexExecText.js');
  const e = aiOnlyEngine({ codexText: JSON.stringify({ needsAction: false, actionType: 'none', currentState: '空闲', workingDir: codexTextCwd() }) });
  assert((await e.analyzeStatus('screen', 'codex', 's1', null, {})).workingDir === '未显示');
});

await testAsync('claude -p 失败要抛出（监控循环据此计失败），不静默返回空', async () => {
  const e = aiOnlyEngine({ cliError: 'claude CLI 退出码 1: 未登录' });
  let err = null;
  try { await e.analyzeStatus('screen', 'claude', 's1', null, {}); } catch (x) { err = x; }
  assert(err && /未登录/.test(err.message), err?.message);
});

test('getSessionProviderId 按 aiType 取对应字段（codex 会话不能误读 claudeProvider）', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'server/index.js'), 'utf8');
  const m = src.match(/function getSessionProviderId[\s\S]{0,400}?\n\}/);
  assert(m, '未找到 getSessionProviderId');
  for (const f of ['codexProvider', 'geminiProvider', 'grokProvider', 'claudeProvider']) {
    assert(m[0].includes(f), `未覆盖 ${f}`);
  }
});

test('_loadSettings 跳过 env 为空的 ProviderService 空壳', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'server/services/AIEngine.js'), 'utf8');
  assert(/currentProvider\s*&&\s*this\._parseProviderConfigFromService\(currentProvider\)/.test(src),
    '第 2 级未校验空壳供应商，会导致后续步骤全走空并误报"未找到供应商"');
  assert(/currentProviderClaude/.test(src),
    '缺少 2b 级：未跟随 CC Switch 当前供应商');
});


// ============ 供应商下拉切换必须只作用于当前会话（v1.3.8）============
// 老实现走 switchProviderStateMachine，那条路会 stripAnthropicEnv(~/.claude/settings.json)
// 清全局 env、tmuxSetEnv({scope:"-g"}) 写全局 tmux env、还 /quit + claude -c 重启 CLI。
// 于是「给会话 A 换供应商」把全局和其他会话一起带走 —— 与用户诉求正相反。
const SRV = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf-8');
const handlerBlock = (() => {
  const i = SRV.indexOf("socket.on('provider:switch'");
  if (i < 0) return '';
  const end = SRV.indexOf("socket.on('system:info'", i);
  return SRV.slice(i, end > i ? end : i + 8000);
})();

test('provider:switch 走 applySessionProvider，不走污染全局的状态机', () => {
  if (!handlerBlock) throw new Error('找不到 provider:switch handler');
  if (!/applySessionProvider\(session, type, providerId\)/.test(handlerBlock))
    throw new Error('未改走会话级 applySessionProvider');
  if (/switchProviderStateMachine\s*\(/.test(handlerBlock))
    throw new Error('仍在调用会污染全局的 switchProviderStateMachine');
});
test('handler 不碰全局 settings.json，也不写 -g 作用域的 tmux env', () => {
  if (/homedir\(\)[\s\S]{0,60}settings\.json/.test(handlerBlock))
    throw new Error('handler 触碰了全局 ~/.claude/settings.json');
  if (/scope:\s*'-g'/.test(handlerBlock))
    throw new Error('handler 写了全局作用域 tmux env');
});
test('applySessionProvider 本体只用会话级 tmux target，不用 -g', () => {
  const i = SRV.indexOf('function applySessionProvider');
  if (i < 0) throw new Error('找不到 applySessionProvider');
  const body = SRV.slice(i, i + 4200);
  if (/scope:\s*'-g'/.test(body)) throw new Error('applySessionProvider 写了全局 tmux env');
  if (!/tmuxSetEnv\(\{\s*target:/.test(body)) throw new Error('未使用会话级 target');
  if (/homedir\(\)[\s\S]{0,60}'\.claude',\s*'settings\.json'/.test(body))
    throw new Error('applySessionProvider 触碰了全局配置');
});
test('切换后如实告知是否需重启（Claude Code 启动时读一次配置、不热更新）', () => {
  if (!/needRestart/.test(handlerBlock)) throw new Error('未返回 needRestart，用户会误以为已生效');
  if (!/relay\\\//.test(handlerBlock) && !/relay\//.test(handlerBlock))
    throw new Error('未按「进程内是否已指向 relay」判断，无法区分首次设置与热切换');
});
test('切换后作废供应商实测缓存（否则面板显示切换前那家）', () => {
  if (!/session\.statusProbe = null/.test(handlerBlock))
    throw new Error('未清 statusProbe，面板会显示旧供应商');
  if (!/session\.effectiveEnv = null/.test(handlerBlock))
    throw new Error('未清 effectiveEnv');
});

// ============ 切换后自动重启 CLI（v1.3.9 找回 v1.3.8 丢失的行为）============
// 老下拉走 switchProviderStateMachine，切完会 Esc → /exit → 等 shell → export 新 env && claude -c。
// v1.3.8 改走 applySessionProvider 时漏了这一步，用户只能自己 /quit。现两条路径共用
// restartClaudeWithEnv 一份实现。
test('会话级切换在需要重启时自动调用 restartClaudeWithEnv', () => {
  if (!/if \(type === 'claude' && needRestart\)[\s\S]{0,300}restartClaudeWithEnv\(session, r\.providerEnv/.test(handlerBlock))
    throw new Error('handler 需要重启时没有自动重启，用户又得手动 /quit');
  if (!/restartResult/.test(handlerBlock)) throw new Error('未把重启结果回传前端');
});
test('状态机与会话级切换共用同一份重启实现（不再各写一份）', () => {
  if (!/await restartClaudeWithEnv\(session, localConfig\.env/.test(SRV)) throw new Error('状态机未改用共用函数');
  const exits = SRV.split('send-keys -t "${tmuxName}" "/exit"').length - 1;
  if (exits !== 1) throw new Error(`/exit 重启序列应只有 1 份实现，实际 ${exits} 份`);
});
test('重启命令经 tmuxSendLiteral 免 shell 发送，不再拼进 execSync 双引号', () => {
  const i = SRV.indexOf('async function restartClaudeWithEnv');
  const body = SRV.slice(i, SRV.indexOf('\nasync function waitForShellPrompt', i));
  if (body.includes('"${restartCmd}"')) throw new Error('仍把 restartCmd 拼进外层双引号，引号会互相翻转');
  if (!body.includes('tmuxSendLiteral(tmuxName, restartCmd)')) throw new Error('未改用 tmuxSendLiteral');
  const h0 = SRV.indexOf('function tmuxSendLiteral');
  const h = SRV.slice(h0, h0 + 600);
  if (!/spawnSync\(/.test(h) || !h.includes("'-l'")) throw new Error('tmuxSendLiteral 未用数组传参 + -l 字面量');
});
test('shellQuoteSq 经真实交互式 zsh/bash 回读逐字节一致（含 ! 历史展开）', () => {
  const src = SRV.slice(SRV.indexOf('function shellQuoteSq'));
  const shellQuoteSq = new Function(src.slice(0, src.indexOf('\n')) + '\nreturn shellQuoteSq;')();
  // 必须 stdin 喂**交互式** shell（-i）：! 历史展开只在交互输入里发生。
  // 实测用 -c 模式时，老的双引号转义方案在 ! 用例上也全绿——那样测等于没测。
  const cases = ['sk-a$HOME"b`id`c\\d e$(whoami)', 'sk-ab!cd!!ef', "sk-it's", 'http://127.0.0.1:3928/relay/x'];
  const shells = [['zsh', ['-f', '-i']], ['bash', ['--norc', '--noprofile', '-i']]];
  let ran = 0;
  for (const [sh, args] of shells) {
    for (const v of cases) {
      const r = spawnSync(sh, args, { input: `export X=${shellQuoteSq(v)}; printf '<<%s>>\\n' "$X"\nexit\n`, encoding: 'utf8' });
      if (r.error && r.error.code === 'ENOENT') break;   // 本机没装这个 shell
      ran++;
      const m = [...((r.stdout || '') + (r.stderr || '')).matchAll(/<<([\s\S]*?)>>/g)];
      const got = m.length ? m[m.length - 1][1] : '(命令未执行)';
      if (got !== v) throw new Error(`${sh} 回读不一致：期望 ${JSON.stringify(v)} 实际 ${JSON.stringify(got)}`);
    }
  }
  if (ran === 0) throw new Error('zsh/bash 都不可用，无法验证');
  if (!/export \$\{v\}=\$\{shellQuoteSq\(/.test(SRV)) throw new Error('restartClaudeWithEnv 未改用单引号字面量');
});

summary();


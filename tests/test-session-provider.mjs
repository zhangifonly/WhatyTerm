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

test('CLI 回退节流常量存在且不小于 1 分钟（CLI 单次约 4.3 万 tokens）', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'server/services/AIEngine.js'), 'utf8');
  const m = src.match(/CLI_FALLBACK_INTERVAL\s*=\s*([^;]+);/);
  assert(m, '未找到 CLI_FALLBACK_INTERVAL');
  // eslint-disable-next-line no-eval
  assert(eval(m[1]) >= 60000, `节流间隔过短: ${m[1]}`);
});

// ============ OAuth 会话借用代理供应商（实测 26 个会话里 25 个是 OAuth） ============
test('OAuth 会话能借到带凭证的代理监控供应商', () => {
  if (!withKey) return console.log('   （跳过：无带凭证样本）');
  const r = engine.getProxyMonitorSettings(['88codepaid', 'crs.whaty.org', 'FoxCode']);
  assert(r, '未挑到代理供应商——OAuth 会话会全部退到 CLI，成本不可接受');
  assert(r.claude.apiKey.length > 0, '代理供应商无 key');
  assert(/\/v1\/messages$/.test(r.claude.apiUrl), `apiUrl 未规范化: ${r.claude.apiUrl}`);
  assert(/代理监控/.test(r._providerName), '_providerName 应标注代理监控，便于排障时区分');
});

test('代理供应商按优先级挑选并缓存', () => {
  if (!withKey) return console.log('   （跳过：无带凭证样本）');
  const a = engine.getProxyMonitorSettings(['88codepaid']);
  const b = engine.getProxyMonitorSettings([]);
  assert(a === b, '应缓存，避免每轮监控重扫 CC Switch 全表');
});

test('三处 analyzeStatus 调用点都传了会话供应商与优先级', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'server/index.js'), 'utf8');
  const sp = (src.match(/sessionProviderId:\s*getSessionProviderId/g) || []).length;
  const pp = (src.match(/providerPriority:\s*CLAUDE_PROVIDER_PRIORITY/g) || []).length;
  assert(sp === 3, `sessionProviderId 应出现 3 次（三个调用点），实际 ${sp}`);
  assert(pp === 3, `providerPriority 应出现 3 次，实际 ${pp}`);
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

test('代理供应商失败可拉黑并换下一个（借来的才换，会话自己的不换）', () => {
  const proxy = engine.getProxyMonitorSettings([]);
  if (!proxy) return console.log('   （跳过：无带凭证供应商）');

  assert(proxy._isProxy === true, '代理供应商必须打 _isProxy 标记，否则轮换逻辑认不出来');
  const firstId = proxy._providerId;

  engine.blacklistProxyProvider(firstId, '模拟 502');
  const second = engine.getProxyMonitorSettings([]);
  if (second) {
    assert(second._providerId !== firstId, '拉黑后仍挑到同一个供应商，轮换无效');
    assert(second._isProxy === true, '换出来的也必须带 _isProxy');
  } else {
    assert(true, '只有一个可用供应商，拉黑后为空属正常');
  }
});

test('会话自己的供应商不带 _isProxy（不可被拉黑替换）', () => {
  if (!withKey) return console.log('   （跳过：无第三方供应商样本）');
  const cfg = engine.resolveSessionSettings('claude', withKey.id);
  if (!cfg) return console.log('   （跳过：样本无法解析）');
  assert(!cfg._isProxy, '会话指定的供应商被标成代理，会导致偷偷换用别人的账号');
});

test('analyzeStatus 对代理供应商做有限次轮换后才回退 CLI', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'server/services/AIEngine.js'), 'utf8');
  assert(/PROXY_MAX_ATTEMPTS\s*=\s*[1-9]/.test(src), '缺少代理重试次数上限');
  assert(/PROXY_BLACKLIST_TTL\s*=\s*\d+\s*\*\s*60\s*\*\s*1000/.test(src), '缺少代理拉黑时长');
  assert(/isProxy\s*\?\s*PROXY_MAX_ATTEMPTS\s*:\s*1/.test(src),
    '未区分代理与会话供应商的重试次数：会话自己的供应商不该被轮换');
  assert(/blacklistProxyProvider\([^)]*_providerId/.test(src), '失败后未拉黑当前代理供应商');
});

test('代理选择优先用"上次真的调通过"的那个（静态优先级名单里的可能全挂）', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'server/services/AIEngine.js'), 'utf8');
  assert(/_proxyLastGood/.test(src), '缺少"上次成功的代理"记录');
  // 顺序必须是 lastGood → 优先级名单 → 第一个
  const pick = src.match(/getProxyMonitorSettings[\s\S]{0,2000}?picked = usable\[0\]/);
  assert(pick, '未找到代理挑选逻辑');
  const iLast = pick[0].indexOf('_proxyLastGood');
  const iPrio = pick[0].indexOf('of priority');
  assert(iLast > -1 && iPrio > -1 && iLast < iPrio,
    '"上次成功的代理"必须排在静态优先级名单之前，否则重试预算全浪费在必挂的选项上');
  assert(/_proxyLastGood\s*===\s*providerKey/.test(src),
    '拉黑时未清除 _proxyLastGood，会一直挑已死的供应商');

  // 运行时验证：拉黑后 lastGood 被清掉
  const e = new AIEngine();
  e._proxyLastGood = 'claude:fake-good';
  e.blacklistProxyProvider('claude:fake-good', '模拟失效');
  assert(e._proxyLastGood === null, '拉黑后 _proxyLastGood 未清空');
});

summary();


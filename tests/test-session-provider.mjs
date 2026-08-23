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

test('_loadSettings 跳过 env 为空的 ProviderService 空壳', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'server/services/AIEngine.js'), 'utf8');
  assert(/currentProvider\s*&&\s*this\._parseProviderConfigFromService\(currentProvider\)/.test(src),
    '第 2 级未校验空壳供应商，会导致后续步骤全走空并误报"未找到供应商"');
  assert(/currentProviderClaude/.test(src),
    '缺少 2b 级：未跟随 CC Switch 当前供应商');
});

summary();


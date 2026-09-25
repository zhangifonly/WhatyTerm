/**
 * 删除会话级 relay（v1.4.55）。
 *
 * 由来：v1.2.26 起会话级切换供应商写的是 `http://127.0.0.1:3928/relay/<会话id>` + 占位密钥，由 WebTmux 转发。
 * 用户 2026-09-17 明确说「这种relay的方式非常不可取，下次不能用」，当时只把几个会话的配置改回去，
 * 生成 relay 的代码没删；2026-09-25 从面板给 WebOffice 切到 Whaty，又写出了 relay（用户 /status 截图发现）。
 * 这次整体删除：切换改为直连写 settings.local.json（Claude Code 热加载），旧配置启动时迁走。
 *
 * 运行: node tests/test-relay-removal.mjs
 */

import fs from 'fs';
import { sessionClaudeEnv, relayMigrationPlan, isLegacyRelayConfig, CLAUDE_ENV_KEYS, OAUTH_PROVIDER_INFO }
  from '../server/services/sessionProviderEnv.js';

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
const queue = [];
/** 测试先入队、最后依次 await：有 async 测试，同步 test() 会在它断言之前就记成通过 */
const test = (name, fn) => queue.push([name, fn]);
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

test('供应商 → 四个 env：真实值原样，没有的写 ""（热加载时删键清不掉进程里的旧值）', () => {
  const e = sessionClaudeEnv({ env: { ANTHROPIC_BASE_URL: 'https://zjz.example.com', ANTHROPIC_AUTH_TOKEN: 'sk-1' } });
  assert(JSON.stringify(e) === JSON.stringify({ ANTHROPIC_BASE_URL: 'https://zjz.example.com', ANTHROPIC_AUTH_TOKEN: 'sk-1',
    ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: '' }), JSON.stringify(e));
  const o = sessionClaudeEnv(OAUTH_PROVIDER_INFO);
  assert(CLAUDE_ENV_KEYS.every((k) => o[k] === ''), '官方登录四个键都要是 ""');
  assert(sessionClaudeEnv({ isOAuth: true, env: { ANTHROPIC_BASE_URL: 'x' } }).ANTHROPIC_BASE_URL === '', 'OAuth 不能带出地址');
});

const RELAY = 'http://127.0.0.1:3928/relay/sid-1';
const MAP = { 'sid-1': { providerId: 'from-map' } };
const full = (over = {}) => ({ ANTHROPIC_BASE_URL: 'https://x', ANTHROPIC_AUTH_TOKEN: 'sk', ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: '', ...over });

test('迁移判定：项目配置是 relay → 按配置钉住的供应商直连；配置没钉 id 时用旧映射里的', () => {
  const p = relayMigrationPlan({ env: { ANTHROPIC_BASE_URL: RELAY }, _localProvider: 'relay-proxy', _localProviderId: 'p1' }, RELAY, MAP, 'sid-1');
  assert(p.action === 'provider' && p.providerId === 'p1', JSON.stringify(p));
  const q = relayMigrationPlan({ env: { ANTHROPIC_BASE_URL: RELAY } }, '', MAP, 'sid-1');
  assert(q.action === 'provider' && q.providerId === 'from-map', JSON.stringify(q));
  const lost = relayMigrationPlan({ env: { ANTHROPIC_BASE_URL: RELAY } }, '', {}, 'sid-1');
  assert(lost.action === 'unknown', '供应商无从得知时不能乱选');
});

test('迁移判定：配置已改回官方登录、CLI 仍以 relay 环境在跑（实测 phyviz）→ 写空值覆盖进程里的 relay', () => {
  const p = relayMigrationPlan({ env: {}, _localProvider: 'oauth' }, RELAY, MAP, 'sid-1');
  assert(p.action === 'oauth', `${JSON.stringify(p)} —— 不能按旧映射把它切回 Whaty，配置的意图是官方登录`);
});

test('迁移判定：配置已显式写出四个键 → 启动环境是 relay 也不用再迁（ps 永远读到启动时的环境）', () => {
  assert(relayMigrationPlan({ env: full(), _localProvider: 'session', _localProviderId: 'p1' }, RELAY, MAP, 'sid-1').action === 'none',
    '已直连的会话每次启动都会被重复迁移');
  const partial = relayMigrationPlan({ env: { ANTHROPIC_BASE_URL: 'https://x' }, _localProvider: 'session', _localProviderId: 'p1' }, RELAY, MAP, 'sid-1');
  assert(partial.action === 'provider' && partial.providerId === 'p1', '缺键时进程里的 relay 值还会生效，要重写');
});

test('迁移判定：跟随全局的配置、进程却在 relay 上 → 不猜，只报出来；与 relay 无关的会话不动', () => {
  assert(relayMigrationPlan({}, RELAY, MAP, 'sid-1').action === 'unknown', '跟随全局的会话不能被旧映射钉到某家供应商');
  assert(relayMigrationPlan({ env: full() }, 'https://x', MAP, 'sid-1').action === 'none');
  assert(relayMigrationPlan({}, '', {}, 'sid-9').action === 'none');
  assert(isLegacyRelayConfig({ _localProvider: 'relay-proxy' }) && !isLegacyRelayConfig({ env: { ANTHROPIC_BASE_URL: 'https://api.example.com/relay/x' } }),
    '只认本机 127.0.0.1 的 relay 形态，第三方地址里带 relay 字样的不算');
});

const SRV = stripComments(read('../server/index.js'));
test('守卫：relay 不能回到代码里（不生成 relay 地址、不注册转发路由、没有转发实现）', () => {
  assert(!fs.existsSync(new URL('../server/services/SessionRelay.js', import.meta.url)), 'SessionRelay.js 还在');
  assert(!/app\.use\(\s*['"]\/relay/.test(SRV), '还注册着 /relay 转发路由');
  assert(!/sessionRelay|SessionRelay/.test(SRV), 'index.js 还在用转发实现');
  assert(!/webtmux-relay-\$\{|\/relay\/\$\{/.test(SRV), 'index.js 还在拼 relay 地址/占位密钥');
  assert(!/relay-proxy'\s*;/.test(SRV.replace(/isLegacyRelayConfig[\s\S]{0,80}/g, '')), "还在写 _localProvider = 'relay-proxy'");
});

test('接线：两条启动路径都跑迁移；有迁不动的就保留旧映射文件（人工处理时要用）', () => {
  assert((SRV.match(/migrateSessionsOffRelay\(\)\.catch/g) || []).length === 2, 'SessionManager 正常/回退两条启动路径都要迁移');
  const fn = SRV.slice(SRV.indexOf('async function migrateSessionsOffRelay'));
  assert(/report\.every\(\(x\) => x\.ok\)[\s\S]{0,80}unlinkSync\(mapFile\)/.test(fn), '旧映射文件（含真实密钥）要在全部迁移成功后才删');
  assert(/applySessionProviderInfo\(session, 'claude', OAUTH_PROVIDER_INFO\)/.test(fn), '官方登录的迁移没走共用写入');
});

test('/status 快照：配置在快照之后改过就作废（热加载让「同一进程配置不变」不再成立，实测 phyviz）', async () => {
  const os = await import('os'); const path = await import('path');
  const src = read('../server/index.js');
  const m = src.match(/function settingsChangedSince\(workingDir, ts\) \{[\s\S]*?\n\}\n/);
  assert(m, '找不到 settingsChangedSince');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-home-'));
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-wd-'));
  fs.mkdirSync(path.join(wd, '.claude')); fs.mkdirSync(path.join(home, '.claude'));
  const fakeOs = { homedir: () => home };
  const fn = new Function('path', 'os', 'statSync', `${m[0]}; return settingsChangedSince;`)(path.default, fakeOs, fs.statSync);
  const t0 = Date.now() - 60000;
  assert(fn(wd, t0) === false, '没有配置文件时不算改过');
  fs.writeFileSync(path.join(wd, '.claude', 'settings.local.json'), '{}');
  assert(fn(wd, t0) === true, '项目配置在快照后写过，快照应作废');
  assert(fn(wd, Date.now() + 60000) === false, '快照晚于配置时仍有效');
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');
  assert(fn(null, t0) === true, '全局配置改过也要作废');
  const SRC = stripComments(src);
  assert(/if \(sp && !spDeadProc && !spConfigChanged && /.test(SRC), '快照有效判据没用上配置改动');
  const inner = SRC.slice(SRC.indexOf('function applySessionProviderInfo'));
  assert(/session\.statusProbe = null;\s*session\.effectiveEnv = null;/.test(inner.slice(0, inner.indexOf('\n}\n'))),
    '写入会话供应商后没清实测缓存（迁移、转回终端这些路径不经切换 handler）');
});

test('进程启动环境：settings 显式写了 ""（官方登录）就不再拿启动环境当实测（实测 phyviz 面板一直显示 relay）', async () => {
  const os = await import('os'); const path = await import('path');
  const src = read('../server/index.js');
  const m = src.match(/function settingsDefinesKey\(workingDir, key\) \{[\s\S]*?\n\}\n/);
  assert(m, '找不到 settingsDefinesKey');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-home2-'));
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-wd2-'));
  fs.mkdirSync(path.join(wd, '.claude')); fs.mkdirSync(path.join(home, '.claude'));
  const fn = new Function('path', 'os', 'readFileSync', `${m[0]}; return settingsDefinesKey;`)(path.default, { homedir: () => home }, fs.readFileSync);
  const K = 'ANTHROPIC_BASE_URL';
  assert(fn(wd, K) === false, '都没有配置时应为 false（进程 env 才是唯一线索）');
  fs.writeFileSync(path.join(wd, '.claude', 'settings.local.json'), JSON.stringify({ env: { [K]: '' } }));
  assert(fn(wd, K) === true, '显式写 "" 也算写了 —— 它会覆盖进程启动环境');
  fs.writeFileSync(path.join(wd, '.claude', 'settings.local.json'), JSON.stringify({ env: {} }));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: { [K]: 'https://x' } }));
  assert(fn(wd, K) === true, '全局写了也算');
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{坏 json');
  assert(fn(wd, K) === false, '坏文件按没写处理，不抛');
  const SRC = stripComments(src);
  assert(/else if \(!actualApiUrl && !settingsDefinesKey\(workingDir, 'ANTHROPIC_BASE_URL'\)\)/.test(SRC), '回退进程 env 的分支没检查 settings 是否显式写了');
});

for (const [name, fn] of queue) {
  try { await fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}
console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

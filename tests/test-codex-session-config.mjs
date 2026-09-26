/**
 * 会话级切换 Codex 供应商：密钥写进 codex 真正读的位置；启动不连共享后台服务；续接按当前供应商。
 *
 * 由来（2026-09-26）：切到 crs.whaty.org 后一律 401 —— 密钥在 auth.json，自定义供应商不读它；
 * 共享后台服务按自己启动时的配置发请求，接回旧对话还沿用记录里的 openai → 发到 api.openai.com。
 *
 * 运行: node tests/test-codex-session-config.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { spawn } from 'child_process';
import { withBearerToken, topProvider, codexStartCommand, tomlString } from '../server/services/codexSessionConfig.js';

let pass = 0, fail = 0;
const queue = [];
const test = (name, fn) => queue.push([name, fn]);
const assert = (c, m) => { if (!c) throw new Error(m || '断言失败'); };

// CC Switch 里 crs.whaty.org 供应商的 config 形态（密钥不在这里，在 auth.OPENAI_API_KEY）
const CCS = `model_provider = "custom"
model = "gpt-6-sol"

[model_providers.custom]
name = "custom"
wire_api = "responses"
requires_openai_auth = false
base_url = "https://crs.example.org"

[projects."/x"]
trust_level = "trusted"
`;

test('密钥注入到当前供应商表内（不跑到下一张表），其他内容原样保留', () => {
  const r = withBearerToken(CCS, 'sk-abc');
  assert(r.injected, r.reason);
  const custom = r.toml.slice(r.toml.indexOf('[model_providers.custom]'), r.toml.indexOf('[projects.'));
  assert(/experimental_bearer_token = "sk-abc"/.test(custom), '没写进 custom 表');
  assert(!/experimental_bearer_token/.test(r.toml.slice(r.toml.indexOf('[projects.'))), '写到了别的表里');
  assert(r.toml.replace(/experimental_bearer_token = "sk-abc"\n/, '') === CCS, '改动了其他内容');
});

test('不该注入的情形都不动：已有密钥 / 官方 openai / 要求 OpenAI 登录 / 没有密钥 / 找不到供应商表', () => {
  const hand = CCS.replace('base_url = "https://crs.example.org"', 'base_url = "https://crs.example.org"\nexperimental_bearer_token = "sk-hand"');
  assert(withBearerToken(hand, 'sk-new').toml === hand, '覆盖了手工配好的密钥');
  assert(!withBearerToken('model = "gpt-6"\n', 'sk').injected, '官方 openai 读 auth.json，不该注入');
  // 显式写了 model_provider = "openai"、而且恰好有同名供应商表：也不注入（官方登录的 token 在 auth.json）
  const official = 'model_provider = "openai"\n\n[model_providers.openai]\nname = "openai"\nbase_url = "https://api.openai.com/v1"\n';
  assert(!withBearerToken(official, 'sk').injected, '官方供应商被写进了 API key');
  assert(!withBearerToken(CCS.replace('requires_openai_auth = false', 'requires_openai_auth = true'), 'sk').injected);
  assert(!withBearerToken(CCS, '').injected);
  assert(!withBearerToken('model_provider = "x"\n', 'sk').injected);
});

test('顶层供应商只认第一张表之前的 model_provider；TOML 字符串转义', () => {
  assert(topProvider(CCS) === 'custom' && topProvider('model = "a"\n[t]\nmodel_provider = "z"') === 'openai');
  assert(tomlString('a"b\\c') === '"a\\"b\\\\c"');
});

test('启动命令：不连共享后台服务；续接带当前供应商；供应商名不安全就不拼进 shell', () => {
  assert(codexStartCommand({}) === 'codex --no-daemon');
  assert(codexStartCommand({ codexProvider: { providerKey: 'custom' } }, { resume: true }) === `codex --no-daemon resume --last -c 'model_provider="custom"'`);
  assert(codexStartCommand({ codexProvider: { providerKey: "x'; rm -rf ~ #" } }, { resume: true }) === 'codex --no-daemon resume --last');
});

/** 本地假供应商：记下请求带没带密钥 */
function fakeProvider() {
  const hits = [];
  const srv = http.createServer((q, r) => { hits.push(q.headers.authorization || ''); r.writeHead(401); r.end('{"code":"probe"}'); });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res({ hits, port: srv.address().port, close: () => srv.close() })));
}

test('真实 codex：注入后的配置能被 codex 解析，请求带上了密钥、打到会话自己的地址', async () => {
  const fp = await fakeProvider();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cfg-'));
  fs.writeFileSync(path.join(home, 'config.toml'), withBearerToken(CCS.replace('https://crs.example.org', `http://127.0.0.1:${fp.port}`), 'sk-probe-123').toml);
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-probe-123' }));
  const env = { ...process.env, CODEX_HOME: home, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' };
  delete env.CODEX_API_KEY;
  await new Promise((res) => {
    const p = spawn('codex', ['exec', '--skip-git-repo-check', 'ok'], { cwd: os.tmpdir(), env, stdio: ['ignore', 'ignore', 'ignore'] });
    const t = setTimeout(() => p.kill('SIGKILL'), 25000);
    p.on('exit', () => { clearTimeout(t); res(); });
  });
  fp.close();
  // codex 被杀后它的后台线程可能还在往 CODEX_HOME 写数据库，删目录偶尔撞上 ENOTEMPTY：清理失败不影响结论
  try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 临时目录，系统会清 */ }
  assert(fp.hits.length > 0, '请求没打到会话配置的地址');
  assert(fp.hits.every((h) => h === 'Bearer sk-probe-123'), `请求没带对密钥：${JSON.stringify(fp.hits.slice(0, 2))}`);
});

const IDX = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
test('接线：写会话配置时注入密钥并记下供应商名；切换后当场测试，失败就报错不说完成；各启动入口不连后台服务', () => {
  const at = IDX.indexOf('// 会话专属 CODEX_HOME');
  const block = IDX.slice(at, at + 1600);
  assert(/withBearerToken\(sc\.config \|\| '', apiKey\)/.test(block) && /tokenized\.toml/.test(block), '会话配置没注入密钥');
  assert(/providerKey: topProvider\(sc\.config \|\| ''\)/.test(block), '没记下供应商名，续接无法按当前供应商');
  assert(/chmodSync\(cfgPath, 0o600\)/.test(block), '已有配置文件不会被改成仅自己可读（writeFileSync 的 mode 只对新文件生效）');
  assert(/session\.codexProvider = \{ \.\.\.snap, providerKey:/.test(IDX), '切换后落库的快照丢了 providerKey');
  assert(/const check = await verifyCodexHome\(r\.providerEnv\.CODEX_HOME\);\s*if \(!check\.ok\) \{[\s\S]{0,200}provider:switchError[\s\S]{0,200}return;/.test(IDX), '切换后没验证或失败仍报完成');
  const reg = fs.readFileSync(new URL('../server/services/CliRegistry.js', import.meta.url), 'utf8');
  assert(/start: 'codex --no-daemon resume --last'/.test(reg), '注册表的 codex 启动命令还会连后台服务');
  const ai = fs.readFileSync(new URL('../server/services/AIEngine.js', import.meta.url), 'utf8');
  assert(/'codex': 'codex --no-daemon resume --last'/.test(ai), '退回 shell 后的重启命令还会连后台服务');
  const sm = fs.readFileSync(new URL('../server/services/SessionManager.js', import.meta.url), 'utf8');
  assert(/if \(item\.aiType === 'codex'\) startCmd = codexStartCommand\(item, \{ resume: true \}\)/.test(sm), '重建会话续接没按当前供应商');
});

for (const [name, fn] of queue) {
  try { await fn(); pass++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n    ${e.message}`); }
}
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);

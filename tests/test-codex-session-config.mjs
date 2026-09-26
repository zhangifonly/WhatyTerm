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
import { spawn, spawnSync } from 'child_process';
import { withBearerToken, topProvider, codexStartCommand, tomlString, sessionCodexHome, linkSharedCodexEntries } from '../server/services/codexSessionConfig.js';

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
  const no = { exists: () => false };
  assert(codexStartCommand({}, no) === 'codex --no-daemon');
  assert(codexStartCommand({ codexProvider: { providerKey: 'custom' } }, { resume: true, ...no }) === `codex --no-daemon resume --last -c 'model_provider="custom"'`);
  assert(codexStartCommand({ codexProvider: { providerKey: "x'; rm -rf ~ #" } }, { resume: true, ...no }) === 'codex --no-daemon resume --last');
});

test('会话选过供应商：命令里显式带上会话的 CODEX_HOME（tmux 环境对已在跑的 shell 无效）；没选过就跟随全局', () => {
  const S = { id: 'a819fe6d-28a2-4118-8821-b33c098e7620', codexProvider: { providerKey: 'custom' } };
  const dir = sessionCodexHome(S.id, '/h');
  const cmd = codexStartCommand(S, { resume: true, home: '/h', exists: (p) => p === `${dir}/config.toml` });
  assert(cmd === `CODEX_HOME='${dir}' codex --no-daemon resume --last -c 'model_provider="custom"'`, cmd);
  assert(codexStartCommand(S, { home: '/h', exists: () => false }) === `codex --no-daemon -c 'model_provider="custom"'`, '没有会话配置时不该带 CODEX_HOME');
  assert(!codexStartCommand({ id: 'x;rm -rf ~' }, { exists: () => true }).includes('CODEX_HOME'), '非法会话 id 拼进了命令');
});

test('真实 shell：环境里没有 CODEX_HOME 的 shell 执行这条命令，codex 读到的是会话配置', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-cmd-'));
  const id = 'probe-session-1';
  const dir = sessionCodexHome(id, home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.toml'), 'model_provider = "probe"\nmodel = "probe-model-from-session"\n[model_providers.probe]\nname = "probe"\nwire_api = "responses"\nbase_url = "http://127.0.0.1:9"\n');
  const cmd = codexStartCommand({ id }, { home }).replace('codex --no-daemon', 'codex exec --skip-git-repo-check ok');
  const env = { ...process.env }; delete env.CODEX_HOME;
  const r = spawnSync('/bin/zsh', ['-c', `${cmd} < /dev/null 2>&1 | head -12`], { env, timeout: 20000, encoding: 'utf8' });
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  assert(/model: probe-model-from-session/.test(r.stdout), `codex 没读会话配置：${String(r.stdout).split('\n').filter((l) => /^model:|^provider:/.test(l)).join(' | ')}`);
});

test('共用数据：对话记录等链接到全局；会话目录里已有的真实文件不动；重复调用不重建；指向别处的旧链接改正', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-link-'));
  const g = path.join(root, 'global'), h = path.join(root, 'home');
  fs.mkdirSync(path.join(g, 'sessions'), { recursive: true }); fs.mkdirSync(path.join(g, 'rules')); fs.writeFileSync(path.join(g, 'history.jsonl'), '');
  fs.mkdirSync(h); fs.mkdirSync(path.join(h, 'rules'));                  // 会话目录里已有真实的 rules
  fs.symlinkSync('/nowhere', path.join(h, 'history.jsonl'));             // 指向别处的旧链接
  const r1 = linkSharedCodexEntries(h, g);
  assert(fs.readlinkSync(path.join(h, 'sessions')) === path.join(g, 'sessions'), '对话记录没链接到全局');
  assert(fs.readlinkSync(path.join(h, 'history.jsonl')) === path.join(g, 'history.jsonl'), '旧链接没改正');
  assert(!fs.lstatSync(path.join(h, 'rules')).isSymbolicLink() && r1.kept.includes('rules'), '覆盖了会话目录里的真实文件');
  assert(!fs.existsSync(path.join(h, 'skills')), '全局没有的项不该建链接');
  assert(linkSharedCodexEntries(h, g).linked.length === 0, '重复调用又重建了链接');
  fs.rmSync(root, { recursive: true, force: true });
});

test('真实 codex：会话 CODEX_HOME 链接了全局对话记录后，resume 能找到原来的对话（不链接则找不到）', () => {
  const sessions = path.join(os.homedir(), '.codex', 'sessions');
  const recent = spawnSync('/bin/zsh', ['-c', `ls -t ${sessions}/2026/*/*/rollout-*.jsonl 2>/dev/null | head -1`], { encoding: 'utf8' }).stdout.trim();
  if (!recent) { console.log('   （本机没有 Codex 对话记录，跳过）'); return; }
  const id = recent.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/)[1];
  const probe = (link) => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-resume-'));
    fs.writeFileSync(path.join(h, 'config.toml'), 'model = "gpt-6-sol"\n');
    if (link) linkSharedCodexEntries(h);
    // exec resume：找不到对话会立即报 No saved session；找到了就会往下走（连不上供应商也无所谓，限时结束）
    const r = spawnSync('codex', ['exec', '--skip-git-repo-check', 'resume', id, 'ok'], { env: { ...process.env, CODEX_HOME: h }, input: '', timeout: 8000, encoding: 'utf8', cwd: os.tmpdir() });
    fs.rmSync(h, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    return !/No saved session|no rollout found|not found/i.test(`${r.stdout}${r.stderr}`);
  };
  assert(probe(true), '链接后仍找不到原来的对话');
  assert(!probe(false), '不链接也能找到 —— 测试没测到东西');
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
  // 切出整个 codex 分支（到下一个 gemini 分支为止），不用固定字符窗口 —— 分支里加几行就会把断言挤出窗口
  const at = IDX.indexOf('// 会话专属 CODEX_HOME');
  const end = IDX.indexOf("} else if (appType === 'gemini') {", at);
  assert(at > 0 && end > at, '找不到会话级 codex 写入分支');
  const block = IDX.slice(at, end);
  assert(/withBearerToken\(sc\.config \|\| '', apiKey\)/.test(block) && /tokenized\.toml/.test(block), '会话配置没注入密钥');
  assert(/providerKey: topProvider\(sc\.config \|\| ''\)/.test(block), '没记下供应商名，续接无法按当前供应商');
  assert(/linkSharedCodexEntries\(codexHome\)/.test(block), '会话 CODEX_HOME 没链接全局对话记录，换供应商后接不回原对话');
  assert(/chmodSync\(cfgPath, 0o600\)/.test(block), '已有配置文件不会被改成仅自己可读（writeFileSync 的 mode 只对新文件生效）');
  assert(/session\.codexProvider = \{ \.\.\.snap, providerKey:/.test(IDX), '切换后落库的快照丢了 providerKey');
  assert(/const check = await verifyCodexHome\(r\.providerEnv\.CODEX_HOME\);\s*if \(!check\.ok\) \{[\s\S]{0,200}provider:switchError[\s\S]{0,200}return;/.test(IDX), '切换后没验证或失败仍报完成');
  const reg = fs.readFileSync(new URL('../server/services/CliRegistry.js', import.meta.url), 'utf8');
  assert(/start: 'codex --no-daemon resume --last'/.test(reg), '注册表的 codex 启动命令还会连后台服务');
  const ai = fs.readFileSync(new URL('../server/services/AIEngine.js', import.meta.url), 'utf8');
  assert(/'codex': 'codex --no-daemon resume --last'/.test(ai), '退回 shell 后的重启命令还会连后台服务');
  const sm = fs.readFileSync(new URL('../server/services/SessionManager.js', import.meta.url), 'utf8');
  assert(/if \(item\.aiType === 'codex'\) startCmd = codexStartCommand\(item, \{ resume: true \}\)/.test(sm), '重建会话续接没按当前供应商');
  assert(/id: row\.id,\s*\/\/ Codex 续接要找会话专属 CODEX_HOME/.test(sm), '重建续接没带会话 id，找不到会话配置');
  const send = IDX.slice(IDX.indexOf('function sendTextWithLanding'), IDX.indexOf('function autoActionBlockReason'));
  assert(/session\.aiType === 'codex'\) \{\s*text = codexStartCommand\(session/.test(send), '监控重启 codex 的命令没换成带会话配置的');
});

for (const [name, fn] of queue) {
  try { await fn(); pass++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n    ${e.message}`); }
}
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);

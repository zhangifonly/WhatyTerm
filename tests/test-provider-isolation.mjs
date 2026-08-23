#!/usr/bin/env node
/**
 * 会话级 API 供应商隔离回归测试（v1.2.58）
 *
 * 覆盖三件事：
 *  1. readLocalProviderConfig 的空壳判据（空壳 → 跟随全局；有内容 → 钉住）
 *  2. POST /api/claude-code/config 走 applySessionProvider 后本地文件的形态
 *  3. 外部 CC Switch 切换（改 ~/.claude/settings.json）后本地配置不被覆盖
 *
 * 全部在临时目录里跑，不碰真实项目与真实 ~/.claude。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

let pass = 0, fail = 0;
const results = [];

function check(name, ok, detail = '') {
  if (ok) { pass++; results.push(`  ✓ ${name}`); }
  else { fail++; results.push(`  ✗ ${name}${detail ? '  → ' + detail : ''}`); }
}

// ── 被测函数：从 server/index.js 原样抽取，保证测的是真实实现 ──────────────
const src = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
const fnMatch = src.match(/function readLocalProviderConfig\(workingDir\) \{[\s\S]*?\n\}/);
if (!fnMatch) {
  console.error('✗ 未能从 server/index.js 抽取 readLocalProviderConfig');
  process.exit(1);
}
const { existsSync, readFileSync } = fs;
const readLocalProviderConfig = new Function(
  'path', 'existsSync', 'readFileSync',
  `${fnMatch[0]}; return readLocalProviderConfig;`
)(path, existsSync, readFileSync);

// ── 测试夹具 ────────────────────────────────────────────────────────────
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webtmux-provider-'));
function makeProject(name, localConfig) {
  const wd = path.join(tmpRoot, name);
  fs.mkdirSync(path.join(wd, '.claude'), { recursive: true });
  if (localConfig !== undefined) {
    fs.writeFileSync(
      path.join(wd, '.claude', 'settings.local.json'),
      JSON.stringify(localConfig, null, 2)
    );
  }
  return wd;
}

// ══ 组 1：空壳判据 ═══════════════════════════════════════════════════════
console.log('\n【组 1】readLocalProviderConfig 空壳判据');

// 1a 完全没有本地文件 → 跟随全局
check('无 settings.local.json → 跟随全局',
  readLocalProviderConfig(makeProject('p-none', undefined)) === null);

// 1b 只有 permissions/model（历史遗留，如 MBTIWriter/StellarForge）→ 跟随全局
check('只有 permissions/model → 跟随全局',
  readLocalProviderConfig(makeProject('p-perm', {
    permissions: { allow: ['Bash'] }, model: 'opus'
  })) === null);

// 1c _localProvider=relay 但 env 空（历史被 delete ls.env 抹过，如 ChemAIForge）→ 跟随全局
check('标记 relay 但 env 空（空壳）→ 跟随全局',
  readLocalProviderConfig(makeProject('p-shell-relay', {
    permissions: {}, model: 'opus', _localProvider: 'relay', env: {}
  })) === null);

// 1d _localProvider=relay 且连 env 键都没了（如 phyviz/tableCard）→ 跟随全局
check('标记 relay 且无 env 键（空壳）→ 跟随全局',
  readLocalProviderConfig(makeProject('p-shell-noenv', {
    permissions: {}, model: 'opus', _localProvider: 'relay'
  })) === null);

// 1e 明确标记官方 OAuth（如 mathviz）→ 有效，且 isOAuth=true
{
  const r = readLocalProviderConfig(makeProject('p-oauth', {
    _localProvider: 'oauth', env: {}, model: 'sonnet'
  }));
  check('标记 oauth → 本地生效且 isOAuth', !!r && r.isOAuth === true && r.url === '',
    JSON.stringify(r));
}

// 1f env 里有真 URL（如 AIPsychology）→ 有效
{
  const r = readLocalProviderConfig(makeProject('p-real', {
    env: { ANTHROPIC_BASE_URL: 'https://zjz-ai.webtrn.cn', ANTHROPIC_AUTH_TOKEN: 'sk-test123' }
  }));
  check('env 有真 URL → 本地生效',
    !!r && r.url === 'https://zjz-ai.webtrn.cn' && r.key === 'sk-test123' && !r.isOAuth,
    JSON.stringify(r));
}

// 1g 只有 _localProviderId（钉住供应商但 env 空）→ 有效（本次新增的判据）
{
  const r = readLocalProviderConfig(makeProject('p-pid', {
    _localProviderId: 'abc-123', env: {}
  }));
  check('只有 _localProviderId → 本地生效', !!r && r.providerId === 'abc-123',
    JSON.stringify(r));
}

// 1h relay 地址 + 占位密钥（applySessionProvider 写出的形态）→ 有效且带 id
{
  const r = readLocalProviderConfig(makeProject('p-relay-proxy', {
    env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3928/relay/sid-1',
           ANTHROPIC_AUTH_TOKEN: 'webtmux-relay-sid-1' },
    _localProvider: 'relay-proxy', _localProviderId: 'prov-9'
  }));
  check('relay 形态 → 本地生效且带 providerId',
    !!r && r.url.includes('/relay/sid-1') && r.providerId === 'prov-9', JSON.stringify(r));
}

// 1i 坏 JSON → 不抛异常，按无配置处理
{
  const wd = path.join(tmpRoot, 'p-broken');
  fs.mkdirSync(path.join(wd, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(wd, '.claude', 'settings.local.json'), '{ 坏掉的 json');
  let threw = false, r;
  try { r = readLocalProviderConfig(wd); } catch { threw = true; }
  check('坏 JSON → 不抛异常且按无配置处理', !threw && r === null);
}

// 1j workingDir 为空/未定义 → 不抛异常
{
  let threw = false, r1, r2;
  try { r1 = readLocalProviderConfig(null); r2 = readLocalProviderConfig(undefined); }
  catch { threw = true; }
  check('workingDir 为空 → 不抛异常', !threw && r1 === null && r2 === null);
}

console.log(results.join('\n'));
results.length = 0;

// ══ 组 2：refreshAllProviders 的跟随/不跟随决策 ═══════════════════════════
// 复刻改造后的判定分支，验证「外部 CC Switch 切换」时每类会话的归属。
console.log('\n【组 2】外部 CC Switch 切换后的归属决策');

const GLOBAL = { name: 'Claude Official', configSource: 'global', exists: true };
function decide(workingDir, sessionProvider, currentCcProvider = GLOBAL) {
  const hasLocal = !!readLocalProviderConfig(workingDir);
  if (hasLocal && sessionProvider.exists) return { src: 'session', p: sessionProvider };
  if (sessionProvider.exists && (sessionProvider.configSource === 'process'
      || sessionProvider.url || sessionProvider.isOAuth)) {
    return { src: 'session', p: sessionProvider };
  }
  if (currentCcProvider) return { src: 'global', p: currentCcProvider };
  if (sessionProvider.exists) return { src: 'session', p: sessionProvider };
  return { src: 'none', p: null };
}

// 2a 空壳会话（phyviz 类）：sessionProvider 无 URL 无 OAuth → 必须跟随全局
{
  const wd = makeProject('d-shell', { permissions: {}, _localProvider: 'relay' });
  const d = decide(wd, { exists: true, configSource: 'global', url: '', isOAuth: false });
  check('空壳会话 → 跟随全局', d.src === 'global' && d.p.name === 'Claude Official');
}

// 2b 真本地配置（AIPsychology 类）→ 不跟随，保持自己的
{
  const wd = makeProject('d-real', {
    env: { ANTHROPIC_BASE_URL: 'https://zjz-ai.webtrn.cn', ANTHROPIC_AUTH_TOKEN: 'sk-x' }
  });
  const sp = { exists: true, configSource: 'local', url: 'https://zjz-ai.webtrn.cn',
               name: 'Whaty test', isOAuth: false };
  const d = decide(wd, sp);
  check('真本地配置 → 不跟随全局', d.src === 'session' && d.p.name === 'Whaty test');
}

// 2c 本地标记官方 OAuth（mathviz 类）→ 不跟随（即使全局切成第三方）
{
  const wd = makeProject('d-oauth', { _localProvider: 'oauth', env: {} });
  const thirdParty = { name: 'Whaty test copy copy', configSource: 'global', exists: true };
  const sp = { exists: true, configSource: 'local', url: '', isOAuth: true, name: 'Claude Official' };
  const d = decide(wd, sp, thirdParty);
  check('本地 OAuth 标记 → 不被全局第三方覆盖',
    d.src === 'session' && d.p.name === 'Claude Official');
}

// 2d relay 会话 → 不跟随（configSource='relay' 且有 URL）
{
  const wd = makeProject('d-relay', {
    env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3928/relay/s1',
           ANTHROPIC_AUTH_TOKEN: 'webtmux-relay-s1' },
    _localProvider: 'relay-proxy', _localProviderId: 'p1'
  });
  const sp = { exists: true, configSource: 'relay', url: 'https://zjz-ai.webtrn.cn', name: '钉住的供应商' };
  const d = decide(wd, sp);
  check('relay 会话 → 不跟随全局', d.src === 'session' && d.p.name === '钉住的供应商');
}

// 2e 无本地文件但进程实测到第三方 → 以实测为准（不被全局盖掉）
{
  const wd = makeProject('d-proc', undefined);
  const sp = { exists: true, configSource: 'process', url: 'https://other.example', name: '实测供应商' };
  const d = decide(wd, sp);
  check('无本地但进程实测第三方 → 以实测为准', d.src === 'session' && d.p.name === '实测供应商');
}

// 2f 空壳 + 全局也读不到 → 回落 sessionProvider，不能返回 none
{
  const wd = makeProject('d-shell2', { _localProvider: 'relay' });
  const d = decide(wd, { exists: true, configSource: 'global', url: '', isOAuth: false }, null);
  check('空壳且无全局 → 回落 sessionProvider 而非空', d.src === 'session');
}

console.log(results.join('\n'));
results.length = 0;

// ══ 组 3：applySessionProvider 真实实现（桩注入依赖）═════════════════════
// 从 server/index.js 原样抽取函数体，只把 resolveProviderInfo / sessionRelay /
// tmuxSetEnv 换成桩，验证它写出的文件形态、relay 映射、tmux env 作用域。
console.log('\n【组 3】applySessionProvider 写出的形态');

const applyMatch = src.match(/function applySessionProvider\(session, appType, providerId\) \{[\s\S]*?\n\}\n/);
if (!applyMatch) {
  console.error('✗ 未能抽取 applySessionProvider');
  process.exit(1);
}

function buildApply(providerInfo) {
  const relayMap = new Map();
  const tmuxCalls = [];
  const stubs = {
    resolveProviderInfo: () => providerInfo,
    sessionRelay: {
      setProvider: (sid, p) => relayMap.set(sid, p),
      clear: (sid) => relayMap.delete(sid),
      get: (sid) => relayMap.get(sid) || null
    },
    tmuxSetEnv: (opts) => tmuxCalls.push(opts),
    sessionManager: { updateSession() {} },
    path, os, existsSync: fs.existsSync, mkdirSync: fs.mkdirSync,
    readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync,
    console: { log() {}, warn() {}, error() {} }
  };
  const names = Object.keys(stubs);
  const fn = new Function(...names, `${applyMatch[0]}; return applySessionProvider;`)
    (...names.map(n => stubs[n]));
  return { fn, relayMap, tmuxCalls };
}

// 3a 第三方供应商 → 本地文件写 relay 地址+占位密钥，真实密钥只在服务端映射
{
  const wd = makeProject('a-third', { permissions: { allow: ['Bash'] } });
  const session = { id: 'sid-A', workingDir: wd, tmuxSessionName: 'tmux-A' };
  const { fn, relayMap, tmuxCalls } = buildApply({
    provider: { id: 'prov-X', name: '测试第三方' },
    settingsConfig: {},
    env: { ANTHROPIC_BASE_URL: 'https://api.example.com', ANTHROPIC_AUTH_TOKEN: 'sk-secret-REAL' },
    isOAuth: false
  });
  const r = fn(session, 'claude', 'prov-X');
  const written = JSON.parse(fs.readFileSync(path.join(wd, '.claude', 'settings.local.json'), 'utf8'));

  check('第三方: 返回 ok', r.ok === true, JSON.stringify(r));
  check('第三方: 本地 env 写的是 relay 地址',
    /^http:\/\/127\.0\.0\.1:\d+\/relay\/sid-A$/.test(written.env?.ANTHROPIC_BASE_URL || ''),
    written.env?.ANTHROPIC_BASE_URL);
  check('第三方: 本地 env 用占位密钥（真实密钥不落盘）',
    written.env?.ANTHROPIC_AUTH_TOKEN === 'webtmux-relay-sid-A'
      && !JSON.stringify(written).includes('sk-secret-REAL'));
  check('第三方: 标记 relay-proxy 且钉住 providerId',
    written._localProvider === 'relay-proxy' && written._localProviderId === 'prov-X');
  check('第三方: 真实 URL/密钥进入服务端映射',
    relayMap.get('sid-A')?.url === 'https://api.example.com'
      && relayMap.get('sid-A')?.key === 'sk-secret-REAL'
      && relayMap.get('sid-A')?.keyMode === 'bearer');
  check('第三方: 保留原有 permissions', written.permissions?.allow?.[0] === 'Bash');
  // 关键：tmux env 必须是会话级（target），绝不能出现 -g 全局作用域
  check('第三方: tmux env 只写会话级、无 -g 全局',
    tmuxCalls.length > 0 && tmuxCalls.every(c => c.target === 'tmux-A' && c.scope !== '-g'),
    JSON.stringify(tmuxCalls));
  // 新判据能识别它
  check('第三方: readLocalProviderConfig 判为本地生效',
    !!readLocalProviderConfig(wd));
}

// 3b OAuth 供应商 → 清 env、标记 oauth、清 relay 映射、tmux env 置 null
{
  const wd = makeProject('a-oauth', {
    env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3928/relay/sid-B', ANTHROPIC_AUTH_TOKEN: 'webtmux-relay-sid-B' },
    _localProvider: 'relay-proxy', _localProviderId: 'old-prov', model: 'opus'
  });
  const session = { id: 'sid-B', workingDir: wd, tmuxSessionName: 'tmux-B' };
  const { fn, relayMap, tmuxCalls } = buildApply({
    provider: { id: 'prov-OAuth', name: 'Claude Official' },
    settingsConfig: { useOAuth: true }, env: {}, isOAuth: true
  });
  relayMap.set('sid-B', { url: 'https://old.example', key: 'sk-old' });  // 预置旧映射
  const r = fn(session, 'claude', 'prov-OAuth');
  const written = JSON.parse(fs.readFileSync(path.join(wd, '.claude', 'settings.local.json'), 'utf8'));

  check('OAuth: 返回 ok', r.ok === true);
  check('OAuth: 清空 ANTHROPIC_* env', !written.env?.ANTHROPIC_BASE_URL && !written.env?.ANTHROPIC_AUTH_TOKEN);
  check('OAuth: 标记 oauth 并清除旧 providerId',
    written._localProvider === 'oauth' && written._localProviderId === undefined);
  check('OAuth: 清除旧 relay 映射', relayMap.get('sid-B') === null || relayMap.get('sid-B') === undefined);
  check('OAuth: tmux env 全部置 null（会话级）',
    tmuxCalls.length > 0 && tmuxCalls.every(c => c.value === null && c.target === 'tmux-B' && c.scope !== '-g'),
    JSON.stringify(tmuxCalls));
  check('OAuth: 保留 model 字段', written.model === 'opus');
  check('OAuth: readLocalProviderConfig 判为本地生效(isOAuth)',
    readLocalProviderConfig(wd)?.isOAuth === true);
}

// 3c 供应商不存在 → 返回错误，不写文件
{
  const wd = makeProject('a-missing', undefined);
  const session = { id: 'sid-C', workingDir: wd, tmuxSessionName: 'tmux-C' };
  const relayMap2 = new Map(), tmuxCalls2 = [];
  const stubs = {
    resolveProviderInfo: () => null,
    sessionRelay: { setProvider: (s, p) => relayMap2.set(s, p), clear: s => relayMap2.delete(s), get: s => relayMap2.get(s) },
    tmuxSetEnv: o => tmuxCalls2.push(o),
    sessionManager: { updateSession() {} },
    path, os, existsSync: fs.existsSync, mkdirSync: fs.mkdirSync,
    readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync,
    console: { log() {}, warn() {}, error() {} }
  };
  const names = Object.keys(stubs);
  const fn = new Function(...names, `${applyMatch[0]}; return applySessionProvider;`)(...names.map(n => stubs[n]));
  const r = fn(session, 'claude', 'nope');
  check('供应商不存在 → 返回错误且不写文件',
    r.ok === false && !fs.existsSync(path.join(wd, '.claude', 'settings.local.json')));
}

console.log(results.join('\n'));
results.length = 0;

// ══ 组 4：POST /api/claude-code/config 的顺序不变量 ══════════════════════
// 这个端点是 express 内联 handler，无法整段抽出来跑；但它最大的风险是「顺序」：
// applySessionProvider 写完文件后，必须①重新读取②被 !appliedViaRelay 守卫挡住
// ③最后才 writeFileSync。任一环节次序错了，relay env 就会被旧内容/真实密钥覆盖。
// 用源码位置断言把这个不变量钉住，改动破坏顺序时测试立刻红。
console.log('\n【组 4】config 端点的顺序不变量');
{
  const seg = src.slice(src.indexOf("app.post('/api/claude-code/config'"));
  const body = seg.slice(0, seg.indexOf("app.delete('/api/claude-code/config/local'"));
  const iApply = body.indexOf('applySessionProvider(targetSession');
  const iReread = body.indexOf('config = JSON.parse(readFileSync(configPath');
  const iGuard = body.indexOf('if (!appliedViaRelay)');
  const iWrite = body.indexOf('writeFileSync(configPath');

  check('端点内确实调用了 applySessionProvider', iApply > 0);
  check('重新读取 settings.local.json 在 applySessionProvider 之后',
    iReread > iApply, `apply=${iApply} reread=${iReread}`);
  check('env 写入被 !appliedViaRelay 守卫包住', iGuard > iReread, `guard=${iGuard}`);
  check('writeFileSync 在守卫之后（最后一步）', iWrite > iGuard, `write=${iWrite}`);
  check('端点把 sessionId 用于定位会话', body.includes('req.body?.sessionId'));
  check('getCurrentProvider 带上了 tmuxSessionName（否则识别不出 relay）',
    /getCurrentProvider\('claude', projectPath, targetSession\?\.tmuxSessionName/.test(body));

  // 功能性重放：按端点顺序跑一遍，确认 relay env 在合并 model/permissions 后仍在
  const wd = makeProject('e-post', { permissions: { allow: ['Read'] } });
  const session = { id: 'sid-E', workingDir: wd, tmuxSessionName: 'tmux-E' };
  const { fn } = buildApply({
    provider: { id: 'prov-E', name: '端点测试供应商' },
    settingsConfig: {},
    env: { ANTHROPIC_BASE_URL: 'https://real.example.com', ANTHROPIC_AUTH_TOKEN: 'sk-must-not-persist' },
    isOAuth: false
  });
  const appliedViaRelay = fn(session, 'claude', 'prov-E').ok;
  const cp = path.join(wd, '.claude', 'settings.local.json');
  let config = JSON.parse(fs.readFileSync(cp, 'utf-8'));   // ← 端点的重新读取
  const localPermissions = config.permissions;
  if (!appliedViaRelay) { config.env = { ANTHROPIC_AUTH_TOKEN: 'sk-must-not-persist' }; }  // 守卫：不该执行
  const globalConfig = { model: 'sonnet', permissions: { allow: ['Bash'] } };
  if (globalConfig.model) config.model = globalConfig.model;
  config.permissions = {
    allow: [...(localPermissions?.allow || []), ...(globalConfig.permissions.allow)].filter((v, i, a) => a.indexOf(v) === i),
    deny: [], ask: []
  };
  fs.writeFileSync(cp, JSON.stringify(config, null, 2));
  const final = JSON.parse(fs.readFileSync(cp, 'utf-8'));

  check('重放后 relay 地址仍在（未被覆盖）',
    /\/relay\/sid-E$/.test(final.env?.ANTHROPIC_BASE_URL || ''), final.env?.ANTHROPIC_BASE_URL);
  check('重放后真实密钥没有落盘', !JSON.stringify(final).includes('sk-must-not-persist'));
  check('重放后 model/permissions 合并成功',
    final.model === 'sonnet' && final.permissions.allow.includes('Read') && final.permissions.allow.includes('Bash'));
  check('重放后仍被判为本地生效（面板显示会话独立）',
    readLocalProviderConfig(wd)?.providerId === 'prov-E');
}

console.log(results.join('\n'));
results.length = 0;

// ══ 组 5：DELETE /api/claude-code/config/local 的清理 ════════════════════
console.log('\n【组 5】删除本地配置时的残留清理');
{
  const seg = src.slice(src.indexOf("app.delete('/api/claude-code/config/local'"));
  const body = seg.slice(0, 2600);
  check('删除端点清理 relay 映射', /sessionRelay\.clear\(s\.id\)/.test(body));
  check('删除端点清空会话级 tmux ANTHROPIC_*',
    /tmuxSetEnv\(\{ target: s\.tmuxSessionName, name: k, value: null \}\)/.test(body));
  check('清理只针对同 workingDir 的会话',
    /s\.workingDir !== projectPath/.test(body));
  check('清理写在 unlinkSync 之后',
    body.indexOf('unlinkSync') < body.indexOf('sessionRelay.clear'));

  // 功能性：删掉文件后判据必须回到「无本地配置 → 跟随全局」
  const wd = makeProject('e-del', {
    env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3928/relay/sid-F' },
    _localProvider: 'relay-proxy', _localProviderId: 'prov-F'
  });
  check('删除前：本地生效', !!readLocalProviderConfig(wd));
  fs.unlinkSync(path.join(wd, '.claude', 'settings.local.json'));
  check('删除后：回到跟随全局', readLocalProviderConfig(wd) === null);
}

console.log(results.join('\n'));
results.length = 0;

// ══ 组 6：CC Switch 当前供应商的权威口径 ═════════════════════════════════
console.log('\n【组 6】readCcSwitchCurrentId / queryCcSwitchCurrentRow');
{
  // 抽真实实现，homedir 打桩指向临时目录
  const readMatch = src.match(/function readCcSwitchCurrentId\(appType\) \{[\s\S]*?\n\}\n/);
  const writeMatch = src.match(/function writeCcSwitchCurrentId\(appType, providerId\) \{[\s\S]*?\n\}\n/);
  const queryMatch = src.match(/function queryCcSwitchCurrentRow\(db, appType, columns = '\*'\) \{[\s\S]*?\n\}\n/);
  check('三个函数都能从源码抽出', !!readMatch && !!writeMatch && !!queryMatch);

  function build(homeDir) {
    const stubs = {
      path, existsSync: fs.existsSync, readFileSync: fs.readFileSync,
      writeFileSync: fs.writeFileSync, JSON,
      os: { homedir: () => homeDir },
      console: { warn() {}, log() {} }
    };
    const names = Object.keys(stubs);
    const code = `${readMatch[0]}\n${writeMatch[0]}\n${queryMatch[0]}
      return { readCcSwitchCurrentId, writeCcSwitchCurrentId, queryCcSwitchCurrentRow };`;
    return new Function(...names, code)(...names.map(n => stubs[n]));
  }

  const home = fs.mkdtempSync(path.join(tmpRoot, 'home-'));
  const ccDir = path.join(home, '.cc-switch');
  const { readCcSwitchCurrentId, writeCcSwitchCurrentId, queryCcSwitchCurrentRow } = build(home);

  // settings.json 不存在 → 空串，且不得抛异常
  check('无 settings.json → 返回空串', readCcSwitchCurrentId('claude') === '');
  check('未知 appType → 返回空串', readCcSwitchCurrentId('foobar') === '');

  fs.mkdirSync(ccDir, { recursive: true });
  fs.writeFileSync(path.join(ccDir, 'settings.json'), JSON.stringify({
    currentProviderClaude: 'id-whaty',
    currentProviderCodex: 'id-codex',
    enableLocalProxy: false
  }), 'utf8');
  check('读到 currentProviderClaude', readCcSwitchCurrentId('claude') === 'id-whaty');
  check('读到 currentProviderCodex', readCcSwitchCurrentId('codex') === 'id-codex');
  check('缺 currentProviderGemini → 空串', readCcSwitchCurrentId('gemini') === '');

  // 假 db：is_current=1 指向 official，settings.json 指向 whaty（正是实测的错位）
  const rows = [
    { id: 'id-whaty', app_type: 'claude', name: 'Whaty', is_current: 0 },
    { id: 'id-official', app_type: 'claude', name: 'Claude Official', is_current: 1 }
  ];
  const fakeDb = {
    prepare(sql) {
      return {
        get(...args) {
          if (/WHERE id = \?/.test(sql)) {
            return rows.find(r => r.id === args[0] && r.app_type === args[1]) || undefined;
          }
          return rows.find(r => r.app_type === args[0] && r.is_current === 1) || undefined;
        }
      };
    }
  };
  check('settings.json 优先于 is_current',
    queryCcSwitchCurrentRow(fakeDb, 'claude')?.name === 'Whaty');

  // settings.json 指向 DB 里没有的 id → 回落 is_current
  fs.writeFileSync(path.join(ccDir, 'settings.json'),
    JSON.stringify({ currentProviderClaude: 'id-ghost' }), 'utf8');
  check('id 不在 DB → 回落 is_current',
    queryCcSwitchCurrentRow(fakeDb, 'claude')?.name === 'Claude Official');

  // settings.json 损坏 → 同样回落，不抛
  fs.writeFileSync(path.join(ccDir, 'settings.json'), '{ 坏 json', 'utf8');
  let threw = false;
  let fallback = null;
  try { fallback = queryCcSwitchCurrentRow(fakeDb, 'claude'); } catch { threw = true; }
  check('settings.json 损坏不抛异常且回落', !threw && fallback?.name === 'Claude Official');

  // 写回：只改目标键，其余键保留
  fs.writeFileSync(path.join(ccDir, 'settings.json'), JSON.stringify({
    currentProviderClaude: 'id-official', enableLocalProxy: false, keepMe: 123
  }), 'utf8');
  check('写回成功', writeCcSwitchCurrentId('claude', 'id-whaty') === true);
  const after = JSON.parse(fs.readFileSync(path.join(ccDir, 'settings.json'), 'utf8'));
  check('写回后当前供应商已更新', after.currentProviderClaude === 'id-whaty');
  check('写回未破坏其他键', after.keepMe === 123 && after.enableLocalProxy === false);
  check('写回后读取一致', readCcSwitchCurrentId('claude') === 'id-whaty');
  check('写回空 providerId → 拒绝', writeCcSwitchCurrentId('claude', '') === false);

  // CC Switch 没装（无 .cc-switch 目录）→ 不主动造目录
  const home2 = fs.mkdtempSync(path.join(tmpRoot, 'home2-'));
  const api2 = build(home2);
  check('无 .cc-switch 目录 → 不写不建', api2.writeCcSwitchCurrentId('claude', 'x') === false
    && !fs.existsSync(path.join(home2, '.cc-switch')));

  // 源码层：四个读取点都必须走 queryCcSwitchCurrentRow，不能再裸查 is_current = 1
  const rawReads = [...src.matchAll(/SELECT[^;]*?is_current\s*=\s*1/g)].length;
  check('裸查 is_current=1 只剩函数内兜底那一处', rawReads === 1,
    `实际 ${rawReads} 处`);
  check('切换供应商时会写回 settings.json',
    /writeCcSwitchCurrentId\(appType, targetProvider\.id\)/.test(src));
}

console.log(results.join('\n'));
results.length = 0;

// ══ 组 8：config 端点绝不写出空壳（点「本地」无效的真凶）══════════════════
console.log('\n【组 8】空壳本地配置的防线');
{
  const seg = src.slice(src.indexOf("app.post('/api/claude-code/config'"));
  // 切到端点自身的 writeFileSync 之后即可，别切太短否则位置断言全变 -1
  const body = seg.slice(0, seg.indexOf('writeFileSync(configPath') + 200);

  // isOAuth 不能再用「读不到 URL」当判据
  check('isOAuth 依赖 dbIsOAuth 而非仅缺 URL',
    /const isOAuth = !hasRealUrl && dbIsOAuth;/.test(body));
  check('dbIsOAuth 由当前供应商 settings_config 决定',
    /dbIsOAuth = !sc\.env\?\.ANTHROPIC_BASE_URL/.test(body));
  check('无真 URL 且非 OAuth → 返回失败而不是写文件',
    /if \(!hasRealUrl && !isOAuth\) \{[\s\S]{0,400}?success: false/.test(body));

  // 拒绝分支必须在 writeFileSync 之前（否则空壳已经落盘了）
  const idxReject = body.indexOf('拒绝写出空壳本地配置');
  const idxWrite = body.indexOf('writeFileSync(configPath');
  check('拒绝分支在 writeFileSync 之前', idxReject > 0 && idxWrite > 0 && idxReject < idxWrite);

  // 拒绝只发生在快照回落路径内：relay 成功时不该被这个检查拦住
  const guardIdx = body.indexOf('if (!appliedViaRelay)');
  check('空壳检查位于 !appliedViaRelay 分支内',
    guardIdx > 0 && guardIdx < idxReject);

  // 快照路径的标记语义修正：不再叫 relay
  check("快照路径标记为 'snapshot' 不是 'relay'",
    /config\._localProvider = 'snapshot';/.test(body)
    && !/config\._localProvider = 'relay';/.test(body));

  // 功能性：空壳文件必须被判为「无本地配置」（这就是点了没反应的机制）
  const shell = makeProject('h-shell', { env: {}, _localProvider: 'relay' });
  check('env:{} + _localProvider:relay → 判为无本地配置',
    readLocalProviderConfig(shell) === null);
  const shell2 = makeProject('h-shell2', { env: {}, _localProvider: 'snapshot' });
  check('env:{} + _localProvider:snapshot → 同样判为无本地配置',
    readLocalProviderConfig(shell2) === null);

  // 有真 URL 的快照配置必须判为本地生效
  const real = makeProject('h-real', {
    env: { ANTHROPIC_BASE_URL: 'https://zjz-ai.webtrn.cn', ANTHROPIC_AUTH_TOKEN: 'k'.repeat(40) },
    _localProvider: 'snapshot', _localProviderId: 'prov-whaty'
  });
  const rc = readLocalProviderConfig(real);
  check('带真 URL 的快照 → 判为本地生效', !!rc && rc.url === 'https://zjz-ai.webtrn.cn');
  check('快照配置能带出 providerId', rc?.providerId === 'prov-whaty');

  // OAuth 标记仍然是有效判据（不能被这次改动波及）
  const oa = makeProject('h-oauth', { env: {}, _localProvider: 'oauth' });
  check('oauth 标记仍判为本地生效', readLocalProviderConfig(oa)?.isOAuth === true);
}

console.log(results.join('\n'));
results.length = 0;

// ══ 组 7：continueCount 熔断口径（屏幕推进即清零）═══════════════════════
console.log('\n【组 7】"继续"死循环熔断的计数口径');
{
  // 从源码抽三处表达式，保证测的是发布代码而不是复刻品
  const breakerSrc = src.match(
    /const curHash = computeContentHash\([\s\S]*?const continueCount = [\s\S]*?: 1;/);
  const preWriteSrc = src.match(
    /const prevAdvanced = [\s\S]*?const continueCount = [\s\S]*?\(action === '继续' \? 1 : 0\);/);
  const aiWriteSrc = src.match(
    /const prevAdvancedAi = [\s\S]*?const continueCountAi = [\s\S]*?\(action === '继续' \? 1 : 0\);/);
  check('三处计数表达式都能抽出', !!breakerSrc && !!preWriteSrc && !!aiWriteSrc);

  const breaker = new Function('lastAction', 'terminalContent', 'computeContentHash',
    `${breakerSrc[0]}; return continueCount;`);
  const preWrite = new Function('prevAction', 'action', 'contentHash',
    `${preWriteSrc[0]}; return continueCount;`);
  const aiWrite = new Function('prevActionAi', 'action', 'contentHash',
    `${aiWriteSrc[0]}; return continueCountAi;`);

  const hash = (s) => `h:${s}`;                     // 桩：内容不同则哈希不同
  const cc = (s) => hash(s.slice(0, 500));          // 与调用处 500 截断口径一致

  // 1) 正常开发节奏：每轮屏幕都在变 → 永远不该累加
  let st = null;
  let maxSeen = 0;
  for (let i = 0; i < 12; i++) {
    const screen = `屏幕第${i}帧`;
    const n = breaker(st, screen, hash);
    maxSeen = Math.max(maxSeen, n);
    st = { action: '继续', time: i, contentHash: cc(screen), continueCount: preWrite(st, '继续', cc(screen)) };
  }
  check('屏幕每轮都推进 → 计数恒为 1，永不熔断', maxSeen === 1, `实际最大 ${maxSeen}`);

  // 2) 真死循环：屏幕一帧不动 → 必须累到 4 触发熔断
  st = null;
  const frozen = '同一帧';
  const seq = [];
  for (let i = 0; i < 5; i++) {
    const n = breaker(st, frozen, hash);
    seq.push(n);
    st = { action: '继续', time: i, contentHash: cc(frozen), continueCount: preWrite(st, '继续', cc(frozen)) };
  }
  check('屏幕不动 → 计数递增 1,2,3,4,5', seq.join(',') === '1,2,3,4,5', seq.join(','));
  check('屏幕不动 → 第 4 次达到熔断阈值', seq[3] >= 4);

  // 3) 实测卡死那条历史序列（1,继续,1,1,1,继续,1,继续,继续,1,继续,继续,继续），
  //    每步屏幕都在变。修复前它会累到 4 并永久熔断，修复后必须始终 <4。
  const history = ['1', '继续', '1', '1', '1', '继续', '1', '继续', '继续', '1', '继续', '继续', '继续'];
  st = null;
  let maxHist = 0;
  history.forEach((act, i) => {
    const screen = `帧${i}`;
    if (act === '继续') maxHist = Math.max(maxHist, breaker(st, screen, hash));
    st = { action: act, time: i, contentHash: cc(screen), continueCount: preWrite(st, act, cc(screen)) };
  });
  check('重放实测序列 → 计数不再爬到熔断线', maxHist < 4, `实际最大 ${maxHist}`);

  // 4) 非"继续"动作把计数归零
  const after1 = preWrite({ action: '继续', contentHash: cc('a'), continueCount: 3 }, '1', cc('a'));
  check('非"继续"动作 → 计数归零', after1 === 0, `实际 ${after1}`);

  // 5) 两条写回路径口径必须一致（否则熔断清零、写回照旧累加）
  const cases = [
    [null, '继续', cc('x')],
    [{ action: '继续', contentHash: cc('x'), continueCount: 2 }, '继续', cc('x')],   // 屏幕未变
    [{ action: '继续', contentHash: cc('x'), continueCount: 2 }, '继续', cc('y')],   // 屏幕已变
    [{ action: '1', contentHash: cc('x'), continueCount: 0 }, '继续', cc('y')],
    [{ action: '继续', contentHash: cc('x'), continueCount: 3 }, '2', cc('y')]
  ];
  const same = cases.every(([p, a, h]) => preWrite(p, a, h) === aiWrite(p, a, h));
  check('preAnalyze 与 AI 两条写回路径口径一致', same);

  // 6) 熔断读与写回同一状态得出同一计数（三处统一）
  const consistent = cases.filter(([, a]) => a === '继续').every(([p, , h]) => {
    const screen = h === cc('x') ? 'x' : 'y';
    return breaker(p, screen, hash) === preWrite(p, '继续', cc(screen));
  });
  check('熔断读与写回对同一状态得出同一计数', consistent);

  // 7) 首次动作（无历史）必须从 1 起，不能因 undefined 直接判死
  check('无历史 → 熔断计数为 1', breaker(null, '任意屏幕', hash) === 1);
  check('无历史 → 不触发 >=2 分支', breaker(undefined, '任意屏幕', hash) < 2);
}

console.log(results.join('\n'));
results.length = 0;

console.log(`\n${'═'.repeat(60)}`);
console.log(`结果：${pass} 通过 / ${fail} 失败`);
fs.rmSync(tmpRoot, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);

/**
 * 长程编排：沙箱隔离层 —— 回归测试
 *
 * 逐条对译长程编排器 test_session_loop.py 里的隔离用例：
 *   case_sandbox_marked_trusted / case_claude_template_copied_memory_overridden /
 *   case_mcp_whitelist_only / case_dotenv_loaded_but_not_leaked
 * 外加 test_requirement.py 里 case_protected_path_rejected 的沙箱侧。
 *
 * ⚠ 这些断言防的是**静默污染**：配错了不报错，只有真实记忆库被写坏、
 *   skill 白给、凭据泄漏给执行者。所以必须有机器断言，不能靠人看。
 *
 * ⚠⚠ 本测试会读写用户级 ~/.claude.json（标记沙箱为已信任）。它有几十个项目条目，
 *    所以测试**只允许新增/改动本沙箱那一条**，并在断言里逐条核对别的条目未被动。
 *
 * 运行: node tests/test-longrun-sandbox.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  LongRunSandbox, assertSandboxed, sandboxRoots, protectedRoots,
  userClaudeJson, templateClaudeDir, IsolationViolation,
  WEBTMUX_ROOT, orchestratorRoot, realResolve, legacySandboxRoot,
} from '../server/services/LongRunSandbox.js';

// 测试沙箱根指到临时目录：不在用户真实的 _sandbox_longrun（原版产出都在那）里建测试沙箱
const TEST_BASE = path.join(os.tmpdir(), 'longrun_sandbox_base_test');
fs.mkdirSync(TEST_BASE, { recursive: true });
process.env.LONGRUN_SANDBOX_BASE = TEST_BASE;
// 新项目默认建在项目根（真实 ~/Documents/ClaudeCode），测试必须同样指到临时目录
process.env.LONGRUN_PROJECTS_ROOT = process.env.LONGRUN_SANDBOX_BASE;
// 接管时导入的 Claude 默认记忆位置：指到临时目录，不读真实 ~/.claude/projects
process.env.LONGRUN_CLAUDE_PROJECTS = path.join(TEST_BASE, '_claude_projects');

const results = { passed: 0, failed: 0, errors: [] };
const pending = [];

function test(name, fn) {
  const p = (async () => {
    try { await fn(); results.passed++; console.log(`✅ ${name}`); }
    catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
  })();
  pending.push(p);
  return p;
}
function skip(name, why) { console.log(`⊘ ${name} —— ${why}`); }
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }

const SANDBOX_NAME = 'longrun_test_sandbox';

/** 每次都从干净状态建，避免上一轮残留掩盖问题 */
function freshSandbox() {
  const root = path.join(sandboxRoots()[0], SANDBOX_NAME);
  fs.rmSync(root, { recursive: true, force: true });
  return LongRunSandbox.create(SANDBOX_NAME);
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function settingsOf(spec) {
  return readJson(path.join(spec.root, '.claude', 'settings.local.json'));
}
/** 执行者专用配置（经 --settings 传入） */
function execOf(spec) {
  return readJson(spec.executorSettingsPath);
}

/** 清理：删沙箱目录，并把测试留在 ~/.claude.json 里的那条信任记录抹掉 */
function cleanup() {
  fs.rmSync(path.join(sandboxRoots()[0], SANDBOX_NAME), { recursive: true, force: true });
  const f = userClaudeJson();
  if (!fs.existsSync(f)) return;
  try {
    const j = readJson(f);
    const key = path.join(sandboxRoots()[0], SANDBOX_NAME).replace(/\\/g, '/');
    if (j.projects && key in j.projects) {
      delete j.projects[key];
      const tmp = f + '.longrun-test-tmp';
      fs.writeFileSync(tmp, JSON.stringify(j, null, 2), 'utf8');
      fs.renameSync(tmp, f);
    }
  } catch { /* 读不动就不动它 */ }
}

// ── 双向路径断言 ─────────────────────────────────────────────
test('受保护根内的路径拒绝启动（防污染真实记忆库）', () => {
  const guarded = protectedRoots()[0];
  let threw = null;
  try { assertSandboxed(path.join(guarded, 'anything'), '测试路径'); }
  catch (e) { threw = e; }
  assert(threw instanceof IsolationViolation, '应抛 IsolationViolation');
  assert(threw.message.includes('受保护'), `报错要点明受保护: ${threw.message}`);
  assert(threw.message.includes('污染真实记忆'), '报错要说清后果，否则后人会以为是误报');
});

test('沙箱白名单外的路径拒绝启动', () => {
  let threw = null;
  try { assertSandboxed(path.join(os.tmpdir(), 'not_a_sandbox'), '测试路径'); }
  catch (e) { threw = e; }
  assert(threw instanceof IsolationViolation, '应抛 IsolationViolation');
  assert(threw.message.includes('白名单'), `报错要提白名单: ${threw.message}`);
  assert(threw.message.includes(sandboxRoots()[0]), '报错要列出允许的沙箱根，便于排查');
});

test('沙箱根不在受保护项目内（默认位置就该是安全的）', () => {
  const root = sandboxRoots()[0];
  for (const guarded of protectedRoots()) {
    assert(!(root === guarded || root.startsWith(guarded + path.sep)),
      `默认沙箱根 ${root} 落在受保护项目 ${guarded} 内 —— 配置本身就是错的`);
  }
});

test('沙箱名不许含路径分隔符（防越出白名单）', () => {
  for (const bad of ['../escape', 'a/b', 'a\\b']) {
    let threw = null;
    try { LongRunSandbox.create(bad); } catch (e) { threw = e; }
    assert(threw instanceof IsolationViolation, `"${bad}" 应被拒绝`);
  }
});

// ── 对译 case_sandbox_marked_trusted ─────────────────────────
// 未信任的项目**不加载**自己的 settings.local.json，于是具名 allow 规则整份失效，
// 执行者调 skill 被拒，理由是 "no approval surface" —— 看起来像 skill 名写错，
// 其实规则一字不差只是没被加载（spaceX 那轮，2026-09-06 实测定位）。
test('沙箱被标记为已信任，且不动别的项目条目', () => {
  const f = userClaudeJson();
  if (!fs.existsSync(f)) { skip('信任标记', '用户级 .claude.json 不存在'); return; }

  const before = readJson(f);
  const nBefore = Object.keys(before.projects || {}).length;

  const spec = freshSandbox();
  const after = readJson(f);
  const key = String(spec.root).replace(/\\/g, '/');

  assert(spec.trustGranted, '沙箱未被标记为已信任');
  assert(after.projects?.[key]?.hasTrustDialogAccepted === true,
    `本沙箱那条应为 true: ${JSON.stringify(after.projects?.[key])}`);
  // 只该新增（或改动）本沙箱那一条，不能动别人
  const nAfter = Object.keys(after.projects || {}).length;
  assert(nAfter === nBefore || nAfter === nBefore + 1,
    `项目条目数异常: ${nBefore} → ${nAfter}`);
  for (const [k, v] of Object.entries(before.projects || {})) {
    assert(JSON.stringify(after.projects[k]) === JSON.stringify(v),
      `别的项目条目被改动了: ${k}`);
  }
});

test('已信任时不重复写盘（幂等）', () => {
  const f = userClaudeJson();
  if (!fs.existsSync(f)) { skip('信任幂等', '用户级 .claude.json 不存在'); return; }
  freshSandbox();
  const mtime1 = fs.statSync(f).mtimeMs;
  // 第二次 create：信任已在，不该再动那个文件
  LongRunSandbox.create(SANDBOX_NAME);
  assert(fs.statSync(f).mtimeMs === mtime1,
    '已信任时又写了一次盘 —— 这个文件上百 KB，无谓重写增加写坏风险');
});

// ── 对译 case_claude_template_copied_memory_overridden ────────
// 隔离的头号情形：模板里 autoMemoryDirectory 指向真实记忆库，照抄会让子进程
// 直接写进去。复制与覆盖的顺序反了就静默失效 —— 没有报错，只有真实记忆被污染。
test('记忆目录：执行者配置与项目配置都指向项目内 .memory（终端会话共用），且不指向受保护项目', () => {
  const spec = freshSandbox();
  for (const [what, payload] of [['执行者配置', execOf(spec)], ['项目配置', settingsOf(spec)]]) {
    assert(payload.autoMemoryDirectory === spec.memoryDir, `${what}记忆目录未写对: ${payload.autoMemoryDirectory}`);
    assertSandboxed(payload.autoMemoryDirectory, `${what}里的记忆目录`);
    for (const guarded of protectedRoots()) {
      assert(!String(payload.autoMemoryDirectory).startsWith(guarded), `${what}记忆目录指向受保护项目`);
    }
  }
});

test('项目配置只合并记忆目录：原有权限与非 relay 配置原样保留、首次改动前备份、读不动时不覆盖', () => {
  const root = path.join(sandboxRoots()[0], SANDBOX_NAME);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  const original = { permissions: { allow: ['Bash(make:*)'], defaultMode: 'default' }, env: { FOO: 'bar' }, model: 'opus' };
  const sf = path.join(root, '.claude', 'settings.local.json');
  fs.writeFileSync(sf, JSON.stringify(original, null, 2));
  const spec = LongRunSandbox.create(SANDBOX_NAME);
  const now = settingsOf(spec);
  const { autoMemoryDirectory, ...rest } = now;
  assert(JSON.stringify(rest) === JSON.stringify(original), `原有配置被改动: ${JSON.stringify(rest)}`);
  assert(!now.permissions.allow.some((r) => /^Bash\(git/.test(r)), '执行者白名单不该写进项目配置（终端会话会继承）');
  assert(JSON.stringify(readJson(spec.projectSettingsBackup)) === JSON.stringify(original), '备份内容应是改动前的原文件');
  // 第二次打开不能用已改过的文件覆盖备份
  LongRunSandbox.create(SANDBOX_NAME);
  assert(JSON.stringify(readJson(spec.projectSettingsBackup)) === JSON.stringify(original), '备份被覆盖');
  fs.writeFileSync(sf, '{ 这不是 JSON', 'utf8');
  const spec3 = LongRunSandbox.create(SANDBOX_NAME);
  assert(fs.readFileSync(sf, 'utf8') === '{ 这不是 JSON', '读不动的项目配置不能被覆盖');
  assert(execOf(spec3).autoMemoryDirectory === spec3.memoryDir, '记忆目录由执行者配置兜底');
});

test('会话级供应商（直连/官方登录/旧 relay）长程期间移走，备份只留供应商 id 不留密钥；快照配置不动', () => {
  const root = path.join(sandboxRoots()[0], SANDBOX_NAME);
  const sf = path.join(root, '.claude', 'settings.local.json');
  const cases = [
    ['直连', { env: { ANTHROPIC_BASE_URL: 'https://zjz.example.com', ANTHROPIC_AUTH_TOKEN: 'sk-real-secret', ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: '', OTHER: '1' },
      _localProvider: 'session', _localProviderId: 'p1' }],
    ['官方登录', { env: { ANTHROPIC_BASE_URL: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: '', OTHER: '1' }, _localProvider: 'oauth' }],
    ['旧 relay', { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3928/relay/abc', ANTHROPIC_AUTH_TOKEN: 'webtmux-relay-abc', OTHER: '1' },
      _localProvider: 'relay-proxy', _localProviderId: 'p1' }],
  ];
  for (const [name, cfg] of cases) {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(sf, JSON.stringify(cfg));
    const spec = LongRunSandbox.create(SANDBOX_NAME);
    const now = settingsOf(spec);
    // 一个 ANTHROPIC_* 键都不能留：哪怕是 ""，也会把执行者钉在官方登录上而不是全局配置
    assert(spec.providerStripped && !now._localProvider && !Object.keys(now.env || {}).some((k) => k.startsWith('ANTHROPIC_'))
      && now.env.OTHER === '1', `${name}：${JSON.stringify(now)}`);
    const saved = readJson(path.join(spec.runDir, 'provider-env.backup.json'));
    assert(saved._localProvider === cfg._localProvider && (saved._localProviderId || '') === (cfg._localProviderId || ''), `${name}：备份没记下供应商`);
    assert(!JSON.stringify(saved).includes('sk-real-secret'), `${name}：备份里留了密钥`);
  }
  fs.writeFileSync(sf, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.example.com', ANTHROPIC_AUTH_TOKEN: 'x' }, _localProvider: 'snapshot' }));
  const spec2 = LongRunSandbox.create(SANDBOX_NAME);
  assert(!spec2.providerStripped && settingsOf(spec2).env.ANTHROPIC_BASE_URL === 'https://api.example.com', '「快照复制全局」的配置不该动');
});

test('执行者配置禁止改项目外的 CLAUDE.md（祖先目录逐级 + 用户级）', () => {
  const spec = freshSandbox();
  const deny = execOf(spec).permissions.deny;
  const parent = path.dirname(spec.root);
  for (const rule of [`Edit(/${parent}/CLAUDE.md)`, `Write(/${parent}/CLAUDE.md)`, 'Edit(//CLAUDE.md)',
    `Edit(/${path.join(os.homedir(), '.claude', 'CLAUDE.md')})`]) {
    assert(deny.includes(rule), `缺 deny: ${rule}`);
  }
  assert(!deny.some((r) => r.includes(path.join(spec.root, 'CLAUDE.md'))), '项目自己的 CLAUDE.md 要能改（维护提示词需要）');
});

test('接管已有项目时把 Claude 默认位置的记忆复制进 .memory：不覆盖同名、原处不删', () => {
  const root = path.join(sandboxRoots()[0], SANDBOX_NAME);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, '.memory'), { recursive: true });
  fs.writeFileSync(path.join(root, '.memory', 'MEMORY.md'), '项目里已有的索引');
  const src = path.join(process.env.LONGRUN_CLAUDE_PROJECTS, realResolve(root).replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'MEMORY.md'), '默认位置的索引');
  fs.writeFileSync(path.join(src, 'decisions.md'), '决定');
  const spec = LongRunSandbox.open(root, { importMemory: true });
  assert(JSON.stringify(spec.memoryImported) === '["decisions.md"]', JSON.stringify(spec.memoryImported));
  assert(fs.readFileSync(path.join(root, '.memory', 'MEMORY.md'), 'utf8') === '项目里已有的索引', '同名不能覆盖');
  assert(fs.existsSync(path.join(src, 'decisions.md')), '原处不删');
});

test('项目根本身不能当项目；项目根下的目录与旧沙箱根下的目录都放行', () => {
  let e = null;
  try { LongRunSandbox.open(sandboxRoots()[0]); } catch (x) { e = x; }
  assert(e instanceof IsolationViolation && /项目根目录本身/.test(e.message), e?.message);
  assert(sandboxRoots().length >= 1 && sandboxRoots().includes(legacySandboxRoot()), '旧沙箱根仍在允许列表里');
});

test('每个 skill 都有具名 allow 规则（名字取自 SKILL.md，Skill(*) 通配不放行）', () => {
  const root = path.join(sandboxRoots()[0], SANDBOX_NAME);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, '.claude', 'skills', 'agent-browser-skill'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'skills', 'agent-browser-skill', 'SKILL.md'), '---\nname: agent-browser\n---\n');
  const spec = LongRunSandbox.create(SANDBOX_NAME);
  const allow = execOf(spec).permissions.allow;
  assert(allow.includes('Skill(agent-browser)') && !allow.includes('Skill(agent-browser-skill)'), '名字要取 SKILL.md 的 name:');
  // 模板里原版就带着 Skill(*)（实测不放行，但也无害）；要保证的是具名规则一定写上，不能指望通配
  assert(!(settingsOf(spec).permissions), 'skill 授权只写执行者配置');
});

// ── 对译 case_mcp_whitelist_only ─────────────────────────────
// 用户级 ~/.claude.json 顶层 mcpServers 会被沙箱全盘继承，--allowedTools 拦不住
// 它们的**可见性**。不 deny 只会让执行者调用时被拒 —— 而它看得见工具、会去调、
// 被拒后转向自造替代方案（qingming 自造了无头 Chrome），还把"这条路走不通"写进记忆。
test('MCP 白名单外的服务器必须显式 deny（不是"不 allow 就行"）', () => {
  const spec = freshSandbox();
  const payload = execOf(spec);
  const allow = payload.permissions?.allow || [];
  const deny = payload.permissions?.deny || [];

  if (!spec.mcpAllowed.length && !spec.mcpDenied.length) {
    skip('MCP 闸', '本机没有 MCP 服务器，无可验证对象');
    return;
  }
  for (const name of spec.mcpAllowed) {
    assert(allow.includes(`mcp__${name}`), `白名单服务器 ${name} 未 allow`);
    // deny 优先于 allow —— 白名单里的绝不能同时出现在 deny 里
    assert(!deny.includes(`mcp__${name}`), `${name} 同时在 allow 和 deny 里，deny 会赢`);
  }
  for (const name of spec.mcpDenied) {
    assert(deny.includes(`mcp__${name}`), `未放行的服务器 ${name} 必须显式 deny`);
  }
});

test('重建时先清掉旧 mcp__ 规则（防服务器改名后留过期规则）', () => {
  const spec = freshSandbox();
  const payload = execOf(spec);
  (payload.permissions.deny ||= []).push('mcp__已改名的老服务器');
  fs.writeFileSync(spec.executorSettingsPath, JSON.stringify(payload, null, 2), 'utf8');

  const spec2 = LongRunSandbox.create(SANDBOX_NAME);
  const deny2 = execOf(spec2).permissions?.deny || [];
  assert(!deny2.includes('mcp__已改名的老服务器'), '旧 mcp__ 规则未被清掉');
});

// ── 对译 case_dotenv_loaded_but_not_leaked ───────────────────
// 监督者凭据进了编排器环境后，子进程默认全盘继承 —— 执行者跑任意 Bash、
// 写任意文件，没有理由拿到那把 key。
test('监督者凭据与记忆目录变量都不传给执行者', () => {
  const spec = freshSandbox();
  const env = spec.childEnv({
    SUPERVISOR_API_KEY: 'sk-should-not-leak',
    SUPERVISOR_BASE_URL: 'https://should-not-leak',
    CLAUDE_AUTO_MEMORY_DIR: '/real/memory',
    TMUX: '/tmp/tmux-501/default,1,0', TMUX_PANE: '%25',
    PATH: process.env.PATH,
  });
  // 不去掉的话执行者触发的全局 hook 会被算到同目录的终端会话头上
  assert(!('TMUX' in env) && !('TMUX_PANE' in env) && env.WEBTMUX_LONGRUN === '1', 'TMUX 要去掉、长程标记要带上');
  const leakedSup = Object.keys(env).filter((k) => k.toUpperCase().startsWith('SUPERVISOR_'));
  assert(leakedSup.length === 0, `监督者凭据泄漏给执行者: ${leakedSup}`);
  const leakedMem = Object.keys(env).filter(
    (k) => k.toUpperCase().includes('CLAUDE') && k.toUpperCase().includes('MEMORY'));
  assert(leakedMem.length === 0, `记忆目录变量泄漏: ${leakedMem}`);
  assert(env.CLAUDE_PROJECT_DIR === spec.root, 'CLAUDE_PROJECT_DIR 应指向沙箱根');
  assert(env.PATH, '其余环境变量应保留');
});

// ── 运行前复核 ───────────────────────────────────────────────
test('verifyClean 拦住中途被改成受保护路径的外部参考', () => {
  const spec = freshSandbox();
  spec.verifyClean();                       // 干净状态应通过
  // 绕过 addExtraDir 直接塞一个受保护路径，模拟"中途被改"
  spec.extraDirs.push(protectedRoots()[0]);
  let threw = null;
  try { spec.verifyClean(); } catch (e) { threw = e; }
  assert(threw instanceof IsolationViolation, 'verifyClean 应拦住受保护的外部参考');
});

test('addExtraDir 拒绝受保护路径，接受正常路径', () => {
  const spec = freshSandbox();
  let threw = null;
  try { spec.addExtraDir(protectedRoots()[0]); } catch (e) { threw = e; }
  assert(threw instanceof IsolationViolation, '受保护路径应被拒');
  assert(threw.message.includes('读写权限'), '报错要说清 --add-dir 是读写而非只读');

  const ok = spec.addExtraDir(os.tmpdir());   // 项目外资料，允许
  assert(spec.extraDirs.includes(ok), '正常外部路径应登记成功');
  spec.addExtraDir(os.tmpdir());              // 去重
  assert(spec.extraDirs.filter((d) => d === ok).length === 1, '重复登记应去重');
});

// ── 审计补齐：G1 模板来源 ────────────────────────────────────
// 早期移植把整个 ~/.claude 当模板：config.json 的密钥、带 token 的 settings 备份、
// 全部历史提示词都会进沙箱，并被 git add -A 提交进快照。
test('模板不是 ~/.claude，沙箱里不出现任何凭据类文件', () => {
  const tpl = realResolve(templateClaudeDir());
  assert(tpl !== realResolve(path.join(os.homedir(), '.claude')), `模板指向了用户全局 ~/.claude: ${tpl}`);
  assert(tpl.startsWith(WEBTMUX_ROOT), `模板应在仓库内: ${tpl}`);
  const spec = freshSandbox();
  const found = [];
  const walk = (d) => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/^(config\.json|history\.jsonl|\.credentials.*|settings\.json(\.bak.*)?)$/.test(n)) found.push(p);
    }
  };
  walk(spec.root);
  assert(found.length === 0, `项目目录里出现凭据类文件: ${found.join(', ')}`);
});

test('模板带原版护栏：危险 git 操作 deny、git push 走 ask、放行 puppeteer', () => {
  const spec = freshSandbox();
  const p = execOf(spec).permissions;
  for (const rule of ['Bash(git reset --hard:*)', 'Bash(git push --force:*)', 'Bash(git clean -f:*)']) {
    assert(p.deny.includes(rule), `缺 deny: ${rule}`);
  }
  assert((p.ask || []).includes('Bash(git push:*)'), 'git push 应走 ask（--permission-prompts none 下等于禁）');
  assert(p.defaultMode === 'acceptEdits', `defaultMode 应为 acceptEdits，实际 ${p.defaultMode}`);
  assert(p.allow.includes('mcp__puppeteer'), '用户选择放行 puppeteer，执行者才能自己看渲染结果');
  assert(!p.allow.includes('Bash'), '裸 Bash 会盖过一切 ask/deny，不能出现');
});

// ── G3：受保护根从代码位置推导 ───────────────────────────────
test('受保护根不随启动目录变（换 cwd 后仍保护仓库与原版编排器）', () => {
  const orig = process.cwd();
  try {
    process.chdir(os.tmpdir());
    const roots = protectedRoots();
    assert(roots.includes(realResolve(WEBTMUX_ROOT)), `换 cwd 后丢了仓库根: ${roots}`);
    assert(roots.includes(realResolve(orchestratorRoot())), '原版编排器目录（真实记忆库）也要受保护');
    assert(!roots.includes(realResolve(os.tmpdir())), 'cwd 不该变成受保护根');
  } finally { process.chdir(orig); }
});

// ── G5：符号链接不能绕过断言 ─────────────────────────────────
test('沙箱根里的符号链接指进受保护目录时拒绝', () => {
  const link = path.join(sandboxRoots()[0], 'evil_link');
  // ⚠ 删符号链接必须 unlink：rmSync 会跟随链接去处理目标目录
  const dropLink = () => { try { if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link); } catch {} };
  dropLink();
  fs.symlinkSync(WEBTMUX_ROOT, link);
  try {
    let threw = null;
    try { assertSandboxed(path.join(link, 'server'), '测试路径'); } catch (e) { threw = e; }
    assert(threw instanceof IsolationViolation, '经符号链接指进仓库的路径应被拒');
    assert(threw.message.includes('受保护'), `应按受保护路径拒: ${threw.message}`);
  } finally { dropLink(); }
});

// ── G18：MCP 白名单读取 ─────────────────────────────────────
test('白名单读不到或坏 JSON 时抛异常，不返回空（空=静默吊销授权）', () => {
  const spec = freshSandbox();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tpl-'));
  let threw = null;
  try { spec._readAllowedMcp(path.join(dir, 'nope.json')); } catch (e) { threw = e; }
  assert(threw instanceof IsolationViolation && threw.message.includes('白名单'), '缺文件应抛');
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{ 坏', 'utf8');
  threw = null;
  try { spec._readAllowedMcp(bad); } catch (e) { threw = e; }
  assert(threw instanceof IsolationViolation && threw.message.includes('解析失败'), '坏 JSON 应抛');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('服务器名按 "__" 切（名字里的单下划线不截断），排除通配 *', () => {
  const spec = freshSandbox();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tpl-'));
  const f = path.join(dir, 's.json');
  fs.writeFileSync(f, JSON.stringify({ permissions: { allow: [
    'mcp__claude_ai_Claude_Docs', 'mcp__blender__render', 'mcp__*', 'Read', 'mcp__blender',
  ] } }), 'utf8');
  const names = spec._readAllowedMcp(f);
  assert(JSON.stringify(names) === JSON.stringify(['claude_ai_Claude_Docs', 'blender']),
    `解析错: ${JSON.stringify(names)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

await Promise.all(pending);
cleanup();
console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

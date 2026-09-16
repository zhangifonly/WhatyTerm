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
} from '../server/services/LongRunSandbox.js';

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
test('记忆目录被强制覆盖成沙箱路径（顺序反了会静默污染）', () => {
  const spec = freshSandbox();
  const payload = settingsOf(spec);
  assert(payload.autoMemoryDirectory === spec.memoryDir,
    `记忆目录未覆盖: ${payload.autoMemoryDirectory}`);
  // 再过一遍隔离断言：它必须落在沙箱内
  assertSandboxed(payload.autoMemoryDirectory, '写入后的记忆目录');
  // 不能残留指向真实记忆库的痕迹
  for (const guarded of protectedRoots()) {
    assert(!String(payload.autoMemoryDirectory).startsWith(guarded),
      `记忆目录仍指向受保护项目: ${payload.autoMemoryDirectory}`);
  }
});

test('模板被复制进沙箱，且写坏 settings 也能自愈', () => {
  const spec = freshSandbox();
  const tpl = templateClaudeDir();
  if (fs.existsSync(path.join(tpl, 'skills'))) {
    assert(fs.existsSync(path.join(spec.root, '.claude', 'skills')), 'skills 未复制');
  }
  // settings 被写成非法 JSON 时，重建应重写一份干净的而不是崩掉
  const sf = path.join(spec.root, '.claude', 'settings.local.json');
  fs.writeFileSync(sf, '{ 这不是 JSON', 'utf8');
  const spec2 = LongRunSandbox.create(SANDBOX_NAME);
  assert(settingsOf(spec2).autoMemoryDirectory === spec2.memoryDir,
    '非法 JSON 时未重写出干净配置');
});

test('每个 skill 都有具名 allow 规则（Skill(*) 通配不放行）', () => {
  const spec = freshSandbox();
  const skillsDir = path.join(spec.root, '.claude', 'skills');
  if (!fs.existsSync(skillsDir)) { skip('skill 授权', '模板里没有 skills'); return; }
  const payload = settingsOf(spec);
  // permissions 要保留：--permission-prompts none 下没有 allow 名单，
  // 执行者的每个 Bash 都会被自动拒绝
  assert(payload.permissions, '模板里的 permissions 应保留');
  const allow = payload.permissions.allow || [];
  assert(spec.skillsGranted.length > 0, '沙箱有 skills 却没写授权规则');
  for (const name of spec.skillsGranted) {
    assert(allow.includes(`Skill(${name})`), `缺 Skill(${name}) 规则`);
  }
  // 名字取自 SKILL.md 的 name: 字段，可以与目录名不同
  assert(!allow.includes('Skill(*)'),
    'Skill(*) 通配实测不放行 skill 执行，不该依赖它');
});

// ── 对译 case_mcp_whitelist_only ─────────────────────────────
// 用户级 ~/.claude.json 顶层 mcpServers 会被沙箱全盘继承，--allowedTools 拦不住
// 它们的**可见性**。不 deny 只会让执行者调用时被拒 —— 而它看得见工具、会去调、
// 被拒后转向自造替代方案（qingming 自造了无头 Chrome），还把"这条路走不通"写进记忆。
test('MCP 白名单外的服务器必须显式 deny（不是"不 allow 就行"）', () => {
  const spec = freshSandbox();
  const payload = settingsOf(spec);
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
  const sf = path.join(spec.root, '.claude', 'settings.local.json');
  const payload = settingsOf(spec);
  (payload.permissions.deny ||= []).push('mcp__已改名的老服务器');
  fs.writeFileSync(sf, JSON.stringify(payload, null, 2), 'utf8');

  const spec2 = LongRunSandbox.create(SANDBOX_NAME);
  const deny2 = settingsOf(spec2).permissions?.deny || [];
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
    PATH: process.env.PATH,
  });
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

await Promise.all(pending);
cleanup();
console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

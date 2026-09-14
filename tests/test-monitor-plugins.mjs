/**
 * WhatyTerm 全面测试脚本 - 模块三：监控插件测试
 * 运行: node tests/test-monitor-plugins.mjs
 */

import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 测试结果收集
const results = {
  passed: 0,
  failed: 0,
  errors: []
};

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    results.passed++;
    return true;
  } catch (err) {
    console.log(`❌ ${name}`);
    console.log(`   错误: ${err.message}`);
    results.failed++;
    results.errors.push({ name, error: err.message });
    return false;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
    results.passed++;
    return true;
  } catch (err) {
    console.log(`❌ ${name}`);
    console.log(`   错误: ${err.message}`);
    results.failed++;
    results.errors.push({ name, error: err.message });
    return false;
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: 期望 "${expected}", 实际 "${actual}"`);
  }
}

function assertTrue(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertNotNull(value, message) {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
}

// ============================================
// T3.1 DefaultPlugin 测试
// ============================================
console.log('\n=== T3.1 DefaultPlugin 测试 ===\n');

const DefaultPlugin = (await import('../server/services/MonitorPlugins/plugins/DefaultPlugin.js')).default;
const defaultPlugin = new DefaultPlugin();

test('T3.1.1 detectPhase() 能识别运行中状态', () => {
  const runningContent = `Working on task...
esc to interrupt
(2m 30s)`;

  const phase = defaultPlugin.detectPhase(runningContent, {});
  assertEqual(phase, 'running', '应识别为 running 状态');
});

test('T3.1.2 detectPhase() 能识别空闲状态', () => {
  // 空闲状态通常返回 'waiting' 或 'idle'
  const idleContent = `Task completed.
>`;

  const phase = defaultPlugin.detectPhase(idleContent, {});
  assertTrue(phase === 'waiting' || phase === 'idle', `应识别为 waiting 或 idle 状态，实际: ${phase}`);
});

test('T3.1.3 detectPhase() 能识别确认状态', () => {
  const confirmContent = `Do you want to proceed?
1. Yes
2. No`;

  const phase = defaultPlugin.detectPhase(confirmContent, {});
  assertEqual(phase, 'confirmation', '应识别为 confirmation 状态');
});

test('T3.1.4 detectPhase() 能识别错误状态', () => {
  const errorContent = `Error: Something went wrong
Failed: Cannot connect to server`;

  const phase = defaultPlugin.detectPhase(errorContent, {});
  assertEqual(phase, 'error', '应识别为 error 状态');
});

test('T3.1.5 analyzeStatus() 返回正确的操作建议', () => {
  // v1.2.81 起确认菜单必须「验活」：❯ 指针行 + 底部快捷键提示（liveMenu.js）。
  // 活菜单：应给出 select 建议
  const liveConfirm = `Do you want to proceed?
❯ 1. Yes
  2. No

 Esc to cancel · Tab to amend`;
  const result = defaultPlugin.analyzeStatus(liveConfirm, 'confirmation', {});
  assertNotNull(result, 'analyzeStatus 返回 null');
  assertEqual(result.needsAction, true, '活确认菜单应需要操作');
  assertNotNull(result.suggestedAction, '应有建议操作');

  // 无 ❯/快捷键提示的裸文本（正文误报形状）：不得动作。
  // 台账实测这类误报 1100+ 次全空转，v1.2.81 修复。
  const proseConfirm = `Do you want to proceed?
1. Yes
2. No`;
  const suppressed = defaultPlugin.analyzeStatus(proseConfirm, 'confirmation', {});
  assertEqual(suppressed.needsAction, false, '无活菜单的确认字样不得自动操作');
});

test('T3.1.6 isIdle() 能识别各 CLI 的空闲提示符', () => {
  // Claude Code 空闲提示符
  let isIdle = defaultPlugin.isIdle('>\n');
  assertTrue(isIdle, '应识别 > 为空闲状态');

  // Shell 空闲提示符
  isIdle = defaultPlugin.isIdle('$ ');
  assertTrue(isIdle, '应识别 $ 为空闲状态');

  // OpenCode 空闲提示符
  isIdle = defaultPlugin.isIdle('@general\n');
  assertTrue(isIdle, '应识别 @general 为空闲状态');

  // 运行中不应识别为空闲
  isIdle = defaultPlugin.isIdle('esc to interrupt\n(2m 30s)');
  assertTrue(!isIdle, '运行中不应识别为空闲');
});

// ============================================
// T3.2 PluginManager 测试
// ============================================
console.log('\n=== T3.2 PluginManager 测试 ===\n');

const pluginManager = (await import('../server/services/MonitorPlugins/index.js')).default;

await testAsync('T3.2.1 插件加载功能', async () => {
  await pluginManager.loadBuiltinPlugins();
  const plugins = pluginManager.listPlugins();
  assertTrue(plugins.length > 0, '应加载至少一个插件');

  // 验证默认插件存在
  const defaultExists = plugins.some(p => p.id === 'default');
  assertTrue(defaultExists, '应包含默认插件');
});

test('T3.2.2 selectPlugin() 能选择合适的插件', () => {
  // 无上下文时应选择默认插件
  const plugin = pluginManager.selectPlugin({}, null);
  assertNotNull(plugin, 'selectPlugin 返回 null');
  assertEqual(plugin.id, 'default', '无上下文时应选择默认插件');

  // 强制指定插件
  const forcedPlugin = pluginManager.selectPlugin({}, 'default');
  assertNotNull(forcedPlugin, '强制指定插件返回 null');
  assertEqual(forcedPlugin.id, 'default', '强制指定的插件 ID 不匹配');
});

// ============================================
// 测试结果汇总
// ============================================
console.log('\n=== 模块三测试结果汇总 ===\n');
console.log(`通过: ${results.passed}`);
console.log(`失败: ${results.failed}`);


// ============ 后台 shell ≠ 主循环在跑（v1.2.98 回归锁）============
// 实测缺陷：Claude 干完一批活后屏上留下
//   ✻ Crunched for 15m 36s · done 15:16 · 2 shells still running
// 主循环已回到空闲 ❯、底栏无 esc to interrupt，但 DefaultPlugin 的弱判据里
// 裸 /running/ 命中了「2 shells still running」→ phase=running →
// 「程序运行中，等待完成」→ 永不发「继续」，而后台 shell 可能常驻，会话僵住等人工。
await testAsync('后台 shell 在跑但主循环空闲：判 waiting 而非 running', async () => {
  const { default: DefaultPlugin } = await import('../server/services/MonitorPlugins/plugins/DefaultPlugin.js');
  const p = new DefaultPlugin();
  const idleScreen = [
    '正文若干行，讲了一堆修复内容。',
    '✻ Crunched for 15m 36s · done 15:16 · 2 shells still running',
    '─'.repeat(60), '❯', '─'.repeat(60),
    '  ⏵⏵ auto mode on · 2 shells · ← 6 agents · ↓ to manage',
  ].join('\n');
  const phase = p.detectPhase ? p.detectPhase(idleScreen) : null;
  if (phase === 'running') throw new Error('后台 shell 被当成主循环在跑，会永不发继续');
  if (p.isIdle && p.isIdle(idleScreen) === false) throw new Error('isIdle 被后台 shell 措辞否决，等待输入分支也进不去');
});
await testAsync('真运行中（esc to interrupt + 计时器）仍判 running，不许误打断', async () => {
  const { default: DefaultPlugin } = await import('../server/services/MonitorPlugins/plugins/DefaultPlugin.js');
  const p = new DefaultPlugin();
  const runScreen = [
    '正文', '✶ Mustering… (3m 13s · ↓ 9.4k tokens)',
    '─'.repeat(60), '❯', '─'.repeat(60),
    '  ⏵⏵ auto mode on · 2 shells · esc to interrupt · ← 6 agents',
  ].join('\n');
  const phase = p.detectPhase ? p.detectPhase(runScreen) : null;
  if (phase !== 'running') throw new Error(`真运行中却判成 ${phase}，会打断正在跑的任务`);
});


// ============ 省略号不能裸着当运行证据（v1.3.5 回归锁）============
// 实测缺陷：Codex 会话 Worked for 1h 19m 31s 已结束、输入框空着、无 esc to
// interrupt，却被判「程序运行中」永不发继续。根因是弱判据里的裸 /\.{3}|…/
// 同时命中三处无关内容：
//   `│ … +1 lines`                             Codex 折叠输出标记
//   `… +5 lines (ctrl + t to view transcript)`  同上
//   `SHA-256 为 c158788f…`                      正文里的哈希截断
await testAsync('Codex 已完成：折叠标记与哈希截断里的省略号不算运行中', async () => {
  const { default: DefaultPlugin } = await import('../server/services/MonitorPlugins/plugins/DefaultPlugin.js');
  const p = new DefaultPlugin();
  const idle = [
    '│ … +1 lines',
    '… +5 lines (ctrl + t to view transcript)',
    '- 默认 P1-482 profile 仍逐字节一致，SHA-256 为 c158788f…。',
    '─ Worked for 1h 19m 31s ────────────────────────────',
    '› Ask Codex to do anything',
    'gpt-5.6-sol high · ~/Documents/ClaudeCode/iSpring · 继续当前任务',
  ].join('\n');
  const phase = p.detectPhase(idle);
  if (phase === 'running') throw new Error('省略号误判成运行中 —— 会话会永不发继续');
  if (p.isIdle(idle) === false) throw new Error('isIdle 被误否决');
});
await testAsync('真 spinner（省略号紧跟计时器）仍判运行中', async () => {
  const { default: DefaultPlugin } = await import('../server/services/MonitorPlugins/plugins/DefaultPlugin.js');
  const p = new DefaultPlugin();
  const run = ['正文', '✶ Mustering… (3m 13s · ↓ 9.4k tokens)', '❯',
    '  ⏵⏵ auto mode on · esc to interrupt'].join('\n');
  if (p.detectPhase(run) !== 'running') throw new Error('真 spinner 漏判，会打断正在跑的任务');
});
await testAsync('Codex 运行中（带 esc to interrupt）仍判运行中', async () => {
  const { default: DefaultPlugin } = await import('../server/services/MonitorPlugins/plugins/DefaultPlugin.js');
  const p = new DefaultPlugin();
  const cx = ['正文', '  Working (12s · esc to interrupt)', '› Ask Codex to do anything'].join('\n');
  if (p.detectPhase(cx) !== 'running') throw new Error('Codex 运行帧漏判');
});

if (results.errors.length > 0) {
  console.log('\n失败的测试:');
  results.errors.forEach(e => {
    console.log(`  - ${e.name}: ${e.error}`);
  });
}

// 失败必须反映到退出码：此前失败静默 exit 0，跑批时红的会被当成绿的
process.exitCode = results.failed ? 1 : 0;

export { results };

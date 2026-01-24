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
  // 测试确认状态的操作建议
  const confirmContent = `Do you want to proceed?
1. Yes
2. No`;

  const result = defaultPlugin.analyzeStatus(confirmContent, 'confirmation', {});
  assertNotNull(result, 'analyzeStatus 返回 null');
  assertEqual(result.needsAction, true, '确认状态应需要操作');
  assertNotNull(result.suggestedAction, '应有建议操作');
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

if (results.errors.length > 0) {
  console.log('\n失败的测试:');
  results.errors.forEach(e => {
    console.log(`  - ${e.name}: ${e.error}`);
  });
}

export { results };

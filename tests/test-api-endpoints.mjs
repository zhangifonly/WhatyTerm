/**
 * WhatyTerm 全面测试脚本 - 模块四：API 接口测试（单元测试版）
 * 运行: node tests/test-api-endpoints.mjs
 *
 * 此版本直接测试 API 路由处理函数，不需要启动服务器
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

console.log('\n=== 模块四：API 接口测试（单元测试版）===\n');

// ============================================
// T4.1 会话管理 - 测试 SessionManager
// ============================================
console.log('--- T4.1 会话管理 ---\n');

const { SessionManager } = await import('../server/services/SessionManager.js');
const sessionManager = new SessionManager();

test('T4.1.1 SessionManager 获取会话列表', () => {
  const sessions = sessionManager.listSessions();
  assertTrue(typeof sessions === 'object' || Array.isArray(sessions), '应返回对象或数组');
});

test('T4.1.2 SessionManager 创建会话功能存在', () => {
  assertTrue(typeof sessionManager.createSession === 'function' ||
             typeof sessionManager.addSession === 'function' ||
             typeof sessionManager.create === 'function',
    'SessionManager 应有创建会话方法');
});

test('T4.1.3 SessionManager 删除会话功能存在', () => {
  assertTrue(typeof sessionManager.deleteSession === 'function' ||
             typeof sessionManager.removeSession === 'function' ||
             typeof sessionManager.closeSession === 'function' ||
             typeof sessionManager.close === 'function' ||
             typeof sessionManager.delete === 'function',
    'SessionManager 应有删除会话方法');
});

// ============================================
// T4.2 AI 监控 - 测试 AIEngine
// ============================================
console.log('\n--- T4.2 AI 监控 ---\n');

const { AIEngine } = await import('../server/services/AIEngine.js');
const aiEngine = new AIEngine();

test('T4.2.1 AIEngine getSettings() 返回设置', () => {
  const settings = aiEngine.getSettings();
  assertNotNull(settings, 'settings 不应为 null');
  assertTrue(typeof settings === 'object', '应返回对象');
});

test('T4.2.2 AIEngine saveSettings() 功能存在', () => {
  assertTrue(typeof aiEngine.saveSettings === 'function',
    'AIEngine 应有 saveSettings 方法');
});

await testAsync('T4.2.3 AIEngine analyzeStatus() 分析终端状态', async () => {
  // 使用 preAnalyzeStatus 进行快速测试（不调用 API）
  const result = aiEngine.preAnalyzeStatus('test content\n>', 'claude');
  // 可能返回 null（需要 AI 分析）或对象
  assertTrue(result === null || typeof result === 'object',
    'preAnalyzeStatus 应返回 null 或对象');
});

// ============================================
// T4.3 供应商管理 - 测试 ProviderService
// ============================================
console.log('\n--- T4.3 供应商管理 ---\n');

const { ProviderService } = await import('../server/services/ProviderService.js');
const providerService = new ProviderService();

test('T4.3.1 ProviderService list() 返回供应商列表', () => {
  const data = providerService.list('claude');
  assertNotNull(data, 'list 返回 null');
  assertTrue('providers' in data, '应包含 providers 字段');
});

test('T4.3.2 ProviderService add() 添加供应商', () => {
  const testId = 'api-test-' + Date.now();
  const result = providerService.add('claude', {
    id: testId,
    name: 'API Test Provider',
    settingsConfig: {}
  });
  assertTrue(result, '添加供应商失败');

  // 清理
  providerService.delete('claude', testId);
});

test('T4.3.3 ProviderService update() 更新供应商', () => {
  const testId = 'api-update-' + Date.now();
  providerService.add('claude', {
    id: testId,
    name: 'API Update Test',
    settingsConfig: {}
  });

  const result = providerService.update('claude', testId, {
    name: 'Updated Name'
  });
  assertTrue(result, '更新供应商失败');

  // 清理
  providerService.delete('claude', testId);
});

test('T4.3.4 ProviderService delete() 删除供应商', () => {
  const testId = 'api-delete-' + Date.now();
  providerService.add('claude', {
    id: testId,
    name: 'API Delete Test',
    settingsConfig: {}
  });

  const result = providerService.delete('claude', testId);
  assertTrue(result, '删除供应商失败');
});

test('T4.3.5 ProviderService switch() 切换供应商', () => {
  const data = providerService.list('claude');
  const providerIds = Object.keys(data.providers || {});

  if (providerIds.length > 0) {
    const result = providerService.switch('claude', providerIds[0]);
    assertTrue(result, '切换供应商失败');
  } else {
    console.log('   跳过：没有可用的供应商');
  }
});

// ============================================
// T4.4 隧道 - 测试隧道服务
// ============================================
console.log('\n--- T4.4 隧道 ---\n');

const frpTunnel = (await import('../server/services/FrpTunnel.js')).default;
const cloudflareTunnel = (await import('../server/services/CloudflareTunnel.js')).default;

test('T4.4.1 隧道服务 getUrl() 功能', () => {
  // FRP
  assertTrue(typeof frpTunnel.getUrl === 'function', 'FrpTunnel 应有 getUrl 方法');
  // Cloudflare
  assertTrue(typeof cloudflareTunnel.getUrl === 'function', 'CloudflareTunnel 应有 getUrl 方法');
});

test('T4.4.2 隧道服务 start() 功能存在', () => {
  assertTrue(typeof frpTunnel.start === 'function' || typeof frpTunnel.connect === 'function',
    'FrpTunnel 应有 start 或 connect 方法');
  assertTrue(typeof cloudflareTunnel.start === 'function' || typeof cloudflareTunnel.connect === 'function',
    'CloudflareTunnel 应有 start 或 connect 方法');
});

test('T4.4.3 隧道服务 stop() 功能存在', () => {
  assertTrue(typeof frpTunnel.stop === 'function' || typeof frpTunnel.disconnect === 'function',
    'FrpTunnel 应有 stop 或 disconnect 方法');
  assertTrue(typeof cloudflareTunnel.stop === 'function' || typeof cloudflareTunnel.disconnect === 'function',
    'CloudflareTunnel 应有 stop 或 disconnect 方法');
});

// ============================================
// T4.5 更新 - 测试 UpdateService
// ============================================
console.log('\n--- T4.5 更新 ---\n');

const updateService = (await import('../server/services/UpdateService.js')).default;

await testAsync('T4.5.1 UpdateService checkForUpdate() 检查更新', async () => {
  const result = await updateService.checkForUpdate(true);
  assertNotNull(result, 'checkForUpdate 返回 null');
  assertTrue('hasUpdate' in result, '应包含 hasUpdate 字段');
});

test('T4.5.2 UpdateService getCurrentVersion() 获取版本', () => {
  const version = updateService.getCurrentVersion();
  assertNotNull(version, 'version 不应为 null');
  assertTrue(/^\d+\.\d+\.\d+/.test(version), '版本号格式不正确');
});

// ============================================
// 测试结果汇总
// ============================================
console.log('\n=== 模块四测试结果汇总 ===\n');
console.log(`通过: ${results.passed}`);
console.log(`失败: ${results.failed}`);

if (results.errors.length > 0) {
  console.log('\n失败的测试:');
  results.errors.forEach(e => {
    console.log(`  - ${e.name}: ${e.error}`);
  });
}

export { results };

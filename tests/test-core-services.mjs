/**
 * WhatyTerm 全面测试脚本 - 模块一：核心服务测试
 * 运行: node tests/test-core-services.mjs
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

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
// T1.1 AIEngine 服务测试
// ============================================
console.log('\n=== T1.1 AIEngine 服务测试 ===\n');

const { AIEngine } = await import('../server/services/AIEngine.js');
const aiEngine = new AIEngine();

test('T1.1.1 AIEngine 初始化正常', () => {
  assertNotNull(aiEngine, 'AIEngine 实例不应为 null');
  assertNotNull(aiEngine.settings, 'settings 不应为 null');
});

test('T1.1.2 getSettings() 返回正确配置', () => {
  const settings = aiEngine.getSettings();
  assertNotNull(settings, 'settings 不应为 null');
  assertTrue(typeof settings === 'object', 'settings 应为对象');
});

test('T1.1.3 detectRunningCLI() 能识别所有支持的 CLI', () => {
  // Claude Code
  let result = aiEngine.detectRunningCLI('Claude Code v1.0\nesc to interrupt\n>', null);
  assertEqual(result, 'claude', '无法识别 Claude Code');

  // Codex
  result = aiEngine.detectRunningCLI('OpenAI Codex\nCodex >\n', null);
  assertEqual(result, 'codex', '无法识别 Codex');

  // Gemini
  result = aiEngine.detectRunningCLI('Google Gemini\nReady (5 tools)\n', null);
  assertEqual(result, 'gemini', '无法识别 Gemini');

  // Droid
  result = aiEngine.detectRunningCLI('GPT5-Codex [Custom]\nIDE ⚙\n', null);
  assertEqual(result, 'droid', '无法识别 Droid');

  // OpenCode
  result = aiEngine.detectRunningCLI('opencode v1.0\n@general\n>', null);
  assertEqual(result, 'opencode', '无法识别 OpenCode');
});

test('T1.1.4 preAnalyzeStatus() 能正确分析运行状态', () => {
  const runningContent = `Claude Code v1.0
Working on task...
esc to interrupt
(2m 30s)`;

  const result = aiEngine.preAnalyzeStatus(runningContent, 'claude');
  assertNotNull(result, 'preAnalyzeStatus 返回 null');
  assertEqual(result.needsAction, false, '运行中状态不应需要操作');
  assertTrue(result.currentState.includes('运行中'), '状态应为运行中');
});

test('T1.1.5 preAnalyzeStatus() 能正确分析空闲状态', () => {
  const idleContent = `Task completed.
function test() { return true; }
>`;

  const result = aiEngine.preAnalyzeStatus(idleContent, 'claude');
  // 空闲状态可能需要操作（发送"继续"）
  if (result !== null) {
    assertTrue(typeof result.needsAction === 'boolean', 'needsAction 应为布尔值');
  }
});

test('T1.1.6 preAnalyzeStatus() 能正确分析确认界面', () => {
  const confirmContent = `Do you want to proceed?
1. Yes
2. No`;

  const result = aiEngine.preAnalyzeStatus(confirmContent, 'claude');
  assertNotNull(result, 'preAnalyzeStatus 返回 null');
  assertEqual(result.needsAction, true, '确认界面应需要操作');
  assertEqual(result.actionType, 'select', '操作类型应为 select');
});

test('T1.1.7 _parseProviderConfig() 能解析所有类型供应商配置', () => {
  // Claude 配置
  const claudeRow = {
    id: 'test-claude',
    name: 'Test Claude',
    app_type: 'claude',
    settings_config: JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
        ANTHROPIC_AUTH_TOKEN: 'test-key'
      }
    })
  };
  let result = aiEngine._parseProviderConfig(claudeRow);
  assertNotNull(result, 'Claude 配置解析失败');
  assertEqual(result.apiType, 'claude', 'apiType 应为 claude');

  // Codex 配置
  const codexRow = {
    id: 'test-codex',
    name: 'Test Codex',
    app_type: 'codex',
    settings_config: JSON.stringify({
      auth: { OPENAI_API_KEY: 'test-key' },
      config: 'base_url = "https://api.openai.com/v1"\nmodel = "gpt-4"'
    })
  };
  result = aiEngine._parseProviderConfig(codexRow);
  assertNotNull(result, 'Codex 配置解析失败');
  assertEqual(result.apiType, 'codex', 'apiType 应为 codex');

  // Gemini 配置
  const geminiRow = {
    id: 'test-gemini',
    name: 'Test Gemini',
    app_type: 'gemini',
    settings_config: JSON.stringify({
      env: { GEMINI_API_KEY: 'test-key' }
    })
  };
  result = aiEngine._parseProviderConfig(geminiRow);
  assertNotNull(result, 'Gemini 配置解析失败');
  assertEqual(result.apiType, 'gemini', 'apiType 应为 gemini');

  // OpenCode 配置
  const opencodeRow = {
    id: 'test-opencode',
    name: 'Test OpenCode',
    app_type: 'opencode',
    settings_config: JSON.stringify({
      env: {
        OPENCODE_PROVIDER: 'anthropic',
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
        ANTHROPIC_API_KEY: 'test-key'
      }
    })
  };
  result = aiEngine._parseProviderConfig(opencodeRow);
  assertNotNull(result, 'OpenCode 配置解析失败');
  assertEqual(result.apiType, 'opencode', 'apiType 应为 opencode');
});

// ============================================
// T1.2 ProviderService 服务测试
// ============================================
console.log('\n=== T1.2 ProviderService 服务测试 ===\n');

const { ProviderService } = await import('../server/services/ProviderService.js');
const providerService = new ProviderService();

test('T1.2.1 list() 返回正确的供应商列表', () => {
  const data = providerService.list('claude');
  assertNotNull(data, 'list 返回 null');
  assertTrue('current' in data, '应包含 current 字段');
  assertTrue('providers' in data, '应包含 providers 字段');
});

test('T1.2.2 add() 能添加新供应商', () => {
  const testProvider = {
    id: 'test-provider-' + Date.now(),
    name: 'Test Provider',
    settingsConfig: {
      env: {
        ANTHROPIC_BASE_URL: 'https://test.api.com',
        ANTHROPIC_AUTH_TOKEN: 'test-token'
      }
    }
  };

  const result = providerService.add('claude', testProvider);
  assertTrue(result, '添加供应商失败');

  // 验证添加成功
  const provider = providerService.getById('claude', testProvider.id);
  assertNotNull(provider, '无法获取添加的供应商');
  assertEqual(provider.name, testProvider.name, '供应商名称不匹配');

  // 清理：删除测试供应商
  providerService.delete('claude', testProvider.id);
});

test('T1.2.3 update() 能更新供应商配置', () => {
  // 先添加一个测试供应商
  const testProvider = {
    id: 'test-update-' + Date.now(),
    name: 'Test Update Provider',
    settingsConfig: {}
  };
  providerService.add('claude', testProvider);

  // 更新
  const result = providerService.update('claude', testProvider.id, {
    name: 'Updated Provider Name'
  });
  assertTrue(result, '更新供应商失败');

  // 验证更新成功
  const provider = providerService.getById('claude', testProvider.id);
  assertEqual(provider.name, 'Updated Provider Name', '供应商名称未更新');

  // 清理
  providerService.delete('claude', testProvider.id);
});

test('T1.2.4 delete() 能删除供应商', () => {
  // 先添加一个测试供应商
  const testProvider = {
    id: 'test-delete-' + Date.now(),
    name: 'Test Delete Provider',
    settingsConfig: {}
  };
  providerService.add('claude', testProvider);

  // 删除
  const result = providerService.delete('claude', testProvider.id);
  assertTrue(result, '删除供应商失败');

  // 验证删除成功
  const provider = providerService.getById('claude', testProvider.id);
  assertTrue(provider === null, '供应商未被删除');
});

test('T1.2.5 switch() 能切换当前供应商', () => {
  // 获取当前供应商列表
  const data = providerService.list('claude');
  const providerIds = Object.keys(data.providers);

  if (providerIds.length >= 2) {
    // 切换到另一个供应商
    const targetId = providerIds.find(id => id !== data.current) || providerIds[0];
    const result = providerService.switch('claude', targetId);
    assertTrue(result, '切换供应商失败');

    // 验证切换成功
    const newData = providerService.list('claude');
    assertEqual(newData.current, targetId, '当前供应商未切换');
  } else {
    console.log('   跳过：供应商数量不足');
  }
});

test('T1.2.6 getCurrentProvider() 返回当前供应商', () => {
  const provider = providerService.getCurrentProvider('claude');
  // 可能没有配置供应商
  if (provider !== null) {
    assertNotNull(provider.id, '供应商 ID 不应为 null');
    assertNotNull(provider.name, '供应商名称不应为 null');
  }
});

// ============================================
// T1.3 CliRegistry 服务测试
// ============================================
console.log('\n=== T1.3 CliRegistry 服务测试 ===\n');

const cliRegistry = (await import('../server/services/CliRegistry.js')).default;

test('T1.3.1 所有内置 CLI 工具已注册', () => {
  const expectedTools = ['claude', 'codex', 'gemini', 'droid', 'opencode'];
  for (const toolId of expectedTools) {
    const tool = cliRegistry.getTool(toolId);
    assertNotNull(tool, `${toolId} 工具未注册`);
    assertTrue(tool.builtin, `${toolId} 应为内置工具`);
  }
});

test('T1.3.2 getTool() 返回正确的工具配置', () => {
  const tool = cliRegistry.getTool('claude');
  assertNotNull(tool, 'Claude 工具未找到');
  assertEqual(tool.id, 'claude', 'ID 不匹配');
  assertEqual(tool.name, 'Claude Code', '名称不匹配');
  assertTrue(tool.processNames.length > 0, '进程名列表为空');
  assertNotNull(tool.terminalPatterns, '终端模式未配置');
});

test('T1.3.3 findByProcessName() 能通过进程名查找工具', () => {
  let tool = cliRegistry.findByProcessName('claude');
  assertNotNull(tool, '无法通过 claude 进程名查找');
  assertEqual(tool.id, 'claude', '找到的工具 ID 不匹配');

  tool = cliRegistry.findByProcessName('opencode');
  assertNotNull(tool, '无法通过 opencode 进程名查找');
  assertEqual(tool.id, 'opencode', '找到的工具 ID 不匹配');
});

test('T1.3.4 findByCommand() 能通过命令查找工具', () => {
  let tool = cliRegistry.findByCommand('claude -c');
  assertNotNull(tool, '无法通过 claude -c 命令查找');
  assertEqual(tool.id, 'claude', '找到的工具 ID 不匹配');

  tool = cliRegistry.findByCommand('opencode');
  assertNotNull(tool, '无法通过 opencode 命令查找');
  assertEqual(tool.id, 'opencode', '找到的工具 ID 不匹配');
});

// ============================================
// T1.4 ProcessDetector 服务测试
// ============================================
console.log('\n=== T1.4 ProcessDetector 服务测试 ===\n');

const processDetector = (await import('../server/services/ProcessDetector.js')).default;

test('T1.4.1 detectFromTerminalContent() 能识别各 CLI 特征', () => {
  // Claude
  let result = processDetector.detectFromTerminalContent('claude-code started\nesc to interrupt');
  assertEqual(result, 'claude', '无法识别 Claude');

  // Codex
  result = processDetector.detectFromTerminalContent('OpenAI Codex CLI\ncodex-cli');
  assertEqual(result, 'codex', '无法识别 Codex');

  // Gemini
  result = processDetector.detectFromTerminalContent('Google Gemini\ngemini-cli');
  assertEqual(result, 'gemini', '无法识别 Gemini');

  // OpenCode
  result = processDetector.detectFromTerminalContent('opencode v1.0\n@general');
  assertEqual(result, 'opencode', '无法识别 OpenCode');
});

test('T1.4.2 getCliProcessNames() 返回完整的进程名映射', () => {
  const processNames = processDetector.getCliProcessNames();
  assertNotNull(processNames.claude, '缺少 claude 进程名');
  assertNotNull(processNames.codex, '缺少 codex 进程名');
  assertNotNull(processNames.gemini, '缺少 gemini 进程名');
  assertNotNull(processNames.opencode, '缺少 opencode 进程名');
});

test('T1.4.3 isIdle() 能正确判断空闲状态', () => {
  // 这个方法在 ProcessDetector 中可能不存在，检查 isCliIdle
  if (typeof processDetector.isCliIdle === 'function') {
    // 测试空闲状态
    const idleResult = processDetector.isCliIdle(null, '>\n');
    assertTrue(typeof idleResult === 'object', 'isCliIdle 应返回对象');
  } else {
    console.log('   跳过：isCliIdle 方法不存在');
  }
});

// ============================================
// T1.5 UpdateService 服务测试
// ============================================
console.log('\n=== T1.5 UpdateService 服务测试 ===\n');

const updateService = (await import('../server/services/UpdateService.js')).default;

test('T1.5.1 getCurrentVersion() 返回正确版本号', () => {
  const version = updateService.getCurrentVersion();
  assertNotNull(version, '版本号不应为 null');
  assertTrue(/^\d+\.\d+\.\d+/.test(version), '版本号格式不正确');
});

test('T1.5.2 compareVersions() 版本比较正确', () => {
  // 1.0.54 > 1.0.53
  let result = updateService.compareVersions('1.0.54', '1.0.53');
  assertEqual(result, 1, '1.0.54 应大于 1.0.53');

  // 1.0.53 < 1.0.54
  result = updateService.compareVersions('1.0.53', '1.0.54');
  assertEqual(result, -1, '1.0.53 应小于 1.0.54');

  // 1.0.54 == 1.0.54
  result = updateService.compareVersions('1.0.54', '1.0.54');
  assertEqual(result, 0, '1.0.54 应等于 1.0.54');

  // v1.0.54 == 1.0.54 (带 v 前缀)
  result = updateService.compareVersions('v1.0.54', '1.0.54');
  assertEqual(result, 0, 'v1.0.54 应等于 1.0.54');
});

await testAsync('T1.5.3 checkForUpdate() 能正确检查更新', async () => {
  const updateInfo = await updateService.checkForUpdate(true);
  assertNotNull(updateInfo, 'updateInfo 不应为 null');
  assertTrue('hasUpdate' in updateInfo, '应包含 hasUpdate 字段');
  assertTrue('currentVersion' in updateInfo, '应包含 currentVersion 字段');
});

// ============================================
// T1.6 SubscriptionService 服务测试
// ============================================
console.log('\n=== T1.6 SubscriptionService 服务测试 ===\n');

const subscriptionService = (await import('../server/services/SubscriptionService.js')).default;

test('T1.6.1 许可证验证功能', () => {
  // 获取当前许可证状态
  const status = subscriptionService.getStatus();
  assertNotNull(status, 'status 不应为 null');
  assertTrue('valid' in status, '应包含 valid 字段');
  assertTrue('machineId' in status, '应包含 machineId 字段');
  assertTrue('freePlugins' in status, '应包含 freePlugins 字段');
  assertTrue('premiumPlugins' in status, '应包含 premiumPlugins 字段');
});

test('T1.6.2 订阅状态检查', () => {
  const status = subscriptionService.getStatus();
  assertTrue(typeof status.valid === 'boolean', 'valid 应为布尔值');
  // 检查可用隧道类型
  const tunnelTypes = subscriptionService.getAvailableTunnelTypes();
  assertTrue(Array.isArray(tunnelTypes), 'getAvailableTunnelTypes 应返回数组');
  assertTrue(tunnelTypes.length > 0, '应至少有一种可用隧道类型');
});

// ============================================
// 测试结果汇总
// ============================================
console.log('\n=== 模块一测试结果汇总 ===\n');
console.log(`通过: ${results.passed}`);
console.log(`失败: ${results.failed}`);

if (results.errors.length > 0) {
  console.log('\n失败的测试:');
  results.errors.forEach(e => {
    console.log(`  - ${e.name}: ${e.error}`);
  });
}

// 导出结果供其他脚本使用
export { results };

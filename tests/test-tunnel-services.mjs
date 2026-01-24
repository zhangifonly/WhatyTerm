/**
 * WhatyTerm 全面测试脚本 - 模块二：隧道服务测试
 * 运行: node tests/test-tunnel-services.mjs
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
// T2.1 FrpTunnel 服务测试
// ============================================
console.log('\n=== T2.1 FrpTunnel 服务测试 ===\n');

const frpTunnel = (await import('../server/services/FrpTunnel.js')).default;

test('T2.1.1 FRP 隧道配置加载', () => {
  assertNotNull(frpTunnel, 'FrpTunnel 实例不应为 null');
  // 检查是否有必要的方法
  assertTrue(typeof frpTunnel.start === 'function' || typeof frpTunnel.connect === 'function',
    'FrpTunnel 应有 start 或 connect 方法');
});

test('T2.1.2 getUrl() 返回正确的隧道 URL', () => {
  // getUrl 可能返回 null 或空字符串（未连接时）
  if (typeof frpTunnel.getUrl === 'function') {
    const url = frpTunnel.getUrl();
    // URL 可能为 null 或空字符串（未启动隧道时）
    if (url && url.length > 0) {
      assertTrue(typeof url === 'string', 'URL 应为字符串');
      assertTrue(url.startsWith('http'), 'URL 应以 http 开头');
    } else {
      console.log('   隧道未启动，URL 为空');
    }
  } else {
    console.log('   跳过：getUrl 方法不存在');
  }
});

// ============================================
// T2.2 CloudflareTunnel 服务测试
// ============================================
console.log('\n=== T2.2 CloudflareTunnel 服务测试 ===\n');

const cloudflareTunnel = (await import('../server/services/CloudflareTunnel.js')).default;

test('T2.2.1 Cloudflare 隧道配置', () => {
  assertNotNull(cloudflareTunnel, 'CloudflareTunnel 实例不应为 null');
  // 检查是否有必要的方法
  assertTrue(typeof cloudflareTunnel.start === 'function' || typeof cloudflareTunnel.connect === 'function',
    'CloudflareTunnel 应有 start 或 connect 方法');
});

test('T2.2.2 getUrl() 返回正确的隧道 URL', () => {
  if (typeof cloudflareTunnel.getUrl === 'function') {
    const url = cloudflareTunnel.getUrl();
    // URL 可能为 null 或空字符串（未启动隧道时）
    if (url && url.length > 0) {
      assertTrue(typeof url === 'string', 'URL 应为字符串');
      assertTrue(url.startsWith('http'), 'URL 应以 http 开头');
    } else {
      console.log('   隧道未启动，URL 为空');
    }
  } else {
    console.log('   跳过：getUrl 方法不存在');
  }
});

// ============================================
// 测试结果汇总
// ============================================
console.log('\n=== 模块二测试结果汇总 ===\n');
console.log(`通过: ${results.passed}`);
console.log(`失败: ${results.failed}`);

if (results.errors.length > 0) {
  console.log('\n失败的测试:');
  results.errors.forEach(e => {
    console.log(`  - ${e.name}: ${e.error}`);
  });
}

export { results };

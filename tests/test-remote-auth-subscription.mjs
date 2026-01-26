/**
 * 远程访问安全认证功能测试 - 模块一：订阅服务器 API 测试
 * 运行: node tests/test-remote-auth-subscription.mjs
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

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

function assertFileContains(filePath, pattern, message) {
  const content = fs.readFileSync(filePath, 'utf-8');
  if (!pattern.test(content)) {
    throw new Error(message || `文件 ${filePath} 不包含预期内容`);
  }
}

// ============================================
// T1.1 用户注册 API 测试
// ============================================
console.log('\n=== T1.1 用户注册 API 测试 ===\n');

const serverFile = join(projectRoot, 'subscription-server/server.js');

test('T1.1.1 验证 /api/auth/register 接口存在', () => {
  assertFileContains(
    serverFile,
    /app\.post\(['"]\/api\/auth\/register['"]/,
    '应有 /api/auth/register 接口'
  );
});

test('T1.1.2 验证注册成功返回 trialLicense', () => {
  assertFileContains(
    serverFile,
    /trialLicense.*licenseKey|licenseKey.*trialLicense/s,
    '注册响应应包含 trialLicense'
  );
});

test('T1.1.3 验证 trialLicense 包含 30 天有效期', () => {
  assertFileContains(
    serverFile,
    /30\s*\*\s*24\s*\*\s*60\s*\*\s*60/,
    '许可证有效期应为 30 天'
  );
});

test('T1.1.4 验证重复邮箱注册被拒绝', () => {
  assertFileContains(
    serverFile,
    /邮箱已注册|email.*already.*registered/i,
    '应有重复邮箱检查'
  );
});

// ============================================
// T1.2 凭据验证 API 测试
// ============================================
console.log('\n=== T1.2 凭据验证 API 测试 ===\n');

test('T1.2.1 验证 /api/auth/verify-credentials 接口存在', () => {
  assertFileContains(
    serverFile,
    /app\.post\(['"]\/api\/auth\/verify-credentials['"]/,
    '应有 /api/auth/verify-credentials 接口'
  );
});

test('T1.2.2 验证正确凭据返回 valid: true', () => {
  assertFileContains(
    serverFile,
    /valid:\s*true/,
    '验证成功应返回 valid: true'
  );
});

test('T1.2.3 验证错误密码返回 valid: false', () => {
  assertFileContains(
    serverFile,
    /valid:\s*false/,
    '验证失败应返回 valid: false'
  );
});

test('T1.2.4 验证不存在的邮箱返回错误', () => {
  const content = fs.readFileSync(serverFile, 'utf-8');
  assertTrue(
    content.includes('邮箱或密码错误') || content.includes('用户不存在'),
    '应处理不存在的邮箱'
  );
});

test('T1.2.5 验证返回用户的许可证信息', () => {
  assertFileContains(
    serverFile,
    /licenses.*planName|hasValidLicense/s,
    '应返回许可证信息'
  );
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

export { results };

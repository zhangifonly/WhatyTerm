/**
 * 远程访问安全认证功能测试 - 模块二：客户端 AuthService 测试
 * 运行: node tests/test-remote-auth-client.mjs
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
// T2.1 在线凭据验证测试
// ============================================
console.log('\n=== T2.1 在线凭据验证测试 ===\n');

const authServiceFile = join(projectRoot, 'server/services/AuthService.js');

test('T2.1.1 验证 verifyOnlineCredentials 方法存在', () => {
  assertFileContains(
    authServiceFile,
    /verifyOnlineCredentials\s*\(/,
    'AuthService 应有 verifyOnlineCredentials 方法'
  );
});

test('T2.1.2 验证能调用订阅服务器 API', () => {
  assertFileContains(
    authServiceFile,
    /\/api\/auth\/verify-credentials/,
    '应调用订阅服务器的 verify-credentials API'
  );
});

// ============================================
// T2.2 登录速率限制测试
// ============================================
console.log('\n=== T2.2 登录速率限制测试 ===\n');

test('T2.2.1 验证 isLocked 方法存在', () => {
  assertFileContains(
    authServiceFile,
    /isLocked\s*\(/,
    'AuthService 应有 isLocked 方法'
  );
});

test('T2.2.2 验证 recordFailedAttempt 方法存在', () => {
  assertFileContains(
    authServiceFile,
    /recordFailedAttempt\s*\(/,
    'AuthService 应有 recordFailedAttempt 方法'
  );
});

test('T2.2.3 验证最大尝试次数为 5', () => {
  assertFileContains(
    authServiceFile,
    /MAX_ATTEMPTS\s*=\s*5/,
    '最大尝试次数应为 5'
  );
});

test('T2.2.4 验证锁定时间为 15 分钟', () => {
  assertFileContains(
    authServiceFile,
    /LOCKOUT_TIME\s*=\s*15\s*\*\s*60\s*\*\s*1000/,
    '锁定时间应为 15 分钟'
  );
});

// ============================================
// 功能测试
// ============================================
console.log('\n=== 功能测试 ===\n');

await testAsync('T2.3.1 验证 AuthService 可以实例化', async () => {
  const { AuthService } = await import('../server/services/AuthService.js');
  const authService = new AuthService();
  assertTrue(authService !== null, 'AuthService 应能实例化');
});

await testAsync('T2.3.2 验证 loginAttempts Map 初始化', async () => {
  const { AuthService } = await import('../server/services/AuthService.js');
  const authService = new AuthService();
  assertTrue(authService.loginAttempts instanceof Map, 'loginAttempts 应为 Map');
});

await testAsync('T2.3.3 验证 isLocked 返回 false（无记录时）', async () => {
  const { AuthService } = await import('../server/services/AuthService.js');
  const authService = new AuthService();
  const locked = authService.isLocked('192.168.1.100');
  assertTrue(locked === false, '无记录时不应锁定');
});

await testAsync('T2.3.4 验证 recordFailedAttempt 返回剩余次数', async () => {
  const { AuthService } = await import('../server/services/AuthService.js');
  const authService = new AuthService();
  const remaining = authService.recordFailedAttempt('192.168.1.101');
  assertTrue(remaining === 4, '第一次失败后剩余 4 次');
});

await testAsync('T2.3.5 验证 5 次失败后被锁定', async () => {
  const { AuthService } = await import('../server/services/AuthService.js');
  const authService = new AuthService();
  const ip = '192.168.1.102';
  for (let i = 0; i < 5; i++) {
    authService.recordFailedAttempt(ip);
  }
  const locked = authService.isLocked(ip);
  assertTrue(locked === true, '5 次失败后应被锁定');
});

await testAsync('T2.3.6 验证 clearAttempts 清除记录', async () => {
  const { AuthService } = await import('../server/services/AuthService.js');
  const authService = new AuthService();
  const ip = '192.168.1.103';
  authService.recordFailedAttempt(ip);
  authService.clearAttempts(ip);
  const locked = authService.isLocked(ip);
  assertTrue(locked === false, '清除后不应锁定');
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

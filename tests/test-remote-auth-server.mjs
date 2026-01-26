/**
 * 远程访问安全认证功能测试 - 模块三：服务端在线登录 API 测试
 * 运行: node tests/test-remote-auth-server.mjs
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
// T3.1 在线登录端点测试
// ============================================
console.log('\n=== T3.1 在线登录端点测试 ===\n');

const serverFile = join(projectRoot, 'server/index.js');

test('T3.1.1 验证 /api/auth/online-login 端点存在', () => {
  assertFileContains(
    serverFile,
    /app\.post\(['"]\/api\/auth\/online-login['"]/,
    '应有 /api/auth/online-login 端点'
  );
});

test('T3.1.2 验证调用 verifyOnlineCredentials', () => {
  assertFileContains(
    serverFile,
    /verifyOnlineCredentials\s*\(/,
    '应调用 verifyOnlineCredentials 方法'
  );
});

test('T3.1.3 验证登录成功设置 session.authenticated', () => {
  assertFileContains(
    serverFile,
    /req\.session\.authenticated\s*=\s*true/,
    '登录成功应设置 session.authenticated = true'
  );
});

test('T3.1.4 验证登录成功设置 session.onlineAuth', () => {
  assertFileContains(
    serverFile,
    /req\.session\.onlineAuth\s*=\s*true/,
    '在线登录应设置 session.onlineAuth = true'
  );
});

test('T3.1.5 验证检查 IP 锁定状态', () => {
  assertFileContains(
    serverFile,
    /isLocked\s*\(/,
    '应检查 IP 锁定状态'
  );
});

test('T3.1.6 验证失败时记录尝试次数', () => {
  assertFileContains(
    serverFile,
    /recordFailedAttempt\s*\(/,
    '失败时应记录尝试次数'
  );
});

test('T3.1.7 验证成功时清除尝试记录', () => {
  assertFileContains(
    serverFile,
    /clearAttempts\s*\(/,
    '成功时应清除尝试记录'
  );
});

test('T3.1.8 验证返回 429 状态码（被锁定时）', () => {
  assertFileContains(
    serverFile,
    /res\.status\(429\)/,
    '被锁定时应返回 429 状态码'
  );
});

test('T3.1.9 验证返回剩余尝试次数', () => {
  assertFileContains(
    serverFile,
    /remainingAttempts/,
    '应返回剩余尝试次数'
  );
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

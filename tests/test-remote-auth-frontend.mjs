/**
 * 远程访问安全认证功能测试 - 模块四：前端登录界面测试
 * 运行: node tests/test-remote-auth-frontend.mjs
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
// T4.1 登录表单测试
// ============================================
console.log('\n=== T4.1 登录表单测试 ===\n');

const appFile = join(projectRoot, 'src/App.jsx');

test('T4.1.1 验证 LoginPage 组件使用邮箱字段', () => {
  assertFileContains(
    appFile,
    /type=["']email["']/,
    'LoginPage 应使用 email 类型输入框'
  );
});

test('T4.1.2 验证 useAuth Hook 包含 onlineLogin 方法', () => {
  assertFileContains(
    appFile,
    /onlineLogin\s*=\s*async/,
    'useAuth Hook 应包含 onlineLogin 方法'
  );
});

test('T4.1.3 验证登录表单调用 onlineLogin', () => {
  assertFileContains(
    appFile,
    /auth\.onlineLogin\s*\(/,
    '登录表单应调用 auth.onlineLogin'
  );
});

test('T4.1.4 验证显示剩余尝试次数', () => {
  assertFileContains(
    appFile,
    /remainingAttempts/,
    '应显示剩余尝试次数'
  );
});

test('T4.1.5 验证有注册链接', () => {
  assertFileContains(
    appFile,
    /term\.whaty\.org/,
    '应有指向 term.whaty.org 的链接'
  );
});

test('T4.1.6 验证有忘记密码链接', () => {
  assertFileContains(
    appFile,
    /forgot-password|忘记密码/,
    '应有忘记密码链接'
  );
});

test('T4.1.7 验证 useAuth 返回 onlineLogin', () => {
  assertFileContains(
    appFile,
    /return\s*\{[^}]*onlineLogin[^}]*\}/s,
    'useAuth 应返回 onlineLogin'
  );
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

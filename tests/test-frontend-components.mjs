/**
 * WhatyTerm 全面测试脚本 - 模块五：前端组件测试
 * 运行: node tests/test-frontend-components.mjs
 *
 * 此测试验证前端组件文件的存在性、导出结构和基本语法
 * 注意：完整的 React 组件测试需要在浏览器环境中运行
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

function assertFileExists(filePath, message) {
  if (!fs.existsSync(filePath)) {
    throw new Error(message || `文件不存在: ${filePath}`);
  }
}

function assertFileContains(filePath, pattern, message) {
  const content = fs.readFileSync(filePath, 'utf-8');
  if (!pattern.test(content)) {
    throw new Error(message || `文件 ${filePath} 不包含预期内容`);
  }
}

// ============================================
// T5.1 App 主组件测试
// ============================================
console.log('\n=== T5.1 App 主组件测试 ===\n');

test('T5.1.1 App.jsx 文件存在', () => {
  assertFileExists(join(projectRoot, 'src/App.jsx'), 'App.jsx 文件不存在');
});

test('T5.1.2 App.jsx 包含 React 组件定义', () => {
  assertFileContains(
    join(projectRoot, 'src/App.jsx'),
    /function\s+App|const\s+App\s*=|export\s+default/,
    'App.jsx 应包含 App 组件定义'
  );
});

test('T5.1.3 main.jsx 入口文件存在', () => {
  assertFileExists(join(projectRoot, 'src/main.jsx'), 'main.jsx 文件不存在');
});

test('T5.1.4 main.jsx 包含 React 渲染逻辑', () => {
  assertFileContains(
    join(projectRoot, 'src/main.jsx'),
    /createRoot|ReactDOM\.render/,
    'main.jsx 应包含 React 渲染逻辑'
  );
});

// ============================================
// T5.2 ProviderManager 组件测试
// ============================================
console.log('\n=== T5.2 ProviderManager 组件测试 ===\n');

test('T5.2.1 ProviderManager.jsx 文件存在', () => {
  assertFileExists(
    join(projectRoot, 'src/components/ProviderManager/ProviderManager.jsx'),
    'ProviderManager.jsx 文件不存在'
  );
});

test('T5.2.2 ProviderManager 包含供应商列表功能', () => {
  assertFileContains(
    join(projectRoot, 'src/components/ProviderManager/ProviderManager.jsx'),
    /providers|ProviderList|供应商/,
    'ProviderManager 应包含供应商列表功能'
  );
});

test('T5.2.3 ProviderEditor.jsx 文件存在', () => {
  assertFileExists(
    join(projectRoot, 'src/components/ProviderManager/ProviderEditor.jsx'),
    'ProviderEditor.jsx 文件不存在'
  );
});

test('T5.2.4 ProviderCard.jsx 文件存在', () => {
  assertFileExists(
    join(projectRoot, 'src/components/ProviderManager/ProviderCard.jsx'),
    'ProviderCard.jsx 文件不存在'
  );
});

test('T5.2.5 ProviderList.jsx 文件存在', () => {
  assertFileExists(
    join(projectRoot, 'src/components/ProviderManager/ProviderList.jsx'),
    'ProviderList.jsx 文件不存在'
  );
});

// ============================================
// T5.3 终端相关组件测试
// ============================================
console.log('\n=== T5.3 终端相关组件测试 ===\n');

test('T5.3.1 TerminalPlayback.jsx 文件存在', () => {
  assertFileExists(
    join(projectRoot, 'src/components/TerminalPlayback.jsx'),
    'TerminalPlayback.jsx 文件不存在'
  );
});

test('T5.3.2 ClosedSessionsList.jsx 文件存在', () => {
  assertFileExists(
    join(projectRoot, 'src/components/ClosedSessionsList.jsx'),
    'ClosedSessionsList.jsx 文件不存在'
  );
});

test('T5.3.3 RecentProjects.jsx 文件存在', () => {
  assertFileExists(
    join(projectRoot, 'src/components/RecentProjects.jsx'),
    'RecentProjects.jsx 文件不存在'
  );
});

// ============================================
// T5.4 其他核心组件测试
// ============================================
console.log('\n=== T5.4 其他核心组件测试 ===\n');

test('T5.4.1 CliToolsManager.jsx 文件存在', () => {
  assertFileExists(
    join(projectRoot, 'src/components/CliToolsManager.jsx'),
    'CliToolsManager.jsx 文件不存在'
  );
});

test('T5.4.2 StorageManager.jsx 文件存在', () => {
  assertFileExists(
    join(projectRoot, 'src/components/StorageManager.jsx'),
    'StorageManager.jsx 文件不存在'
  );
});

test('T5.4.3 ScheduleManager.jsx 文件存在', () => {
  assertFileExists(
    join(projectRoot, 'src/components/ScheduleManager.jsx'),
    'ScheduleManager.jsx 文件不存在'
  );
});

test('T5.4.4 Toast.jsx 文件存在', () => {
  assertFileExists(
    join(projectRoot, 'src/components/Toast.jsx'),
    'Toast.jsx 文件不存在'
  );
});

// ============================================
// T5.5 组件语法验证
// ============================================
console.log('\n=== T5.5 组件语法验证 ===\n');

test('T5.5.1 所有组件文件语法正确（无明显错误）', () => {
  const componentFiles = [
    'src/App.jsx',
    'src/main.jsx',
    'src/components/ProviderManager/ProviderManager.jsx',
    'src/components/CliToolsManager.jsx',
    'src/components/Toast.jsx'
  ];

  for (const file of componentFiles) {
    const filePath = join(projectRoot, file);
    const content = fs.readFileSync(filePath, 'utf-8');

    // 检查基本语法结构
    assertTrue(
      content.includes('import') || content.includes('require'),
      `${file} 应包含导入语句`
    );

    // 检查是否有未闭合的括号（简单检查）
    const openBraces = (content.match(/{/g) || []).length;
    const closeBraces = (content.match(/}/g) || []).length;
    assertTrue(
      openBraces === closeBraces,
      `${file} 括号不匹配: { = ${openBraces}, } = ${closeBraces}`
    );
  }
});

test('T5.5.2 index.html 入口文件存在', () => {
  assertFileExists(join(projectRoot, 'index.html'), 'index.html 文件不存在');
});

test('T5.5.3 index.html 包含 React 挂载点', () => {
  assertFileContains(
    join(projectRoot, 'index.html'),
    /id=["']root["']|id=["']app["']/,
    'index.html 应包含 React 挂载点'
  );
});

// ============================================
// T5.6 Vite 配置测试
// ============================================
console.log('\n=== T5.6 Vite 配置测试 ===\n');

test('T5.6.1 vite.config.js 文件存在', () => {
  assertFileExists(join(projectRoot, 'vite.config.js'), 'vite.config.js 文件不存在');
});

test('T5.6.2 vite.config.js 包含 React 插件配置', () => {
  assertFileContains(
    join(projectRoot, 'vite.config.js'),
    /react|@vitejs\/plugin-react/,
    'vite.config.js 应包含 React 插件配置'
  );
});

// ============================================
// 测试结果汇总
// ============================================
console.log('\n=== 模块五测试结果汇总 ===\n');
console.log(`通过: ${results.passed}`);
console.log(`失败: ${results.failed}`);

if (results.errors.length > 0) {
  console.log('\n失败的测试:');
  results.errors.forEach(e => {
    console.log(`  - ${e.name}: ${e.error}`);
  });
}

export { results };

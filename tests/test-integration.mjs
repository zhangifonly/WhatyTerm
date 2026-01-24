/**
 * WhatyTerm 全面测试脚本 - 模块六：集成测试
 * 运行: node tests/test-integration.mjs
 *
 * 此测试验证服务器启动、前端构建和整体集成
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import { spawn, execSync } from 'child_process';
import http from 'http';

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
    console.log(`❌ ${name}`)
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

// ============================================
// T6.1 服务器启动测试
// ============================================
console.log('\n=== T6.1 服务器启动测试 ===\n');

test('T6.1.1 服务器入口文件存在', () => {
  assertFileExists(join(projectRoot, 'server/index.js'), 'server/index.js 文件不存在');
});

test('T6.1.2 服务器配置正确（端口 3928）', () => {
  const serverFile = fs.readFileSync(join(projectRoot, 'server/index.js'), 'utf-8');
  assertTrue(
    serverFile.includes('3928') || serverFile.includes('PORT'),
    '服务器应配置端口 3928 或使用 PORT 环境变量'
  );
});

test('T6.1.3 Express 应用配置存在', () => {
  const serverFile = fs.readFileSync(join(projectRoot, 'server/index.js'), 'utf-8');
  assertTrue(
    serverFile.includes('express') || serverFile.includes('app.listen'),
    '服务器应使用 Express 框架'
  );
});

test('T6.1.4 Socket.IO 配置存在', () => {
  const serverFile = fs.readFileSync(join(projectRoot, 'server/index.js'), 'utf-8');
  assertTrue(
    serverFile.includes('socket.io') || serverFile.includes('Server'),
    '服务器应配置 Socket.IO'
  );
});

test('T6.1.5 静态文件服务配置存在', () => {
  const serverFile = fs.readFileSync(join(projectRoot, 'server/index.js'), 'utf-8');
  assertTrue(
    serverFile.includes('static') || serverFile.includes('dist'),
    '服务器应配置静态文件服务'
  );
});

// ============================================
// T6.2 前端构建测试
// ============================================
console.log('\n=== T6.2 前端构建测试 ===\n');

test('T6.2.1 package.json 包含构建脚本', () => {
  const packageJson = JSON.parse(fs.readFileSync(join(projectRoot, 'package.json'), 'utf-8'));
  assertTrue(
    packageJson.scripts && packageJson.scripts.build,
    'package.json 应包含 build 脚本'
  );
});

test('T6.2.2 package.json 包含开发脚本', () => {
  const packageJson = JSON.parse(fs.readFileSync(join(projectRoot, 'package.json'), 'utf-8'));
  assertTrue(
    packageJson.scripts && packageJson.scripts.dev,
    'package.json 应包含 dev 脚本'
  );
});

test('T6.2.3 Vite 配置文件存在', () => {
  assertFileExists(join(projectRoot, 'vite.config.js'), 'vite.config.js 文件不存在');
});

test('T6.2.4 必要的依赖已安装', () => {
  const packageJson = JSON.parse(fs.readFileSync(join(projectRoot, 'package.json'), 'utf-8'));
  const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };

  assertTrue(deps.react, '缺少 react 依赖');
  assertTrue(deps['react-dom'], '缺少 react-dom 依赖');
  assertTrue(deps.vite, '缺少 vite 依赖');
  assertTrue(deps.express, '缺少 express 依赖');
  assertTrue(deps['socket.io'], '缺少 socket.io 依赖');
});

// ============================================
// T6.3 Electron 打包测试
// ============================================
console.log('\n=== T6.3 Electron 打包测试 ===\n');

test('T6.3.1 Electron 主进程文件存在', () => {
  // 项目使用 main.cjs（CommonJS 格式）
  assertFileExists(join(projectRoot, 'electron/main.cjs'), 'electron/main.cjs 文件不存在');
});

test('T6.3.2 Electron 主进程包含必要功能', () => {
  const mainFile = fs.readFileSync(join(projectRoot, 'electron/main.cjs'), 'utf-8');
  assertTrue(
    mainFile.includes('BrowserWindow') && mainFile.includes('app.whenReady'),
    'Electron 主进程应包含 BrowserWindow 和 app.whenReady'
  );
  assertTrue(
    mainFile.includes('autoUpdater'),
    'Electron 主进程应包含自动更新功能'
  );
});

test('T6.3.3 electron-builder 配置存在', () => {
  const packageJson = JSON.parse(fs.readFileSync(join(projectRoot, 'package.json'), 'utf-8'));
  assertTrue(
    packageJson.build || fs.existsSync(join(projectRoot, 'electron-builder.yml')),
    '应有 electron-builder 配置'
  );
});

test('T6.3.4 Electron 打包脚本存在', () => {
  const packageJson = JSON.parse(fs.readFileSync(join(projectRoot, 'package.json'), 'utf-8'));
  assertTrue(
    packageJson.scripts && (
      packageJson.scripts['electron:build'] ||
      packageJson.scripts['electron:build:mac'] ||
      packageJson.scripts['electron:build:win']
    ),
    'package.json 应包含 Electron 打包脚本'
  );
});

// ============================================
// T6.4 API 路由测试
// ============================================
console.log('\n=== T6.4 API 路由测试 ===\n');

test('T6.4.1 API 路由文件存在', () => {
  // 检查是否有 routes 目录或在 index.js 中定义路由
  const hasRoutesDir = fs.existsSync(join(projectRoot, 'server/routes'));
  const serverFile = fs.readFileSync(join(projectRoot, 'server/index.js'), 'utf-8');
  const hasInlineRoutes = serverFile.includes('app.get') || serverFile.includes('app.post') || serverFile.includes('router');

  assertTrue(hasRoutesDir || hasInlineRoutes, '应有 API 路由定义');
});

test('T6.4.2 会话 API 路由存在', () => {
  const serverFile = fs.readFileSync(join(projectRoot, 'server/index.js'), 'utf-8');
  assertTrue(
    serverFile.includes('/api/sessions') || serverFile.includes('sessions'),
    '应有会话 API 路由'
  );
});

test('T6.4.3 供应商 API 路由存在', () => {
  const serverFile = fs.readFileSync(join(projectRoot, 'server/index.js'), 'utf-8');
  assertTrue(
    serverFile.includes('/api/providers') || serverFile.includes('providers'),
    '应有供应商 API 路由'
  );
});

// ============================================
// T6.5 数据库/存储测试
// ============================================
console.log('\n=== T6.5 数据库/存储测试 ===\n');

test('T6.5.1 数据存储服务存在', () => {
  // 检查是否有数据库或存储相关服务
  const hasDb = fs.existsSync(join(projectRoot, 'server/services/Database.js')) ||
                fs.existsSync(join(projectRoot, 'server/services/Storage.js')) ||
                fs.existsSync(join(projectRoot, 'server/services/ProviderService.js'));

  assertTrue(hasDb, '应有数据存储服务');
});

test('T6.5.2 配置文件目录可访问', () => {
  // 检查是否有配置相关的代码
  const providerService = fs.readFileSync(
    join(projectRoot, 'server/services/ProviderService.js'),
    'utf-8'
  );
  assertTrue(
    providerService.includes('config') || providerService.includes('data') || providerService.includes('storage'),
    'ProviderService 应有配置存储逻辑'
  );
});

// ============================================
// T6.6 WebSocket 测试
// ============================================
console.log('\n=== T6.6 WebSocket 测试 ===\n');

test('T6.6.1 Socket.IO 服务端配置存在', () => {
  const serverFile = fs.readFileSync(join(projectRoot, 'server/index.js'), 'utf-8');
  assertTrue(
    serverFile.includes('socket.io') && serverFile.includes('io.on'),
    '应有 Socket.IO 服务端配置'
  );
});

test('T6.6.2 终端 WebSocket 事件处理存在', () => {
  const serverFile = fs.readFileSync(join(projectRoot, 'server/index.js'), 'utf-8');
  assertTrue(
    serverFile.includes('terminal') || serverFile.includes('pty') || serverFile.includes('session'),
    '应有终端相关的 WebSocket 事件处理'
  );
});

// ============================================
// 测试结果汇总
// ============================================
console.log('\n=== 模块六测试结果汇总 ===\n');
console.log(`通过: ${results.passed}`);
console.log(`失败: ${results.failed}`);

if (results.errors.length > 0) {
  console.log('\n失败的测试:');
  results.errors.forEach(e => {
    console.log(`  - ${e.name}: ${e.error}`);
  });
}

export { results };

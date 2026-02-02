#!/usr/bin/env node
/**
 * 下载 Windows 预编译原生模块
 * 用于在 macOS 上构建 Windows 版本
 *
 * 注意：此脚本仅用于紧急情况。正常构建应使用 GitHub Actions，
 * 它会在目标平台上运行 electron-rebuild 来编译原生模块。
 *
 * node-pty 没有预构建版本，必须在 Windows 上编译。
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const nodeModulesPath = path.join(__dirname, '..', 'node_modules');

// 需要下载预编译版本的原生模块
const nativeModules = [
  'better-sqlite3',
  'node-pty'
];

// Electron 版本和 Node ABI
const electronVersion = '39.2.7';
const platform = 'win32';
const arch = 'x64';

console.log('下载 Windows 预编译原生模块...');
console.log(`Electron: ${electronVersion}, Platform: ${platform}, Arch: ${arch}`);

for (const moduleName of nativeModules) {
  const modulePath = path.join(nodeModulesPath, moduleName);

  if (!fs.existsSync(modulePath)) {
    console.log(`跳过 ${moduleName}（未安装）`);
    continue;
  }

  console.log(`\n处理 ${moduleName}...`);

  try {
    // 使用 prebuild-install 下载预编译版本
    execSync(
      `npx prebuild-install --platform=${platform} --arch=${arch} --runtime=electron --target=${electronVersion}`,
      {
        cwd: modulePath,
        stdio: 'inherit'
      }
    );
    console.log(`✓ ${moduleName} 预编译版本下载成功`);
  } catch (err) {
    console.error(`✗ ${moduleName} 下载失败:`, err.message);
  }
}

console.log('\n完成！');

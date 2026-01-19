#!/usr/bin/env node
/**
 * 高级插件加密构建脚本
 * 用于混淆和保护闭源的监控策略插件
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

// 免费插件（不加密）
const FREE_PLUGINS = ['DefaultPlugin.js', 'BasePlugin.js'];

// 源目录和目标目录
const PLUGINS_SRC = path.join(rootDir, 'server/services/MonitorPlugins/plugins');
const PLUGINS_DIST = path.join(rootDir, 'dist/server/services/MonitorPlugins/plugins');

// 混淆配置
const OBFUSCATOR_CONFIG = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.75,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.4,
  debugProtection: false,
  disableConsoleOutput: false,
  identifierNamesGenerator: 'hexadecimal',
  log: false,
  numbersToExpressions: true,
  renameGlobals: false,
  selfDefending: true,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 10,
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayEncoding: ['base64'],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 2,
  stringArrayWrappersChainedCalls: true,
  stringArrayWrappersParametersMaxCount: 4,
  stringArrayWrappersType: 'function',
  stringArrayThreshold: 0.75,
  transformObjectKeys: true,
  unicodeEscapeSequence: false
};

/**
 * 检查并安装依赖
 */
function checkDependencies() {
  try {
    require.resolve('javascript-obfuscator');
  } catch (e) {
    console.log('正在安装 javascript-obfuscator...');
    execSync('npm install --save-dev javascript-obfuscator', {
      cwd: rootDir,
      stdio: 'inherit'
    });
  }
}

/**
 * 确保目录存在
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * 混淆单个文件
 */
async function obfuscateFile(srcPath, destPath) {
  const JavaScriptObfuscator = (await import('javascript-obfuscator')).default;

  const code = fs.readFileSync(srcPath, 'utf-8');
  const obfuscatedCode = JavaScriptObfuscator.obfuscate(code, OBFUSCATOR_CONFIG);

  // 添加许可证头
  const header = `/**
 * WhatyTerm Premium Plugin
 * Copyright (c) 2025 WhatyTerm
 * This file is proprietary and requires a valid subscription.
 * Unauthorized use, copying, or distribution is prohibited.
 *
 * 此文件为 WhatyTerm 专有组件，需要有效订阅才能使用。
 * 未经授权的使用、复制或分发是被禁止的。
 */
`;

  fs.writeFileSync(destPath, header + obfuscatedCode.getObfuscatedCode());
  console.log(`  ✓ 已加密: ${path.basename(srcPath)}`);
}

/**
 * 复制免费插件（不加密）
 */
function copyFreePlugin(srcPath, destPath) {
  const code = fs.readFileSync(srcPath, 'utf-8');

  // 添加开源许可证头
  const header = `/**
 * WhatyTerm Open Source Plugin
 * Copyright (c) 2025 WhatyTerm
 * Licensed under the MIT License
 *
 * 此文件为 WhatyTerm 开源组件，遵循 MIT 许可证。
 */
`;

  fs.writeFileSync(destPath, header + code);
  console.log(`  ○ 已复制: ${path.basename(srcPath)} (免费插件)`);
}

/**
 * 构建所有插件
 */
async function buildPlugins() {
  console.log('\n========================================');
  console.log('WhatyTerm 高级插件加密构建');
  console.log('========================================\n');

  // 确保目标目录存在
  ensureDir(PLUGINS_DIST);

  // 获取所有插件文件
  const files = fs.readdirSync(PLUGINS_SRC).filter(f => f.endsWith('.js'));

  console.log(`找到 ${files.length} 个插件文件\n`);

  let freeCount = 0;
  let premiumCount = 0;

  for (const file of files) {
    const srcPath = path.join(PLUGINS_SRC, file);
    const destPath = path.join(PLUGINS_DIST, file);

    if (FREE_PLUGINS.includes(file)) {
      // 免费插件直接复制
      copyFreePlugin(srcPath, destPath);
      freeCount++;
    } else {
      // 高级插件进行混淆
      await obfuscateFile(srcPath, destPath);
      premiumCount++;
    }
  }

  // 复制其他必要文件
  const otherFiles = ['index.js', 'BasePlugin.js'];
  const monitorPluginsDir = path.join(rootDir, 'server/services/MonitorPlugins');
  const monitorPluginsDist = path.join(rootDir, 'dist/server/services/MonitorPlugins');

  ensureDir(monitorPluginsDist);

  for (const file of otherFiles) {
    const srcPath = path.join(monitorPluginsDir, file);
    const destPath = path.join(monitorPluginsDist, file);
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, destPath);
      console.log(`  ○ 已复制: ${file}`);
    }
  }

  console.log('\n========================================');
  console.log(`构建完成！`);
  console.log(`  免费插件: ${freeCount} 个`);
  console.log(`  高级插件: ${premiumCount} 个（已加密）`);
  console.log('========================================\n');
}

/**
 * 主函数
 */
async function main() {
  try {
    await buildPlugins();
  } catch (error) {
    console.error('构建失败:', error);
    process.exit(1);
  }
}

main();

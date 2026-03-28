/**
 * electron-builder afterPack 钩子
 * 为目标架构重新编译 better-sqlite3
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

module.exports = async function (context) {
  const { appOutDir, arch, electronPlatformName } = context;

  if (electronPlatformName !== 'darwin') return;

  const archName = arch === 1 ? 'x64' : 'arm64';
  const currentArch = process.arch;

  console.log(`[rebuild-native] 目标: ${archName}, 当前: ${currentArch}`);

  if (archName === currentArch) {
    console.log(`[rebuild-native] 架构相同，跳过`);
    return;
  }

  const resourcesDir = path.join(
    appOutDir, 'WhatyTerm.app', 'Contents', 'Resources'
  );
  const sqliteDir = path.join(resourcesDir, 'node_modules', 'better-sqlite3');

  if (!fs.existsSync(sqliteDir)) {
    console.log(`[rebuild-native] better-sqlite3 不存在，跳过`);
    return;
  }

  const electronVersion =
    require('../node_modules/electron/package.json').version;

  console.log(`[rebuild-native] 重编译 better-sqlite3 (${archName})...`);

  try {
    // 使用 node-gyp 交叉编译
    execSync(
      `cd "${sqliteDir}" && npx --yes node-gyp rebuild ` +
      `--target=${electronVersion} ` +
      `--arch=${archName} ` +
      `--dist-url=https://electronjs.org/headers ` +
      `--runtime=electron`,
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          npm_config_arch: archName,
          npm_config_target_arch: archName,
          GYP_DEFINES: `target_arch=${archName}`,
        },
        timeout: 120000,
      }
    );
    console.log(`[rebuild-native] better-sqlite3 编译成功`);
  } catch (err) {
    console.error(`[rebuild-native] 编译失败: ${err.message}`);
    // 不阻止构建，但打包出来的 x64 版本会有问题
    console.error(`[rebuild-native] ⚠️ x64 版本的 better-sqlite3 可能不可用`);
  }
};

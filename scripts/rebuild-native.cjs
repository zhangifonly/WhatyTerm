/**
 * electron-builder afterPack 钩子
 * macOS: 交叉编译 better-sqlite3（x64 <-> arm64）
 * Windows: 从 GitHub Releases 下载预编译 win32-x64 二进制
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

module.exports = async function (context) {
  const { appOutDir, arch, electronPlatformName } = context;

  if (electronPlatformName === 'darwin') {
    await handleMac(appOutDir, arch);
  } else if (electronPlatformName === 'win32') {
    await handleWin(appOutDir, arch);
  }

  // 清理 node-pty 非目标平台预编译二进制
  cleanNodePtyPrebuilds(appOutDir, electronPlatformName);
};

function cleanNodePtyPrebuilds(appOutDir, platform) {
  const isWin = platform === 'win32';
  const isLinux = platform === 'linux';
  const resourcesDir = isWin
    ? path.join(appOutDir, 'resources')
    : isLinux
      ? path.join(appOutDir, 'resources')
      : path.join(appOutDir, 'WhatyTerm.app', 'Contents', 'Resources');
  const prebuildsDir = path.join(resourcesDir, 'node_modules', 'node-pty', 'prebuilds');

  if (!fs.existsSync(prebuildsDir)) return;

  const keepPrefix = isWin ? 'win32' : isLinux ? 'linux' : 'darwin';
  for (const entry of fs.readdirSync(prebuildsDir)) {
    if (!entry.startsWith(keepPrefix)) {
      const fullPath = path.join(prebuildsDir, entry);
      fs.rmSync(fullPath, { recursive: true, force: true });
      console.log(`[rebuild-native] 清理无用预编译: node-pty/prebuilds/${entry}`);
    }
  }
}

async function handleMac(appOutDir, arch) {
  const archName = arch === 1 ? 'x64' : 'arm64';
  const currentArch = process.arch;

  console.log(`[rebuild-native] 目标: ${archName}, 当前: ${currentArch}`);

  if (archName === currentArch) {
    console.log(`[rebuild-native] 架构相同，跳过`);
    return;
  }

  const resourcesDir = path.join(appOutDir, 'WhatyTerm.app', 'Contents', 'Resources');
  const sqliteDir = path.join(resourcesDir, 'node_modules', 'better-sqlite3');

  if (!fs.existsSync(sqliteDir)) {
    console.log(`[rebuild-native] better-sqlite3 不存在，跳过`);
    return;
  }

  const electronVersion = require('../node_modules/electron/package.json').version;
  console.log(`[rebuild-native] 重编译 better-sqlite3 (${archName})...`);

  try {
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
  }
}

async function handleWin(appOutDir, arch) {
  // Windows 无法在 macOS 上交叉编译，从 GitHub Releases 下载预编译二进制
  const archName = arch === 1 ? 'x64' : 'arm64';
  console.log(`[rebuild-native] Windows ${archName}: 下载预编译 better-sqlite3...`);

  const resourcesDir = path.join(appOutDir, 'resources');
  const sqliteDir = path.join(resourcesDir, 'node_modules', 'better-sqlite3');
  const nodeFile = path.join(sqliteDir, 'build', 'Release', 'better_sqlite3.node');

  if (!fs.existsSync(sqliteDir)) {
    console.log(`[rebuild-native] better-sqlite3 不存在，跳过`);
    return;
  }

  const sqliteVersion = require('../node_modules/better-sqlite3/package.json').version;
  const electronPkg = require('../node_modules/electron/package.json');

  // 从 Electron 二进制读取真实 NODE_MODULE_VERSION，避免公式计算错误
  let abi;
  try {
    const electronBin = require('../node_modules/electron');
    const result = execSync(
      `"${electronBin}" -e "process.stdout.write(process.versions.modules)"`,
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 10000 }
    ).toString().trim();
    abi = result;
    console.log(`[rebuild-native] Electron ${electronPkg.version} -> ABI v${abi}`);
  } catch (e) {
    // fallback: 查表，已知映射
    const major = parseInt(electronPkg.version.split('.')[0]);
    const abiMap = { 36: 137, 37: 137, 38: 139, 39: 140, 40: 140 };
    abi = abiMap[major] ?? (major + 101);
    console.log(`[rebuild-native] ABI 查表: Electron ${major} -> v${abi}`);
  }

  const tarName = `better-sqlite3-v${sqliteVersion}-electron-v${abi}-win32-${archName}.tar.gz`;
  const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${sqliteVersion}/${tarName}`;

  console.log(`[rebuild-native] 下载: ${url}`);

  const tmpTar = path.join(require('os').tmpdir(), tarName);
  const tmpDir = path.join(require('os').tmpdir(), `sqlite-win-${Date.now()}`);

  try {
    // 下载（自动尝试本地代理 127.0.0.1:7890）
    let downloaded = false;
    for (const proxy of ['', '--proxy http://127.0.0.1:7890', '--proxy http://127.0.0.1:1087']) {
      try {
        execSync(`curl -fsSL ${proxy} "${url}" -o "${tmpTar}"`, { stdio: 'inherit', timeout: 60000 });
        downloaded = true;
        break;
      } catch {}
    }
    if (!downloaded) throw new Error(`无法下载 ${url}，请检查网络或手动放置 better_sqlite3.node`);

    // 解压
    fs.mkdirSync(tmpDir, { recursive: true });
    execSync(`tar -xzf "${tmpTar}" -C "${tmpDir}"`, { stdio: 'inherit' });

    // 找到 .node 文件并替换
    const extracted = fs.readdirSync(tmpDir, { recursive: true })
      .find(f => f.toString().endsWith('better_sqlite3.node'));

    if (!extracted) throw new Error('解压后未找到 better_sqlite3.node');

    const src = path.join(tmpDir, extracted.toString());
    fs.mkdirSync(path.dirname(nodeFile), { recursive: true });
    fs.copyFileSync(src, nodeFile);

    console.log(`[rebuild-native] Windows better-sqlite3 替换成功: ${nodeFile}`);
  } catch (err) {
    console.error(`[rebuild-native] Windows 预编译包下载失败: ${err.message}`);
    console.error(`[rebuild-native] ⚠️ Windows 版本的 better-sqlite3 可能不可用`);
  } finally {
    try { fs.rmSync(tmpTar, { force: true }); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

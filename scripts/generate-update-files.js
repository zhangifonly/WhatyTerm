#!/usr/bin/env node

/**
 * 生成 electron-updater 所需的 latest.yml 和 latest.json 文件
 *
 * 使用方法:
 *   node scripts/generate-update-files.js
 *
 * 这个脚本会在 release 目录下生成:
 *   - latest.yml (electron-updater 使用)
 *   - latest-mac.yml (macOS 更新)
 *   - latest.json (自定义更新服务器使用)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 读取 package.json 获取版本号
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf-8'));
const version = packageJson.version;

// 发布目录
const releaseDir = path.join(__dirname, '../release');

// 计算文件的 SHA512 哈希
function calculateSha512(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const hashSum = crypto.createHash('sha512');
  hashSum.update(fileBuffer);
  return hashSum.digest('base64');
}

// 获取文件大小
function getFileSize(filePath) {
  const stats = fs.statSync(filePath);
  return stats.size;
}

// 查找发布文件
function findReleaseFiles() {
  const files = fs.readdirSync(releaseDir);
  const result = {
    mac: {
      dmg: null,
      dmgArm64: null,
      zip: null,
      zipArm64: null
    },
    win: {
      exe: null
    },
    linux: {
      appImage: null,
      deb: null
    }
  };

  for (const file of files) {
    const filePath = path.join(releaseDir, file);

    // macOS
    if (file.endsWith('.dmg')) {
      if (file.includes('arm64')) {
        result.mac.dmgArm64 = { name: file, path: filePath };
      } else {
        result.mac.dmg = { name: file, path: filePath };
      }
    }
    if (file.endsWith('.zip') && file.includes('mac')) {
      if (file.includes('arm64')) {
        result.mac.zipArm64 = { name: file, path: filePath };
      } else {
        result.mac.zip = { name: file, path: filePath };
      }
    }

    // Windows
    if (file.endsWith('.exe') && file.includes('Setup')) {
      result.win.exe = { name: file, path: filePath };
    }

    // Linux
    if (file.endsWith('.AppImage')) {
      result.linux.appImage = { name: file, path: filePath };
    }
    if (file.endsWith('.deb')) {
      result.linux.deb = { name: file, path: filePath };
    }
  }

  return result;
}

// 生成 latest-mac.yml
function generateMacYml(files) {
  const macFile = files.mac.zip || files.mac.dmg;
  const macArm64File = files.mac.zipArm64 || files.mac.dmgArm64;

  if (!macFile) {
    console.log('未找到 macOS 发布文件，跳过 latest-mac.yml');
    return;
  }

  const yml = `version: ${version}
files:
  - url: ${macFile.name}
    sha512: ${calculateSha512(macFile.path)}
    size: ${getFileSize(macFile.path)}
${macArm64File ? `  - url: ${macArm64File.name}
    sha512: ${calculateSha512(macArm64File.path)}
    size: ${getFileSize(macArm64File.path)}
    arch: arm64` : ''}
path: ${macFile.name}
sha512: ${calculateSha512(macFile.path)}
releaseDate: ${new Date().toISOString()}
`;

  fs.writeFileSync(path.join(releaseDir, 'latest-mac.yml'), yml);
  console.log('已生成 latest-mac.yml');
}

// 生成 latest.yml (Windows)
function generateWinYml(files) {
  const winFile = files.win.exe;

  if (!winFile) {
    console.log('未找到 Windows 发布文件，跳过 latest.yml');
    return;
  }

  const yml = `version: ${version}
files:
  - url: ${winFile.name}
    sha512: ${calculateSha512(winFile.path)}
    size: ${getFileSize(winFile.path)}
path: ${winFile.name}
sha512: ${calculateSha512(winFile.path)}
releaseDate: ${new Date().toISOString()}
`;

  fs.writeFileSync(path.join(releaseDir, 'latest.yml'), yml);
  console.log('已生成 latest.yml');
}

// 生成 latest-linux.yml
function generateLinuxYml(files) {
  const linuxFile = files.linux.appImage;

  if (!linuxFile) {
    console.log('未找到 Linux 发布文件，跳过 latest-linux.yml');
    return;
  }

  const yml = `version: ${version}
files:
  - url: ${linuxFile.name}
    sha512: ${calculateSha512(linuxFile.path)}
    size: ${getFileSize(linuxFile.path)}
path: ${linuxFile.name}
sha512: ${calculateSha512(linuxFile.path)}
releaseDate: ${new Date().toISOString()}
`;

  fs.writeFileSync(path.join(releaseDir, 'latest-linux.yml'), yml);
  console.log('已生成 latest-linux.yml');
}

// 生成 latest.json (自定义格式，用于 Web 检查更新)
function generateLatestJson(files) {
  const json = {
    version: version,
    releaseDate: new Date().toISOString(),
    notes: `WhatyTerm v${version} 发布`,
    platforms: {}
  };

  // macOS
  if (files.mac.dmg) {
    json.platforms['darwin-x64'] = {
      url: files.mac.dmg.name,
      sha512: calculateSha512(files.mac.dmg.path),
      size: getFileSize(files.mac.dmg.path)
    };
  }
  if (files.mac.dmgArm64) {
    json.platforms['darwin-arm64'] = {
      url: files.mac.dmgArm64.name,
      sha512: calculateSha512(files.mac.dmgArm64.path),
      size: getFileSize(files.mac.dmgArm64.path)
    };
  }

  // Windows
  if (files.win.exe) {
    json.platforms['win32-x64'] = {
      url: files.win.exe.name,
      sha512: calculateSha512(files.win.exe.path),
      size: getFileSize(files.win.exe.path)
    };
  }

  // Linux
  if (files.linux.appImage) {
    json.platforms['linux-x64'] = {
      url: files.linux.appImage.name,
      sha512: calculateSha512(files.linux.appImage.path),
      size: getFileSize(files.linux.appImage.path)
    };
  }

  fs.writeFileSync(
    path.join(releaseDir, 'latest.json'),
    JSON.stringify(json, null, 2)
  );
  console.log('已生成 latest.json');
}

// 主函数
function main() {
  console.log(`\n生成 WhatyTerm v${version} 更新文件...\n`);

  if (!fs.existsSync(releaseDir)) {
    console.error('错误: release 目录不存在，请先运行构建');
    process.exit(1);
  }

  const files = findReleaseFiles();

  console.log('找到的发布文件:');
  console.log('  macOS DMG:', files.mac.dmg?.name || '无');
  console.log('  macOS DMG (ARM64):', files.mac.dmgArm64?.name || '无');
  console.log('  Windows EXE:', files.win.exe?.name || '无');
  console.log('  Linux AppImage:', files.linux.appImage?.name || '无');
  console.log('');

  generateMacYml(files);
  generateWinYml(files);
  generateLinuxYml(files);
  generateLatestJson(files);

  console.log('\n完成！请将 release 目录下的文件上传到更新服务器。');
  console.log('更新服务器 URL: https://term.whaty.org/releases/');
}

main();

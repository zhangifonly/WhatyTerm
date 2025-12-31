/**
 * DependencyManager - 管理第三方依赖的下载和安装
 *
 * 支持的依赖：
 * - frpc: FRP 内网穿透客户端
 * - cloudflared: Cloudflare Tunnel 客户端
 *
 * 支持的 CLI 工具（通过 npm 安装）：
 * - claude: Claude Code CLI (@anthropic-ai/claude-code)
 * - codex: Codex CLI (@openai/codex)
 * - gemini: Gemini CLI (@anthropic-ai/claude-code 或 @google/gemini-cli)
 */

import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import https from 'https';
import { createWriteStream, createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import { createGunzip } from 'zlib';

class DependencyManager {
  constructor() {
    // 依赖存放目录
    this.binDir = path.join(os.homedir(), '.webtmux', 'bin');
    this.isWindows = process.platform === 'win32';
    this.isMac = process.platform === 'darwin';
    this.arch = process.arch === 'arm64' ? 'arm64' : 'amd64';

    // 内置二进制文件目录（打包在应用中）
    this.bundledBinDir = this._getBundledBinDir();

    // 确保目录存在
    if (!fs.existsSync(this.binDir)) {
      fs.mkdirSync(this.binDir, { recursive: true });
    }

    // 二进制依赖配置（直接下载）
    this.dependencies = {
      frpc: {
        name: 'frpc',
        description: 'FRP 内网穿透客户端',
        version: '0.65.0',
        getUrl: () => this._getFrpcUrl(),
        getExecutable: () => this.isWindows ? 'frpc.exe' : 'frpc',
        extract: 'tar.gz', // Windows 也是 tar.gz
        stripComponents: 1, // 解压时去掉顶层目录
      },
      cloudflared: {
        name: 'cloudflared',
        description: 'Cloudflare Tunnel 客户端',
        version: '2024.1.5',
        getUrl: () => this._getCloudflaredUrl(),
        getExecutable: () => this.isWindows ? 'cloudflared.exe' : 'cloudflared',
        extract: null, // 直接是可执行文件
      }
    };

    // CLI 工具配置（通过 npm 安装）
    this.cliTools = {
      claude: {
        name: 'Claude Code',
        description: 'Claude Code CLI - Anthropic 官方命令行工具',
        npmPackage: '@anthropic-ai/claude-code',
        command: 'claude',
        checkVersion: () => this._getCliVersion('claude', '--version'),
        // Claude Code 支持原生安装器
        nativeInstaller: 'curl -fsSL https://claude.ai/install.sh | bash',
      },
      codex: {
        name: 'Codex CLI',
        description: 'Codex CLI - OpenAI 官方命令行工具',
        npmPackage: '@openai/codex',
        command: 'codex',
        checkVersion: () => this._getCliVersion('codex', '--version'),
      },
      gemini: {
        name: 'Gemini CLI',
        description: 'Gemini CLI - Google 官方命令行工具',
        npmPackage: '@google/gemini-cli',
        command: 'gemini',
        checkVersion: () => this._getCliVersion('gemini', '--version'),
      }
    };

    // 系统工具配置（需要单独安装）
    this.systemTools = {
      git: {
        name: 'Git',
        description: 'Git 版本控制系统',
        command: 'git',
        checkVersion: () => this._getCliVersion('git', '--version'),
        // Windows 安装方式
        windowsInstaller: {
          // Git for Windows 官方安装包
          downloadUrl: 'https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.2/Git-2.47.1.2-64-bit.exe',
          // winget 安装命令
          wingetCommand: 'winget install --id Git.Git -e --source winget',
          // 便携版（不需要管理员权限）
          portableUrl: 'https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.2/PortableGit-2.47.1.2-64-bit.7z.exe',
        },
        // macOS 安装方式
        macInstaller: {
          brewCommand: 'brew install git',
          // Xcode Command Line Tools
          xcodeCommand: 'xcode-select --install',
        },
        // Linux 安装方式
        linuxInstaller: {
          aptCommand: 'sudo apt-get install -y git',
          yumCommand: 'sudo yum install -y git',
          dnfCommand: 'sudo dnf install -y git',
        }
      }
    };

    // 检测 WSL 环境
    this.isWSL = this._detectWSL();
  }

  /**
   * 检测是否在 WSL 环境中运行
   */
  _detectWSL() {
    if (this.isWindows) return false;

    try {
      // 检查 /proc/version 是否包含 Microsoft 或 WSL
      const procVersion = fs.readFileSync('/proc/version', 'utf-8').toLowerCase();
      return procVersion.includes('microsoft') || procVersion.includes('wsl');
    } catch {
      return false;
    }
  }

  /**
   * 获取内置二进制文件目录
   * 根据平台返回对应的目录路径
   */
  _getBundledBinDir() {
    // 获取应用根目录
    let appRoot;

    // 检测是否在 Electron 打包环境中
    if (process.resourcesPath) {
      // Electron 打包后，server 目录在 resources 目录下（extraResources）
      appRoot = process.resourcesPath;
    } else {
      // 开发环境，使用当前文件的相对路径
      appRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
    }

    // 根据平台选择目录
    let platformDir;
    if (this.isWindows) {
      platformDir = 'windows';
    } else if (this.isMac) {
      platformDir = 'darwin';
    } else {
      platformDir = 'linux';
    }

    return path.join(appRoot, 'server', 'bin', platformDir);
  }

  /**
   * 获取内置二进制文件路径
   * @param {string} name - 依赖名称
   * @returns {string|null} 内置文件路径，不存在则返回 null
   */
  getBundledExecutablePath(name) {
    const dep = this.dependencies[name];
    if (!dep) return null;

    const executable = dep.getExecutable();
    const bundledPath = path.join(this.bundledBinDir, executable);

    console.log(`[DependencyManager] 检查内置 ${name}: ${bundledPath}`);

    if (fs.existsSync(bundledPath)) {
      console.log(`[DependencyManager] 找到内置 ${name}: ${bundledPath}`);
      return bundledPath;
    }
    console.log(`[DependencyManager] 内置 ${name} 不存在: ${bundledPath}`);
    return null;
  }

  /**
   * 检测 WSL 环境是否可用（Windows 上）
   */
  isWSLAvailable() {
    if (!this.isWindows) return false;

    try {
      execSync('wsl --status', { stdio: 'pipe', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 在 WSL 中执行命令
   */
  _execInWSL(command, options = {}) {
    const wslCommand = `wsl bash -c "${command.replace(/"/g, '\\"')}"`;
    return execSync(wslCommand, {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 60000,
      ...options
    });
  }

  /**
   * 检查 WSL 中是否安装了 Node.js
   */
  checkWSLNodeInstalled() {
    if (!this.isWindows) return false;

    try {
      const output = this._execInWSL('node --version');
      const version = output.trim();
      console.log(`[DependencyManager] WSL Node.js 版本: ${version}`);
      return version.startsWith('v');
    } catch {
      return false;
    }
  }

  /**
   * 检查 WSL 中是否安装了 nvm
   */
  checkWSLNvmInstalled() {
    if (!this.isWindows) return false;

    try {
      this._execInWSL('source ~/.nvm/nvm.sh && nvm --version');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 在 WSL 中安装 nvm 和 Node.js
   */
  async installWSLNodeEnvironment(progressCallback = null) {
    if (!this.isWindows) {
      throw new Error('此方法仅适用于 Windows WSL 环境');
    }

    try {
      // 检查 nvm
      if (!this.checkWSLNvmInstalled()) {
        if (progressCallback) progressCallback('正在安装 nvm...');
        console.log('[DependencyManager] 在 WSL 中安装 nvm...');

        this._execInWSL('curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash', {
          timeout: 120000
        });
      }

      // 检查 Node.js
      if (!this.checkWSLNodeInstalled()) {
        if (progressCallback) progressCallback('正在安装 Node.js LTS...');
        console.log('[DependencyManager] 在 WSL 中安装 Node.js LTS...');

        this._execInWSL('source ~/.nvm/nvm.sh && nvm install --lts && nvm alias default node', {
          timeout: 300000 // 5 分钟超时
        });
      }

      console.log('[DependencyManager] WSL Node.js 环境安装完成');
      return true;
    } catch (err) {
      console.error('[DependencyManager] WSL Node.js 环境安装失败:', err.message);
      return false;
    }
  }

  /**
   * 检查 CLI 工具是否已安装（支持 WSL）
   */
  isCliInstalled(name) {
    const cli = this.cliTools[name];
    if (!cli) return false;

    // 本地检查
    try {
      execSync(`${cli.command} --version`, { stdio: 'pipe', timeout: 10000 });
      return true;
    } catch {}

    // Windows 上检查 WSL
    if (this.isWindows && this.isWSLAvailable()) {
      try {
        this._execInWSL(`${cli.command} --version`);
        return true;
      } catch {}
    }

    return false;
  }

  /**
   * 在 WSL 中安装 CLI 工具
   */
  async installCliInWSL(name, progressCallback = null) {
    const cli = this.cliTools[name];
    if (!cli) {
      throw new Error(`未知的 CLI 工具: ${name}`);
    }

    if (!this.isWindows) {
      throw new Error('此方法仅适用于 Windows WSL 环境');
    }

    if (!this.isWSLAvailable()) {
      throw new Error('WSL 未安装或不可用');
    }

    try {
      // 确保 Node.js 环境
      if (!this.checkWSLNodeInstalled()) {
        if (progressCallback) progressCallback('正在准备 Node.js 环境...');
        await this.installWSLNodeEnvironment(progressCallback);
      }

      // 配置 npm 全局目录（避免权限问题）
      if (progressCallback) progressCallback('正在配置 npm...');
      try {
        this._execInWSL('mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global');
      } catch {}

      // 安装 CLI 工具
      if (progressCallback) progressCallback(`正在安装 ${cli.name}...`);
      console.log(`[DependencyManager] 在 WSL 中安装 ${cli.name}...`);

      // Claude Code 优先使用原生安装器
      if (name === 'claude' && cli.nativeInstaller) {
        try {
          this._execInWSL(cli.nativeInstaller, { timeout: 300000 });
          console.log(`[DependencyManager] ${cli.name} 原生安装成功`);
          return true;
        } catch (err) {
          console.log(`[DependencyManager] 原生安装失败，尝试 npm 安装: ${err.message}`);
        }
      }

      // npm 安装
      const npmInstallCmd = `source ~/.nvm/nvm.sh 2>/dev/null; export PATH=~/.npm-global/bin:$PATH; npm install -g ${cli.npmPackage}`;
      this._execInWSL(npmInstallCmd, { timeout: 300000 });

      console.log(`[DependencyManager] ${cli.name} 安装成功`);
      return true;
    } catch (err) {
      console.error(`[DependencyManager] ${cli.name} 安装失败:`, err.message);
      throw err;
    }
  }

  /**
   * 获取 CLI 工具安装状态（包括 WSL）
   */
  getCliStatusWithWSL(name) {
    const cli = this.cliTools[name];
    if (!cli) return null;

    const status = {
      name: cli.name,
      command: cli.command,
      npmPackage: cli.npmPackage,
      installed: false,
      version: null,
      location: null, // 'local' | 'wsl' | null
      wslAvailable: this.isWindows && this.isWSLAvailable(),
    };

    // 本地检查
    try {
      const version = cli.checkVersion();
      if (version) {
        status.installed = true;
        status.version = version;
        status.location = 'local';
        return status;
      }
    } catch {}

    // WSL 检查
    if (this.isWindows && this.isWSLAvailable()) {
      try {
        const output = this._execInWSL(`${cli.command} --version`);
        const versionMatch = output.match(/(\d+\.\d+\.\d+)/);
        if (versionMatch) {
          status.installed = true;
          status.version = versionMatch[1];
          status.location = 'wsl';
        }
      } catch {}
    }

    return status;
  }

  /**
   * 获取所有 CLI 工具状态
   */
  getAllCliStatusWithWSL() {
    const result = {};
    for (const name of Object.keys(this.cliTools)) {
      result[name] = this.getCliStatusWithWSL(name);
    }
    return result;
  }

  /**
   * 获取 CLI 工具版本
   */
  _getCliVersion(command, versionArg) {
    try {
      const output = execSync(`${command} ${versionArg}`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000
      }).trim();
      // 提取版本号（通常是第一行或包含数字的部分）
      const versionMatch = output.match(/(\d+\.\d+\.\d+)/);
      return versionMatch ? versionMatch[1] : output.split('\n')[0];
    } catch {
      return null;
    }
  }

  /**
   * 获取 frpc 下载 URL
   */
  _getFrpcUrl() {
    const version = this.dependencies.frpc.version;
    let platform, arch, ext;

    if (this.isWindows) {
      platform = 'windows';
      arch = this.arch === 'arm64' ? 'arm64' : 'amd64';
      ext = 'zip'; // Windows 使用 zip 格式
    } else if (this.isMac) {
      platform = 'darwin';
      arch = this.arch === 'arm64' ? 'arm64' : 'amd64';
      ext = 'tar.gz';
    } else {
      platform = 'linux';
      arch = this.arch === 'arm64' ? 'arm64' : 'amd64';
      ext = 'tar.gz';
    }

    return `https://github.com/fatedier/frp/releases/download/v${version}/frp_${version}_${platform}_${arch}.${ext}`;
  }

  /**
   * 获取 cloudflared 下载 URL
   */
  _getCloudflaredUrl() {
    let filename;

    // 检测 Windows 上的实际架构
    // process.arch 在 Electron 中可能返回错误的值
    let arch = this.arch;
    if (this.isWindows) {
      // Windows 上使用环境变量检测
      const procArch = process.env.PROCESSOR_ARCHITECTURE;
      const procArch64 = process.env.PROCESSOR_ARCHITEW6432;
      if (procArch === 'ARM64' || procArch64 === 'ARM64') {
        arch = 'arm64';
      } else {
        arch = 'amd64';
      }
    }

    if (this.isWindows) {
      filename = arch === 'arm64' ? 'cloudflared-windows-arm64.exe' : 'cloudflared-windows-amd64.exe';
    } else if (this.isMac) {
      filename = this.arch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz';
    } else {
      filename = this.arch === 'arm64' ? 'cloudflared-linux-arm64' : 'cloudflared-linux-amd64';
    }

    console.log(`[DependencyManager] cloudflared 下载配置: platform=${process.platform}, arch=${arch}, file=${filename}`);
    return `https://github.com/cloudflare/cloudflared/releases/latest/download/${filename}`;
  }

  /**
   * 获取可执行文件路径
   */
  getExecutablePath(name) {
    const dep = this.dependencies[name];
    if (!dep) return null;
    return path.join(this.binDir, dep.getExecutable());
  }

  /**
   * 检查依赖是否已安装（优先检查内置文件）
   */
  isInstalled(name) {
    // 1. 检查内置文件
    const bundledPath = this.getBundledExecutablePath(name);
    if (bundledPath) {
      return true;
    }

    // 2. 检查本地下载的文件
    const execPath = this.getExecutablePath(name);
    if (execPath && fs.existsSync(execPath)) {
      return true;
    }

    // 3. 检查系统 PATH
    try {
      const cmd = this.isWindows ? 'where' : 'which';
      const executable = this.dependencies[name].getExecutable();
      execSync(`${cmd} ${executable}`, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 验证二进制文件是否有效
   * 检查文件大小、是否为 HTML、是否能执行等
   * @param {string} name - 依赖名称
   * @returns {{valid: boolean, reason: string}} 验证结果
   */
  validateBinary(name) {
    const execPath = this.getExecutablePath(name);
    return this.validateBinaryAt(execPath, name);
  }

  /**
   * 验证指定路径的二进制文件是否有效
   * @param {string} execPath - 可执行文件路径
   * @param {string} name - 依赖名称（用于确定最小文件大小）
   * @returns {{valid: boolean, reason: string}} 验证结果
   */
  validateBinaryAt(execPath, name) {
    if (!execPath || !fs.existsSync(execPath)) {
      return { valid: false, reason: '文件不存在' };
    }

    try {
      const stats = fs.statSync(execPath);

      // 检查文件大小（cloudflared 和 frpc 都至少有几 MB）
      const minSize = name === 'cloudflared' ? 10 * 1024 * 1024 : 5 * 1024 * 1024; // 10MB / 5MB
      if (stats.size < minSize) {
        return { valid: false, reason: `文件过小 (${(stats.size / 1024 / 1024).toFixed(2)} MB)，可能损坏` };
      }

      // 读取文件头部，检查是否为 HTML 或文本文件
      const fd = fs.openSync(execPath, 'r');
      const buffer = Buffer.alloc(256);
      fs.readSync(fd, buffer, 0, 256, 0);
      fs.closeSync(fd);

      const header = buffer.toString('utf-8', 0, 100).toLowerCase();
      if (header.includes('<!doctype') || header.includes('<html') || header.includes('not found')) {
        return { valid: false, reason: '文件是 HTML 页面，非二进制文件' };
      }

      // Windows: 检查 PE 文件头 (MZ)
      if (this.isWindows) {
        if (buffer[0] !== 0x4D || buffer[1] !== 0x5A) { // 'MZ'
          return { valid: false, reason: '无效的 Windows 可执行文件（缺少 MZ 头）' };
        }
      }

      // macOS/Linux: 检查 ELF 或 Mach-O 文件头
      if (!this.isWindows) {
        const isELF = buffer[0] === 0x7F && buffer[1] === 0x45 && buffer[2] === 0x4C && buffer[3] === 0x46;
        const isMachO = (buffer[0] === 0xFE && buffer[1] === 0xED && buffer[2] === 0xFA) ||
                        (buffer[0] === 0xCF && buffer[1] === 0xFA && buffer[2] === 0xED);
        if (!isELF && !isMachO) {
          return { valid: false, reason: '无效的可执行文件格式' };
        }
      }

      // 尝试执行 --version 验证
      try {
        execSync(`"${execPath}" --version`, { stdio: 'pipe', timeout: 5000 });
      } catch (err) {
        // 某些程序可能没有 --version，忽略这个错误
        // 但如果是 "cannot execute" 类错误，则文件无效
        const errMsg = err.message || '';
        if (errMsg.includes('cannot execute') || errMsg.includes('not a valid') ||
            errMsg.includes('无法运行') || errMsg.includes('不是有效的')) {
          return { valid: false, reason: `无法执行: ${errMsg.slice(0, 100)}` };
        }
      }

      return { valid: true, reason: '验证通过' };
    } catch (err) {
      return { valid: false, reason: `验证失败: ${err.message}` };
    }
  }

  /**
   * 确保依赖可用（验证 + 自动修复）
   * 优先使用内置二进制文件，避免网络下载
   * @param {string} name - 依赖名称
   * @param {Function} progressCallback - 进度回调
   * @returns {Promise<boolean>} 是否可用
   */
  async ensureValid(name, progressCallback = null) {
    const dep = this.dependencies[name];
    if (!dep) {
      console.error(`[DependencyManager] 未知的依赖: ${name}`);
      return false;
    }

    // 1. 优先检查内置二进制文件
    const bundledPath = this.getBundledExecutablePath(name);
    if (bundledPath) {
      const validation = this.validateBinaryAt(bundledPath, name);
      if (validation.valid) {
        // 尝试实际执行，检测权限问题
        try {
          execSync(`"${bundledPath}" --version`, { stdio: 'pipe', timeout: 5000 });
          console.log(`[DependencyManager] ${name} 使用内置文件: ${bundledPath}`);
          return true;
        } catch (err) {
          if (err.code === 'EPERM' || err.message.includes('EPERM')) {
            console.warn(`[DependencyManager] 内置 ${name} 权限被拒绝，尝试下载到用户目录`);
            // 继续到下载逻辑
          } else {
            console.log(`[DependencyManager] ${name} 使用内置文件: ${bundledPath}`);
            return true;
          }
        }
      } else {
        console.warn(`[DependencyManager] 内置 ${name} 验证失败: ${validation.reason}`);
      }
    }

    // 2. 检查本地下载的文件
    const execPath = this.getExecutablePath(name);

    // 如果文件存在，先验证
    if (fs.existsSync(execPath)) {
      const validation = this.validateBinary(name);
      if (validation.valid) {
        console.log(`[DependencyManager] ${name} 验证通过`);
        return true;
      }

      // 验证失败，删除损坏的文件
      console.warn(`[DependencyManager] ${name} 验证失败: ${validation.reason}，正在重新下载...`);
      if (progressCallback) progressCallback(`${name} 文件损坏，正在修复...`);

      try {
        fs.unlinkSync(execPath);
      } catch (err) {
        console.error(`[DependencyManager] 删除损坏文件失败: ${err.message}`);
      }
    }

    // 3. 下载安装
    try {
      await this.install(name, progressCallback);

      // 再次验证
      const validation = this.validateBinary(name);
      if (!validation.valid) {
        console.error(`[DependencyManager] ${name} 安装后验证仍失败: ${validation.reason}`);
        return false;
      }

      console.log(`[DependencyManager] ${name} 安装并验证成功`);
      return true;
    } catch (err) {
      console.error(`[DependencyManager] ${name} 安装失败: ${err.message}`);
      return false;
    }
  }

  /**
   * 获取可执行文件（优先内置，其次本地下载，最后系统）
   */
  getExecutable(name) {
    // 1. 优先使用内置的二进制文件
    const bundledPath = this.getBundledExecutablePath(name);
    if (bundledPath) {
      console.log(`[DependencyManager] 使用内置 ${name}: ${bundledPath}`);
      return bundledPath;
    }

    // 2. 其次使用本地下载的文件
    const localPath = this.getExecutablePath(name);
    if (localPath && fs.existsSync(localPath)) {
      return localPath;
    }

    // 3. 返回系统命令名
    return this.dependencies[name]?.getExecutable() || name;
  }

  /**
   * 下载文件（带重试机制）
   * @param {string} url - 下载 URL
   * @param {string} destPath - 目标路径
   * @param {number} maxRetries - 最大重试次数
   * @param {Function} progressCallback - 进度回调
   */
  async _download(url, destPath, maxRetries = 3, progressCallback = null) {
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this._downloadOnce(url, destPath, progressCallback);
        return; // 下载成功
      } catch (err) {
        lastError = err;
        console.error(`[DependencyManager] 下载失败 (第 ${attempt}/${maxRetries} 次): ${err.message}`);

        // 清理可能的残留文件
        try {
          if (fs.existsSync(destPath)) {
            fs.unlinkSync(destPath);
          }
        } catch {}

        // 最后一次尝试不需要等待
        if (attempt < maxRetries) {
          const delay = attempt * 2000; // 递增延迟
          console.log(`[DependencyManager] ${delay / 1000} 秒后重试...`);
          if (progressCallback) progressCallback(`下载失败，${delay / 1000} 秒后重试 (${attempt}/${maxRetries})...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError || new Error('下载失败，已达最大重试次数');
  }

  /**
   * 单次下载文件
   */
  async _downloadOnce(url, destPath, progressCallback = null) {
    return new Promise((resolve, reject) => {
      console.log(`[DependencyManager] 下载: ${url}`);

      const file = createWriteStream(destPath);
      let redirectCount = 0;
      const maxRedirects = 10;

      const request = (url) => {
        // 自动处理 http/https
        const httpModule = url.startsWith('https') ? https : http;

        const req = httpModule.get(url, {
          headers: {
            'User-Agent': 'WhatyTerm/1.0',
            'Accept': 'application/octet-stream'
          },
          timeout: 30000 // 30 秒连接超时
        }, (response) => {
          // 处理重定向
          if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 307) {
            redirectCount++;
            if (redirectCount > maxRedirects) {
              file.close();
              reject(new Error('重定向次数过多'));
              return;
            }
            const redirectUrl = response.headers.location;
            console.log(`[DependencyManager] 重定向到: ${redirectUrl}`);
            request(redirectUrl);
            return;
          }

          if (response.statusCode !== 200) {
            file.close();
            reject(new Error(`下载失败: HTTP ${response.statusCode}`));
            return;
          }

          // 检查 Content-Type，确保不是 HTML
          const contentType = response.headers['content-type'] || '';
          if (contentType.includes('text/html')) {
            file.close();
            reject(new Error('下载失败: 服务器返回 HTML 页面而非二进制文件'));
            return;
          }

          const contentLength = parseInt(response.headers['content-length'] || '0');
          const totalMB = (contentLength / 1024 / 1024).toFixed(2);
          console.log(`[DependencyManager] 开始下载，大小: ${contentLength ? totalMB + ' MB' : '未知'}`);

          let downloaded = 0;
          let lastProgress = 0;

          response.on('data', (chunk) => {
            downloaded += chunk.length;
            if (contentLength > 0) {
              const progress = Math.floor((downloaded / contentLength) * 100);
              // 每 10% 报告一次进度
              if (progress >= lastProgress + 10) {
                lastProgress = progress;
                const downloadedMB = (downloaded / 1024 / 1024).toFixed(2);
                console.log(`[DependencyManager] 下载进度: ${progress}% (${downloadedMB}/${totalMB} MB)`);
                if (progressCallback) progressCallback(`下载中: ${progress}%`);
              }
            }
          });

          response.pipe(file);

          file.on('finish', () => {
            file.close();
            console.log(`[DependencyManager] 下载完成: ${destPath}`);
            resolve();
          });

          file.on('error', (err) => {
            file.close();
            fs.unlink(destPath, () => {});
            reject(err);
          });
        });

        req.on('error', (err) => {
          file.close();
          fs.unlink(destPath, () => {});
          reject(err);
        });

        req.on('timeout', () => {
          req.destroy();
          file.close();
          fs.unlink(destPath, () => {});
          reject(new Error('下载超时'));
        });
      };

      request(url);
    });
  }

  /**
   * 解压 tar.gz 文件
   */
  async _extractTarGz(archivePath, destDir, stripComponents = 0) {
    return new Promise((resolve, reject) => {
      // 使用系统 tar 命令（Windows 10+ 内置）
      const stripArg = stripComponents > 0 ? `--strip-components=${stripComponents}` : '';
      const cmd = `tar -xzf "${archivePath}" -C "${destDir}" ${stripArg}`;

      try {
        execSync(cmd, { stdio: 'pipe' });
        resolve();
      } catch (err) {
        reject(new Error(`解压失败: ${err.message}`));
      }
    });
  }

  /**
   * 安装依赖
   * @param {string} name - 依赖名称
   * @param {Function} progressCallback - 进度回调
   * @param {boolean} force - 强制下载，跳过已安装检查
   */
  async install(name, progressCallback = null, force = false) {
    const dep = this.dependencies[name];
    if (!dep) {
      throw new Error(`未知的依赖: ${name}`);
    }

    if (!force && this.isInstalled(name)) {
      console.log(`[DependencyManager] ${name} 已安装`);
      return true;
    }

    const url = dep.getUrl();
    const executable = dep.getExecutable();
    const execPath = path.join(this.binDir, executable);

    try {
      if (progressCallback) progressCallback(`正在下载 ${dep.description}...`);

      if (dep.extract === 'tar.gz') {
        // 下载压缩包
        const archivePath = path.join(this.binDir, `${name}.tar.gz`);
        await this._download(url, archivePath, 3, progressCallback);

        if (progressCallback) progressCallback(`正在解压 ${dep.description}...`);

        // 解压
        await this._extractTarGz(archivePath, this.binDir, dep.stripComponents || 0);

        // 清理压缩包
        fs.unlinkSync(archivePath);

        // 设置执行权限（Unix）
        if (!this.isWindows && fs.existsSync(execPath)) {
          fs.chmodSync(execPath, 0o755);
        }
      } else if (url.endsWith('.tgz')) {
        // macOS cloudflared 是 tgz
        const archivePath = path.join(this.binDir, `${name}.tgz`);
        await this._download(url, archivePath, 3, progressCallback);
        await this._extractTarGz(archivePath, this.binDir, 0);
        fs.unlinkSync(archivePath);
        if (!this.isWindows && fs.existsSync(execPath)) {
          fs.chmodSync(execPath, 0o755);
        }
      } else {
        // 直接下载可执行文件
        await this._download(url, execPath, 3, progressCallback);

        // 设置执行权限（Unix）
        if (!this.isWindows) {
          fs.chmodSync(execPath, 0o755);
        }
      }

      console.log(`[DependencyManager] ${name} 安装成功: ${execPath}`);
      return true;
    } catch (err) {
      console.error(`[DependencyManager] ${name} 安装失败:`, err);
      throw err;
    }
  }

  /**
   * 安装所有可选依赖
   */
  async installAll(progressCallback = null) {
    const results = {};

    for (const name of Object.keys(this.dependencies)) {
      try {
        await this.install(name, progressCallback);
        results[name] = { success: true };
      } catch (err) {
        results[name] = { success: false, error: err.message };
      }
    }

    return results;
  }

  /**
   * 获取所有依赖的状态
   */
  getStatus() {
    const status = {};

    for (const [name, dep] of Object.entries(this.dependencies)) {
      const localPath = this.getExecutablePath(name);
      const isLocalInstalled = localPath && fs.existsSync(localPath);

      let isSystemInstalled = false;
      let systemPath = null;

      try {
        const cmd = this.isWindows ? 'where' : 'which';
        const executable = dep.getExecutable();
        systemPath = execSync(`${cmd} ${executable}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        isSystemInstalled = true;
      } catch {
        // 系统未安装
      }

      status[name] = {
        name: dep.name,
        description: dep.description,
        version: dep.version,
        installed: isLocalInstalled || isSystemInstalled,
        localPath: isLocalInstalled ? localPath : null,
        systemPath: isSystemInstalled ? systemPath : null,
        executable: this.getExecutable(name)
      };
    }

    return status;
  }

  // ============================================
  // CLI 工具管理方法
  // ============================================

  /**
   * 检查 CLI 工具是否已安装
   * @param {string} name - CLI 工具名称 (claude/codex/gemini)
   */
  isCliInstalled(name) {
    const cli = this.cliTools[name];
    if (!cli) return false;

    try {
      const cmd = this.isWindows ? 'where' : 'which';
      execSync(`${cmd} ${cli.command}`, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 获取 CLI 工具状态
   */
  getCliStatus() {
    const status = {};

    for (const [name, cli] of Object.entries(this.cliTools)) {
      const installed = this.isCliInstalled(name);
      let version = null;
      let path = null;

      if (installed) {
        version = cli.checkVersion();
        try {
          const cmd = this.isWindows ? 'where' : 'which';
          path = execSync(`${cmd} ${cli.command}`, {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe']
          }).trim().split('\n')[0];
        } catch {
          // ignore
        }
      }

      status[name] = {
        name: cli.name,
        description: cli.description,
        npmPackage: cli.npmPackage,
        command: cli.command,
        installed,
        version,
        path
      };
    }

    return status;
  }

  /**
   * 安装 CLI 工具
   * @param {string} name - CLI 工具名称 (claude/codex/gemini)
   * @param {Function} progressCallback - 进度回调
   */
  async installCli(name, progressCallback = null) {
    const cli = this.cliTools[name];
    if (!cli) {
      throw new Error(`未知的 CLI 工具: ${name}`);
    }

    if (this.isCliInstalled(name)) {
      console.log(`[DependencyManager] ${cli.name} 已安装`);
      return { success: true, alreadyInstalled: true };
    }

    // 检查 npm 是否可用
    try {
      execSync('npm --version', { stdio: 'pipe' });
    } catch {
      throw new Error('npm 未安装，请先安装 Node.js');
    }

    console.log(`[DependencyManager] 正在安装 ${cli.name} (${cli.npmPackage})...`);
    if (progressCallback) progressCallback(`正在安装 ${cli.name}...`);

    return new Promise((resolve, reject) => {
      const npmCmd = this.isWindows ? 'npm.cmd' : 'npm';
      const args = ['install', '-g', cli.npmPackage];

      const proc = spawn(npmCmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: this.isWindows
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
        console.log(`[npm] ${data.toString().trim()}`);
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
        // npm 的进度信息通常输出到 stderr
        const line = data.toString().trim();
        if (line && progressCallback) {
          progressCallback(line);
        }
      });

      proc.on('close', (code) => {
        if (code === 0) {
          console.log(`[DependencyManager] ${cli.name} 安装成功`);
          const version = cli.checkVersion();
          resolve({ success: true, version });
        } else {
          console.error(`[DependencyManager] ${cli.name} 安装失败: ${stderr}`);
          reject(new Error(`安装失败 (exit code: ${code}): ${stderr}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`启动 npm 失败: ${err.message}`));
      });
    });
  }

  /**
   * 更新 CLI 工具到最新版本
   * @param {string} name - CLI 工具名称
   * @param {Function} progressCallback - 进度回调
   */
  async updateCli(name, progressCallback = null) {
    const cli = this.cliTools[name];
    if (!cli) {
      throw new Error(`未知的 CLI 工具: ${name}`);
    }

    console.log(`[DependencyManager] 正在更新 ${cli.name}...`);
    if (progressCallback) progressCallback(`正在更新 ${cli.name}...`);

    return new Promise((resolve, reject) => {
      const npmCmd = this.isWindows ? 'npm.cmd' : 'npm';
      const args = ['update', '-g', cli.npmPackage];

      const proc = spawn(npmCmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: this.isWindows
      });

      let stderr = '';

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
        const line = data.toString().trim();
        if (line && progressCallback) {
          progressCallback(line);
        }
      });

      proc.on('close', (code) => {
        if (code === 0) {
          console.log(`[DependencyManager] ${cli.name} 更新成功`);
          const version = cli.checkVersion();
          resolve({ success: true, version });
        } else {
          reject(new Error(`更新失败 (exit code: ${code}): ${stderr}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`启动 npm 失败: ${err.message}`));
      });
    });
  }

  /**
   * 安装所有 CLI 工具
   * @param {Function} progressCallback - 进度回调
   */
  async installAllCli(progressCallback = null) {
    const results = {};

    for (const name of Object.keys(this.cliTools)) {
      try {
        const result = await this.installCli(name, progressCallback);
        results[name] = { success: true, ...result };
      } catch (err) {
        results[name] = { success: false, error: err.message };
      }
    }

    return results;
  }

  /**
   * 获取 npm 包的最新版本号
   * @param {string} packageName - npm 包名
   */
  async getLatestNpmVersion(packageName) {
    return new Promise((resolve, reject) => {
      const npmCmd = this.isWindows ? 'npm.cmd' : 'npm';

      try {
        const output = execSync(`${npmCmd} view ${packageName} version`, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 30000
        }).trim();
        resolve(output);
      } catch (err) {
        reject(new Error(`获取版本失败: ${err.message}`));
      }
    });
  }

  /**
   * 检查 CLI 工具是否有更新
   * @param {string} name - CLI 工具名称
   */
  async checkCliUpdate(name) {
    const cli = this.cliTools[name];
    if (!cli) {
      throw new Error(`未知的 CLI 工具: ${name}`);
    }

    const currentVersion = cli.checkVersion();
    if (!currentVersion) {
      return { installed: false, hasUpdate: false };
    }

    try {
      const latestVersion = await this.getLatestNpmVersion(cli.npmPackage);
      const hasUpdate = currentVersion !== latestVersion;

      return {
        installed: true,
        currentVersion,
        latestVersion,
        hasUpdate
      };
    } catch (err) {
      return {
        installed: true,
        currentVersion,
        latestVersion: null,
        hasUpdate: false,
        error: err.message
      };
    }
  }

  /**
   * 获取所有状态（二进制依赖 + CLI 工具）
   */
  getAllStatus() {
    return {
      dependencies: this.getStatus(),
      cliTools: this.getCliStatus(),
      systemTools: this.getSystemToolsStatus()
    };
  }

  // ============================================
  // 系统工具管理方法（Git 等）
  // ============================================

  /**
   * 检查系统工具是否已安装
   * @param {string} name - 工具名称 (git)
   */
  isSystemToolInstalled(name) {
    const tool = this.systemTools[name];
    if (!tool) return false;

    try {
      const cmd = this.isWindows ? 'where' : 'which';
      execSync(`${cmd} ${tool.command}`, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 获取系统工具状态
   */
  getSystemToolsStatus() {
    const status = {};

    for (const [name, tool] of Object.entries(this.systemTools)) {
      const installed = this.isSystemToolInstalled(name);
      let version = null;
      let path = null;

      if (installed) {
        version = tool.checkVersion();
        try {
          const cmd = this.isWindows ? 'where' : 'which';
          path = execSync(`${cmd} ${tool.command}`, {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe']
          }).trim().split('\n')[0];
        } catch {
          // ignore
        }
      }

      status[name] = {
        name: tool.name,
        description: tool.description,
        command: tool.command,
        installed,
        version,
        path,
        // 提供安装指南
        installGuide: this._getInstallGuide(name)
      };
    }

    return status;
  }

  /**
   * 获取系统工具安装指南
   * @param {string} name - 工具名称
   */
  _getInstallGuide(name) {
    const tool = this.systemTools[name];
    if (!tool) return null;

    if (this.isWindows) {
      return {
        platform: 'windows',
        methods: [
          {
            name: 'winget（推荐）',
            command: tool.windowsInstaller?.wingetCommand,
            description: '使用 Windows 包管理器自动安装'
          },
          {
            name: '官方安装包',
            url: tool.windowsInstaller?.downloadUrl,
            description: '下载官方安装程序'
          },
          {
            name: '便携版',
            url: tool.windowsInstaller?.portableUrl,
            description: '无需管理员权限的便携版本'
          }
        ]
      };
    } else if (this.isMac) {
      return {
        platform: 'macos',
        methods: [
          {
            name: 'Homebrew（推荐）',
            command: tool.macInstaller?.brewCommand,
            description: '使用 Homebrew 安装'
          },
          {
            name: 'Xcode Command Line Tools',
            command: tool.macInstaller?.xcodeCommand,
            description: '安装 Xcode 命令行工具（包含 Git）'
          }
        ]
      };
    } else {
      return {
        platform: 'linux',
        methods: [
          {
            name: 'apt（Debian/Ubuntu）',
            command: tool.linuxInstaller?.aptCommand,
            description: '使用 apt 包管理器安装'
          },
          {
            name: 'yum（CentOS/RHEL）',
            command: tool.linuxInstaller?.yumCommand,
            description: '使用 yum 包管理器安装'
          },
          {
            name: 'dnf（Fedora）',
            command: tool.linuxInstaller?.dnfCommand,
            description: '使用 dnf 包管理器安装'
          }
        ]
      };
    }
  }

  /**
   * 检查 winget 是否可用（Windows）
   */
  isWingetAvailable() {
    if (!this.isWindows) return false;

    try {
      execSync('winget --version', { stdio: 'pipe', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 使用 winget 安装系统工具（Windows）
   * @param {string} name - 工具名称
   * @param {Function} progressCallback - 进度回调
   */
  async installSystemToolWithWinget(name, progressCallback = null) {
    const tool = this.systemTools[name];
    if (!tool) {
      throw new Error(`未知的系统工具: ${name}`);
    }

    if (!this.isWindows) {
      throw new Error('winget 仅在 Windows 上可用');
    }

    if (!this.isWingetAvailable()) {
      throw new Error('winget 未安装或不可用，请使用其他安装方式');
    }

    if (this.isSystemToolInstalled(name)) {
      console.log(`[DependencyManager] ${tool.name} 已安装`);
      return { success: true, alreadyInstalled: true };
    }

    const wingetCommand = tool.windowsInstaller?.wingetCommand;
    if (!wingetCommand) {
      throw new Error(`${tool.name} 不支持 winget 安装`);
    }

    console.log(`[DependencyManager] 使用 winget 安装 ${tool.name}...`);
    if (progressCallback) progressCallback(`正在使用 winget 安装 ${tool.name}...`);

    return new Promise((resolve, reject) => {
      // 解析 winget 命令
      const args = wingetCommand.split(' ').slice(1); // 去掉 'winget'

      const proc = spawn('winget', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
        const line = data.toString().trim();
        console.log(`[winget] ${line}`);
        if (line && progressCallback) {
          progressCallback(line);
        }
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          console.log(`[DependencyManager] ${tool.name} 安装成功`);
          const version = tool.checkVersion();
          resolve({ success: true, version });
        } else {
          console.error(`[DependencyManager] ${tool.name} 安装失败: ${stderr}`);
          reject(new Error(`安装失败 (exit code: ${code}): ${stderr || stdout}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`启动 winget 失败: ${err.message}`));
      });
    });
  }

  /**
   * 下载 Git for Windows 安装包
   * @param {Function} progressCallback - 进度回调
   * @returns {Promise<string>} 下载的文件路径
   */
  async downloadGitInstaller(progressCallback = null) {
    const tool = this.systemTools.git;
    const downloadUrl = tool.windowsInstaller?.downloadUrl;

    if (!downloadUrl) {
      throw new Error('Git 下载 URL 未配置');
    }

    const installerPath = path.join(this.binDir, 'Git-installer.exe');

    console.log(`[DependencyManager] 下载 Git for Windows...`);
    if (progressCallback) progressCallback('正在下载 Git for Windows...');

    await this._download(downloadUrl, installerPath, 3, progressCallback);

    console.log(`[DependencyManager] Git 安装包已下载: ${installerPath}`);
    return installerPath;
  }

  /**
   * 运行 Git for Windows 安装程序（静默安装）
   * @param {string} installerPath - 安装包路径
   * @param {Function} progressCallback - 进度回调
   */
  async runGitInstaller(installerPath, progressCallback = null) {
    if (!this.isWindows) {
      throw new Error('此方法仅适用于 Windows');
    }

    if (!fs.existsSync(installerPath)) {
      throw new Error(`安装包不存在: ${installerPath}`);
    }

    console.log(`[DependencyManager] 运行 Git 安装程序...`);
    if (progressCallback) progressCallback('正在安装 Git（可能需要管理员权限）...');

    return new Promise((resolve, reject) => {
      // 静默安装参数
      const args = [
        '/VERYSILENT',           // 完全静默
        '/NORESTART',            // 不重启
        '/NOCANCEL',             // 不允许取消
        '/SP-',                  // 不显示启动画面
        '/CLOSEAPPLICATIONS',    // 关闭相关应用
        '/RESTARTAPPLICATIONS',  // 安装后重启应用
        '/COMPONENTS="icons,ext\\reg\\shellhere,assoc,assoc_sh"'  // 组件
      ];

      const proc = spawn(installerPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true
      });

      proc.on('close', (code) => {
        if (code === 0) {
          console.log(`[DependencyManager] Git 安装成功`);

          // 等待一下让 PATH 更新
          setTimeout(() => {
            const version = this.systemTools.git.checkVersion();
            resolve({ success: true, version });
          }, 2000);
        } else {
          reject(new Error(`Git 安装失败 (exit code: ${code})`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`运行安装程序失败: ${err.message}`));
      });
    });
  }

  /**
   * 自动安装 Git（Windows）
   * 优先使用 winget，失败则下载安装包
   * @param {Function} progressCallback - 进度回调
   */
  async installGit(progressCallback = null) {
    if (this.isSystemToolInstalled('git')) {
      const version = this.systemTools.git.checkVersion();
      console.log(`[DependencyManager] Git 已安装: ${version}`);
      return { success: true, alreadyInstalled: true, version };
    }

    if (this.isWindows) {
      // Windows: 优先尝试 winget
      if (this.isWingetAvailable()) {
        try {
          if (progressCallback) progressCallback('尝试使用 winget 安装 Git...');
          return await this.installSystemToolWithWinget('git', progressCallback);
        } catch (err) {
          console.log(`[DependencyManager] winget 安装失败，尝试下载安装包: ${err.message}`);
        }
      }

      // 下载并运行安装程序
      try {
        const installerPath = await this.downloadGitInstaller(progressCallback);
        return await this.runGitInstaller(installerPath, progressCallback);
      } catch (err) {
        throw new Error(`Git 安装失败: ${err.message}`);
      }
    } else if (this.isMac) {
      // macOS: 提示用户手动安装
      throw new Error('请使用以下命令安装 Git:\n' +
        '  brew install git\n' +
        '或\n' +
        '  xcode-select --install');
    } else {
      // Linux: 提示用户手动安装
      throw new Error('请使用包管理器安装 Git:\n' +
        '  Ubuntu/Debian: sudo apt-get install git\n' +
        '  CentOS/RHEL: sudo yum install git\n' +
        '  Fedora: sudo dnf install git');
    }
  }

  /**
   * 在 WSL 中安装 Git
   * @param {Function} progressCallback - 进度回调
   */
  async installGitInWSL(progressCallback = null) {
    if (!this.isWindows) {
      throw new Error('此方法仅适用于 Windows WSL 环境');
    }

    if (!this.isWSLAvailable()) {
      throw new Error('WSL 未安装或不可用');
    }

    try {
      // 检查 WSL 中是否已安装 Git
      const gitVersion = this._execInWSL('git --version');
      console.log(`[DependencyManager] WSL Git 已安装: ${gitVersion.trim()}`);
      return { success: true, alreadyInstalled: true, version: gitVersion.trim() };
    } catch {
      // 未安装，继续安装
    }

    console.log('[DependencyManager] 在 WSL 中安装 Git...');
    if (progressCallback) progressCallback('正在 WSL 中安装 Git...');

    try {
      // 更新包列表并安装 Git
      this._execInWSL('sudo apt-get update && sudo apt-get install -y git', {
        timeout: 300000 // 5 分钟超时
      });

      const version = this._execInWSL('git --version').trim();
      console.log(`[DependencyManager] WSL Git 安装成功: ${version}`);
      return { success: true, version };
    } catch (err) {
      throw new Error(`WSL Git 安装失败: ${err.message}`);
    }
  }
}

// 单例
const dependencyManager = new DependencyManager();
export default dependencyManager;

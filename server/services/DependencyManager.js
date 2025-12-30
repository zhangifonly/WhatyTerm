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

    // 确保目录存在
    if (!fs.existsSync(this.binDir)) {
      fs.mkdirSync(this.binDir, { recursive: true });
    }

    // 二进制依赖配置（直接下载）
    this.dependencies = {
      frpc: {
        name: 'frpc',
        description: 'FRP 内网穿透客户端',
        version: '0.52.3',
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
    let platform, arch;

    if (this.isWindows) {
      platform = 'windows';
      arch = this.arch === 'arm64' ? 'arm64' : 'amd64';
    } else if (this.isMac) {
      platform = 'darwin';
      arch = this.arch === 'arm64' ? 'arm64' : 'amd64';
    } else {
      platform = 'linux';
      arch = this.arch === 'arm64' ? 'arm64' : 'amd64';
    }

    return `https://github.com/fatedier/frp/releases/download/v${version}/frp_${version}_${platform}_${arch}.tar.gz`;
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
   * 检查依赖是否已安装
   */
  isInstalled(name) {
    const execPath = this.getExecutablePath(name);
    if (!execPath) return false;

    // 检查本地安装
    if (fs.existsSync(execPath)) {
      return true;
    }

    // 检查系统 PATH
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
   * 获取可执行文件（优先本地，其次系统）
   */
  getExecutable(name) {
    const localPath = this.getExecutablePath(name);
    if (localPath && fs.existsSync(localPath)) {
      return localPath;
    }

    // 返回系统命令名
    return this.dependencies[name]?.getExecutable() || name;
  }

  /**
   * 下载文件
   */
  async _download(url, destPath) {
    return new Promise((resolve, reject) => {
      console.log(`[DependencyManager] 下载: ${url}`);

      const file = createWriteStream(destPath);
      let redirectCount = 0;
      const maxRedirects = 10;

      const request = (url) => {
        // 自动处理 http/https
        const httpModule = url.startsWith('https') ? https : http;

        httpModule.get(url, {
          headers: {
            'User-Agent': 'WhatyTerm/1.0',
            'Accept': 'application/octet-stream'
          }
        }, (response) => {
          // 处理重定向
          if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 307) {
            redirectCount++;
            if (redirectCount > maxRedirects) {
              reject(new Error('重定向次数过多'));
              return;
            }
            const redirectUrl = response.headers.location;
            console.log(`[DependencyManager] 重定向到: ${redirectUrl}`);
            request(redirectUrl);
            return;
          }

          if (response.statusCode !== 200) {
            reject(new Error(`下载失败: HTTP ${response.statusCode}`));
            return;
          }

          // 检查 Content-Type，确保不是 HTML
          const contentType = response.headers['content-type'] || '';
          if (contentType.includes('text/html')) {
            reject(new Error('下载失败: 服务器返回 HTML 页面而非二进制文件'));
            return;
          }

          const contentLength = response.headers['content-length'];
          console.log(`[DependencyManager] 开始下载，大小: ${contentLength ? (parseInt(contentLength) / 1024 / 1024).toFixed(2) + ' MB' : '未知'}`);

          response.pipe(file);
          file.on('finish', () => {
            file.close();
            resolve();
          });
        }).on('error', (err) => {
          fs.unlink(destPath, () => {});
          reject(err);
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
   */
  async install(name, progressCallback = null) {
    const dep = this.dependencies[name];
    if (!dep) {
      throw new Error(`未知的依赖: ${name}`);
    }

    if (this.isInstalled(name)) {
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
        await this._download(url, archivePath);

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
        await this._download(url, archivePath);
        await this._extractTarGz(archivePath, this.binDir, 0);
        fs.unlinkSync(archivePath);
        if (!this.isWindows && fs.existsSync(execPath)) {
          fs.chmodSync(execPath, 0o755);
        }
      } else {
        // 直接下载可执行文件
        await this._download(url, execPath);

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
      cliTools: this.getCliStatus()
    };
  }
}

// 单例
const dependencyManager = new DependencyManager();
export default dependencyManager;

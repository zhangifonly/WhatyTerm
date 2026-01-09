import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import dependencyManager from './DependencyManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SETTINGS_PATH = join(__dirname, '../db/ai-settings.json');

/**
 * Cloudflare Tunnel 服务
 * 自动启动 cloudflared quick tunnel 并获取免费域名
 */
class CloudflareTunnel {
  constructor() {
    this.process = null;
    this.tunnelUrl = '';
    this.io = null;
    this.enabled = true; // 默认启用
    this.localPort = 3928;
  }

  /**
   * 初始化服务
   * @param {Object} io - Socket.IO 实例
   * @param {number} port - 本地服务端口
   */
  init(io, port = 3928) {
    this.io = io;
    this.localPort = port;
  }

  /**
   * 检查 cloudflared 是否已安装（优先使用 DependencyManager）
   */
  async checkInstalled() {
    // 优先检查 DependencyManager 管理的版本
    if (dependencyManager.isInstalled('cloudflared')) {
      return true;
    }

    // 回退：检查系统 PATH
    return new Promise((resolve) => {
      const isWindows = process.platform === 'win32';
      const cmd = isWindows ? 'where' : 'which';
      const check = spawn(cmd, ['cloudflared'], { shell: isWindows });
      check.on('close', (code) => {
        resolve(code === 0);
      });
      check.on('error', () => {
        resolve(false);
      });
    });
  }

  /**
   * 获取 cloudflared 可执行文件路径
   */
  getCloudflaredExecutable() {
    return dependencyManager.getExecutable('cloudflared');
  }

  /**
   * 确保 cloudflared 可用（验证 + 自动修复）
   * @param {Function} progressCallback - 进度回调
   * @returns {Promise<boolean>}
   */
  async ensureInstalled(progressCallback = null) {
    // 使用 ensureValid 进行验证和自动修复
    const valid = await dependencyManager.ensureValid('cloudflared', progressCallback);
    if (valid) {
      console.log('[CloudflareTunnel] cloudflared 已就绪');
      return true;
    }

    console.error('[CloudflareTunnel] cloudflared 不可用，无法自动修复');
    return false;
  }

  /**
   * 启动 Cloudflare Tunnel
   * @param {Function} progressCallback - 安装进度回调（可选）
   */
  async start(progressCallback = null) {
    if (!this.enabled) {
      console.log('[CloudflareTunnel] 服务已禁用');
      return null;
    }

    // 验证并自动修复 cloudflared
    const ready = await this.ensureInstalled(progressCallback);
    if (!ready) {
      console.log('[CloudflareTunnel] cloudflared 不可用，无法启动隧道');
      return null;
    }

    // 如果已经在运行，先停止
    if (this.process) {
      this.stop();
    }

    const cloudflaredPath = this.getCloudflaredExecutable();
    const isWindows = process.platform === 'win32';
    console.log(`[CloudflareTunnel] 启动 Quick Tunnel... (使用: ${cloudflaredPath})`);

    return new Promise(async (resolve) => {
      try {
        // 直接执行可执行文件，不使用 shell，避免路径空格问题
        this.process = spawn(cloudflaredPath, ['tunnel', '--url', `http://localhost:${this.localPort}`], {
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (err) {
        // 捕获 spawn 同步异常（如 EPERM）
        if (err.code === 'EPERM') {
          console.log('[CloudflareTunnel] 检测到权限错误，尝试下载到用户目录...');
          try {
            await dependencyManager.install('cloudflared', null, true); // force=true 强制下载
            console.log('[CloudflareTunnel] 下载完成，重新启动...');
            const result = await this.start();
            resolve(result);
            return;
          } catch (downloadErr) {
            console.error('[CloudflareTunnel] 下载失败:', downloadErr.message);
          }
        }
        console.error('[CloudflareTunnel] 启动失败:', err.message);
        resolve(null);
        return;
      }

      let urlFound = false;
      const urlRegex = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

      // 监听 stderr（cloudflared 输出到 stderr）
      this.process.stderr.on('data', (data) => {
        const output = data.toString();

        // 查找 URL
        if (!urlFound) {
          const match = output.match(urlRegex);
          if (match) {
            urlFound = true;
            this.tunnelUrl = match[0];
            console.log(`[CloudflareTunnel] 隧道已建立: ${this.tunnelUrl}`);

            // 保存到配置
            this._saveTunnelUrl(this.tunnelUrl);

            // 通知前端
            if (this.io) {
              this.io.emit('tunnel:connected', { url: this.tunnelUrl });
            }

            resolve(this.tunnelUrl);
          }
        }
      });

      this.process.on('error', async (err) => {
        console.error('[CloudflareTunnel] 启动失败:', err.message);

        // 如果是权限错误，尝试下载到用户目录并重试
        if (err.code === 'EPERM') {
          console.log('[CloudflareTunnel] 检测到权限错误，尝试下载到用户目录...');
          try {
            await dependencyManager.install('cloudflared', null, true); // force=true 强制下载
            console.log('[CloudflareTunnel] 下载完成，重新启动...');
            // 重新启动（递归调用）
            const result = await this.start();
            resolve(result);
            return;
          } catch (downloadErr) {
            console.error('[CloudflareTunnel] 下载失败:', downloadErr.message);
          }
        }

        resolve(null);
      });

      this.process.on('close', (code) => {
        console.log(`[CloudflareTunnel] 进程退出，代码: ${code}`);
        this.process = null;
        this.tunnelUrl = '';

        // 通知前端断开
        if (this.io) {
          this.io.emit('tunnel:disconnected');
        }
      });

      // 超时处理（30秒）
      setTimeout(() => {
        if (!urlFound) {
          console.log('[CloudflareTunnel] 获取 URL 超时');
          resolve(null);
        }
      }, 30000);
    });
  }

  /**
   * 停止 Cloudflare Tunnel
   */
  stop() {
    if (this.process) {
      console.log('[CloudflareTunnel] 停止隧道...');
      this.process.kill('SIGTERM');
      this.process = null;
      this.tunnelUrl = '';

      // 清空配置中的 URL
      this._saveTunnelUrl('');
    }
  }

  /**
   * 获取当前隧道 URL
   */
  getUrl() {
    return this.tunnelUrl;
  }

  /**
   * 检查隧道是否运行中
   */
  isRunning() {
    return this.process !== null && this.tunnelUrl !== '';
  }

  /**
   * 设置是否启用
   */
  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled && this.process) {
      this.stop();
    }
  }

  /**
   * 保存隧道 URL 到配置文件
   */
  _saveTunnelUrl(url) {
    try {
      let settings = {};
      if (existsSync(SETTINGS_PATH)) {
        settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
      }
      settings.tunnelUrl = url;
      writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
    } catch (err) {
      console.error('[CloudflareTunnel] 保存 URL 失败:', err.message);
    }
  }
}

// 导出单例
export default new CloudflareTunnel();

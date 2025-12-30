import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, statSync, unlinkSync } from 'fs';
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
    this.localPort = 3000;
  }

  /**
   * 初始化服务
   * @param {Object} io - Socket.IO 实例
   * @param {number} port - 本地服务端口
   */
  init(io, port = 3000) {
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
   * 自动安装 cloudflared（如果未安装）
   * @param {Function} progressCallback - 进度回调
   * @returns {Promise<boolean>}
   */
  async ensureInstalled(progressCallback = null) {
    if (await this.checkInstalled()) {
      return true;
    }

    console.log('[CloudflareTunnel] cloudflared 未安装，正在自动下载...');

    try {
      await dependencyManager.install('cloudflared', progressCallback);
      console.log('[CloudflareTunnel] cloudflared 安装成功');
      return true;
    } catch (err) {
      console.error('[CloudflareTunnel] cloudflared 自动安装失败:', err.message);
      return false;
    }
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

    // 自动安装 cloudflared（如果未安装）
    const installed = await this.ensureInstalled(progressCallback);
    if (!installed) {
      console.log('[CloudflareTunnel] cloudflared 安装失败，无法启动隧道');
      return null;
    }

    // 如果已经在运行，先停止
    if (this.process) {
      this.stop();
    }

    const cloudflaredPath = this.getCloudflaredExecutable();
    console.log(`[CloudflareTunnel] 启动 Quick Tunnel... (使用: ${cloudflaredPath})`);

    // 检查可执行文件是否存在
    if (!existsSync(cloudflaredPath)) {
      console.error('[CloudflareTunnel] cloudflared 可执行文件不存在:', cloudflaredPath);
      return null;
    }

    // Windows 上检查文件大小，确保不是损坏的文件
    const isWindows = process.platform === 'win32';
    try {
      const stats = statSync(cloudflaredPath);
      if (stats.size < 1000000) { // cloudflared 至少有几 MB
        console.error('[CloudflareTunnel] cloudflared 文件可能损坏，大小异常:', stats.size);
        // 删除损坏的文件，下次会重新下载
        unlinkSync(cloudflaredPath);
        return null;
      }
    } catch (err) {
      console.error('[CloudflareTunnel] 检查文件失败:', err.message);
    }

    return new Promise((resolve) => {
      // Windows 上使用 shell: true 来正确执行 .exe 文件
      this.process = spawn(cloudflaredPath, ['tunnel', '--url', `http://localhost:${this.localPort}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: isWindows
      });

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

      this.process.on('error', (err) => {
        console.error('[CloudflareTunnel] 启动失败:', err.message);
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

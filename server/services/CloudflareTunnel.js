import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

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
   * 检查 cloudflared 是否已安装
   */
  async checkInstalled() {
    return new Promise((resolve) => {
      // 跨平台检查命令：Windows 使用 where，其他系统使用 which
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
   * 启动 Cloudflare Tunnel
   */
  async start() {
    if (!this.enabled) {
      console.log('[CloudflareTunnel] 服务已禁用');
      return null;
    }

    // 检查是否已安装 cloudflared
    const installed = await this.checkInstalled();
    if (!installed) {
      console.log('[CloudflareTunnel] cloudflared 未安装，跳过隧道启动');
      if (process.platform === 'win32') {
        console.log('[CloudflareTunnel] Windows 安装方法: winget install Cloudflare.cloudflared 或从 https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ 下载');
      } else if (process.platform === 'darwin') {
        console.log('[CloudflareTunnel] macOS 安装方法: brew install cloudflared');
      } else {
        console.log('[CloudflareTunnel] Linux 安装方法: 参考 https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
      }
      return null;
    }

    // 如果已经在运行，先停止
    if (this.process) {
      this.stop();
    }

    console.log('[CloudflareTunnel] 启动 Quick Tunnel...');

    return new Promise((resolve) => {
      this.process = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${this.localPort}`], {
        stdio: ['ignore', 'pipe', 'pipe']
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

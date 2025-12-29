import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import os from 'os';
import crypto from 'crypto';
import net from 'net';
import https from 'https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SETTINGS_PATH = join(__dirname, '../db/ai-settings.json');

// FRP 服务器列表 - 按优先级排序
const FRP_SERVERS = [
  {
    name: 'US-KC01',
    addr: '31.59.40.20',
    frpPort: 7000,
    token: 'webtmux_public_2025',
    domain: 'frp-kc01.whaty.org',
    useTls: true  // KC01 已配置 TLS 证书
  },
  {
    name: 'US-LAX01',
    addr: '74.48.180.34',
    frpPort: 7000,
    token: 'webtmux_public_2025',
    domain: 'frp-lax01.whaty.org',
    useTls: false  // LAX01 服务端未配置 TLS 证书
  },
  {
    name: 'US-LAX02',
    addr: '107.173.127.103',
    frpPort: 7000,
    token: 'webtmux_public_2025',
    domain: 'frp.whaty.org',
    useTls: false  // LAX02 服务端未配置 TLS 证书
  }
];

/**
 * FRP Tunnel 服务
 * 自动测试多台服务器，选择最快可用的
 * 使用 TLS 加密绕过 DPI 阻断
 */
class FrpTunnel {
  constructor() {
    this.frpProcess = null;
    this.tunnelUrl = '';
    this.io = null;
    this.enabled = true;
    this.localPort = 3000;
    this.subdomain = '';
    this.configPath = '';
    this.selectedServer = null;  // 当前选中的服务器
  }

  /**
   * 初始化服务
   * @param {Object} io - Socket.IO 实例
   * @param {number} port - 本地服务端口
   */
  init(io, port = 3000) {
    this.io = io;
    this.localPort = port;
    this.subdomain = this._generateSubdomain();
    this.configPath = join(os.homedir(), '.webtmux', 'frpc.toml');
  }

  /**
   * 获取或生成唯一的子域名（持久化）
   */
  _generateSubdomain() {
    const subdomainPath = join(os.homedir(), '.webtmux', 'subdomain.txt');
    try {
      if (existsSync(subdomainPath)) {
        const saved = readFileSync(subdomainPath, 'utf-8').trim();
        if (saved) {
          console.log(`[FrpTunnel] 使用已保存的 subdomain: ${saved}`);
          return saved;
        }
      }
    } catch (err) {
      // 忽略读取错误
    }

    const hostname = os.hostname().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
    const random = crypto.randomBytes(4).toString('hex');
    const subdomain = `${hostname}-${random}`;

    try {
      const configDir = dirname(subdomainPath);
      if (!existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true });
      }
      writeFileSync(subdomainPath, subdomain);
      console.log(`[FrpTunnel] 已生成并保存新 subdomain: ${subdomain}`);
    } catch (err) {
      console.error('[FrpTunnel] 保存 subdomain 失败:', err.message);
    }

    return subdomain;
  }

  /**
   * 检查 frpc 是否已安装
   */
  async checkInstalled() {
    return new Promise((resolve) => {
      // 跨平台检查命令：Windows 使用 where，其他系统使用 which
      const isWindows = process.platform === 'win32';
      const cmd = isWindows ? 'where' : 'which';
      const check = spawn(cmd, ['frpc'], { shell: isWindows });
      check.on('close', (code) => {
        resolve(code === 0);
      });
      check.on('error', () => {
        resolve(false);
      });
    });
  }

  /**
   * 测试单个服务器的连接延迟
   * @param {Object} server - 服务器配置
   * @param {number} timeout - 超时时间（毫秒）
   * @returns {Promise<{server: Object, latency: number}|null>}
   */
  async _testServerLatency(server, timeout = 5000) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const socket = new net.Socket();

      const cleanup = () => {
        socket.removeAllListeners();
        socket.destroy();
      };

      socket.setTimeout(timeout);

      socket.on('connect', () => {
        const latency = Date.now() - startTime;
        cleanup();
        console.log(`[FrpTunnel] ${server.name} (${server.addr}): ${latency}ms`);
        resolve({ server, latency });
      });

      socket.on('timeout', () => {
        cleanup();
        console.log(`[FrpTunnel] ${server.name} (${server.addr}): 超时`);
        resolve(null);
      });

      socket.on('error', (err) => {
        cleanup();
        console.log(`[FrpTunnel] ${server.name} (${server.addr}): 连接失败 - ${err.message}`);
        resolve(null);
      });

      socket.connect(server.frpPort, server.addr);
    });
  }

  /**
   * 测试所有服务器，返回最快可用的
   * @returns {Promise<Object|null>}
   */
  async _selectFastestServer() {
    console.log('[FrpTunnel] 测试所有 FRP 服务器...');

    // 过滤掉禁用的服务器
    const enabledServers = FRP_SERVERS.filter(s => !s.disabled);

    // 并行测试所有服务器
    const results = await Promise.all(
      enabledServers.map(server => this._testServerLatency(server))
    );

    // 过滤可用的服务器并按延迟排序
    const available = results
      .filter(r => r !== null)
      .sort((a, b) => a.latency - b.latency);

    if (available.length === 0) {
      console.log('[FrpTunnel] 所有 FRP 服务器都不可用');
      return null;
    }

    const fastest = available[0];
    console.log(`[FrpTunnel] 选择最快服务器: ${fastest.server.name} (${fastest.latency}ms)`);
    return fastest.server;
  }

  /**
   * 创建 FRP 客户端配置文件
   */
  _createConfig(server) {
    const configDir = dirname(this.configPath);
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }

    const config = `# WebTmux FRP 客户端配置
# 服务器: ${server.name}
# 使用 TLS 加密直连，绕过 DPI 阻断

serverAddr = "${server.addr}"
serverPort = ${server.frpPort}
auth.token = "${server.token}"

# TLS 加密（绕过 DPI）
transport.tls.enable = ${server.useTls}

# 连接配置
loginFailExit = false
transport.heartbeatInterval = 30
transport.heartbeatTimeout = 90

[[proxies]]
name = "webtmux-${this.subdomain}"
type = "http"
localPort = ${this.localPort}
subdomain = "${this.subdomain}"
`;

    writeFileSync(this.configPath, config);
    console.log(`[FrpTunnel] 配置文件已创建: ${this.configPath}`);
  }

  /**
   * 启动 FRP Tunnel
   * 自动选择最快的可用服务器
   */
  async start() {
    if (!this.enabled) {
      console.log('[FrpTunnel] 服务已禁用');
      return null;
    }

    const installed = await this.checkInstalled();
    if (!installed) {
      console.log('[FrpTunnel] frpc 未安装，跳过隧道启动');
      console.log('[FrpTunnel] 安装方法: brew install frp');
      return null;
    }

    if (this.frpProcess) {
      this.stop();
    }

    // 选择最快的服务器
    const server = await this._selectFastestServer();
    if (!server) {
      return null;
    }

    this.selectedServer = server;
    this._createConfig(server);

    console.log(`[FrpTunnel] 启动 FRP 客户端 (${server.name}: ${server.addr}:${server.frpPort})...`);

    return new Promise((resolve) => {
      this.frpProcess = spawn('frpc', ['-c', this.configPath], {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let connected = false;

      const handleOutput = (output) => {
        console.log('[FrpTunnel] frpc:', output.trim());

        if (!connected && (output.includes('start proxy success') || output.includes('login to server success'))) {
          connected = true;
          this.tunnelUrl = `https://${this.subdomain}.${server.domain}`;
          console.log(`[FrpTunnel] 隧道已建立: ${this.tunnelUrl}`);

          this._saveTunnelUrl(this.tunnelUrl);

          if (this.io) {
            this.io.emit('tunnel:connected', {
              url: this.tunnelUrl,
              type: 'frp',
              server: server.name
            });
          }

          resolve(this.tunnelUrl);
        }
      };

      this.frpProcess.stdout.on('data', (data) => handleOutput(data.toString()));
      this.frpProcess.stderr.on('data', (data) => handleOutput(data.toString()));

      this.frpProcess.on('error', (err) => {
        console.error('[FrpTunnel] FRP 启动失败:', err.message);
        resolve(null);
      });

      this.frpProcess.on('close', (code) => {
        console.log(`[FrpTunnel] FRP 进程退出，代码: ${code}`);
        this.frpProcess = null;
        this.tunnelUrl = '';
        this.selectedServer = null;

        if (this.io) {
          this.io.emit('tunnel:disconnected', { type: 'frp' });
        }
      });

      // 超时处理（10秒）
      setTimeout(() => {
        if (!connected) {
          console.log('[FrpTunnel] 连接超时');
          this.stop();
          resolve(null);
        }
      }, 10000);
    });
  }

  /**
   * 停止 FRP Tunnel
   */
  stop() {
    if (this.frpProcess) {
      console.log('[FrpTunnel] 停止 FRP 客户端...');
      this.frpProcess.kill('SIGTERM');
      this.frpProcess = null;
    }

    this.tunnelUrl = '';
    this.selectedServer = null;
    this._saveTunnelUrl('');
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
    return this.frpProcess !== null && this.tunnelUrl !== '';
  }

  /**
   * 设置是否启用
   */
  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled && this.frpProcess) {
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
      settings.tunnelType = 'frp';
      settings.frpServer = this.selectedServer?.name || '';
      writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
    } catch (err) {
      console.error('[FrpTunnel] 保存 URL 失败:', err.message);
    }
  }

  /**
   * 获取服务器信息
   */
  getServerInfo() {
    return {
      servers: FRP_SERVERS,
      selected: this.selectedServer,
      subdomain: this.subdomain,
      configPath: this.configPath
    };
  }

  /**
   * 检查所有服务器状态（用于定期健康检查）
   * @returns {Promise<Array>} 服务器状态列表
   */
  async checkAllServers() {
    const results = await Promise.all(
      FRP_SERVERS.map(async (server) => {
        const result = await this._testServerLatency(server, 5000);
        return {
          name: server.name,
          addr: server.addr,
          domain: server.domain,
          available: result !== null,
          latency: result?.latency || null,
          selected: this.selectedServer?.name === server.name
        };
      })
    );
    return results;
  }

  /**
   * 启动定期健康检查
   * @param {number} intervalMs - 检查间隔（毫秒）
   */
  startHealthCheck(intervalMs = 60000) {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    console.log(`[FrpTunnel] 启动定期健康检查，间隔: ${intervalMs / 1000}秒`);

    // 立即执行一次
    this._runHealthCheck();

    // 定期执行
    this.healthCheckInterval = setInterval(() => {
      this._runHealthCheck();
    }, intervalMs);
  }

  /**
   * 停止定期健康检查
   */
  stopHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
      console.log('[FrpTunnel] 已停止定期健康检查');
    }
  }

  /**
   * 执行健康检查并推送结果
   */
  async _runHealthCheck() {
    const status = await this.checkAllServers();

    // 通过 Socket.IO 推送状态
    if (this.io) {
      this.io.emit('frp:status', {
        servers: status,
        tunnelUrl: this.tunnelUrl,
        selectedServer: this.selectedServer?.name || null
      });
    }

    return status;
  }

  /**
   * 检测隧道 URL 是否可访问
   * @param {number} timeout - 超时时间（毫秒）
   * @returns {Promise<{available: boolean, latency: number|null, error: string|null}>}
   */
  async checkTunnelUrl(timeout = 10000) {
    if (!this.tunnelUrl) {
      return { available: false, latency: null, error: '隧道未建立' };
    }

    return new Promise((resolve) => {
      const startTime = Date.now();
      const url = new URL(this.tunnelUrl);

      const req = https.request({
        hostname: url.hostname,
        port: 443,
        path: '/',
        method: 'HEAD',
        timeout: timeout,
        rejectUnauthorized: true  // 验证 SSL 证书
      }, (res) => {
        const latency = Date.now() - startTime;
        // 任何 HTTP 响应都说明隧道可用（包括 404、502 等）
        resolve({ available: true, latency, statusCode: res.statusCode, error: null });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ available: false, latency: null, error: '连接超时' });
      });

      req.on('error', (err) => {
        resolve({ available: false, latency: null, error: err.message });
      });

      req.end();
    });
  }

  /**
   * 启动隧道 URL 可用性检测
   * @param {number} intervalMs - 检查间隔（毫秒），默认 30 秒
   */
  startTunnelCheck(intervalMs = 30000) {
    if (this.tunnelCheckInterval) {
      clearInterval(this.tunnelCheckInterval);
    }

    console.log(`[FrpTunnel] 启动隧道 URL 可用性检测，间隔: ${intervalMs / 1000}秒`);
    this.tunnelCheckFailCount = 0;

    this.tunnelCheckInterval = setInterval(async () => {
      await this._runTunnelCheck();
    }, intervalMs);

    // 立即执行一次
    this._runTunnelCheck();
  }

  /**
   * 停止隧道 URL 可用性检测
   */
  stopTunnelCheck() {
    if (this.tunnelCheckInterval) {
      clearInterval(this.tunnelCheckInterval);
      this.tunnelCheckInterval = null;
      console.log('[FrpTunnel] 已停止隧道 URL 可用性检测');
    }
  }

  /**
   * 执行隧道 URL 检测
   */
  async _runTunnelCheck() {
    // 如果进程不存在但应该运行，尝试重启
    if (!this.frpProcess) {
      console.log('[FrpTunnel] 检测到 FRP 进程不存在，尝试重新启动...');
      if (this.io) {
        this.io.emit('tunnel:reconnecting', {
          reason: 'FRP 进程异常退出',
          previousUrl: this.tunnelUrl
        });
      }
      const newUrl = await this.start();
      if (newUrl) {
        console.log(`[FrpTunnel] 重启成功: ${newUrl}`);
      } else {
        console.log('[FrpTunnel] 重启失败');
      }
      return;
    }

    if (!this.tunnelUrl) {
      return;
    }

    const result = await this.checkTunnelUrl();
    console.log(`[FrpTunnel] 隧道检测: ${this.tunnelUrl} - ${result.available ? `可用 (${result.latency}ms)` : `不可用: ${result.error}`}`);

    // 推送检测结果
    if (this.io) {
      this.io.emit('tunnel:check', {
        url: this.tunnelUrl,
        ...result,
        timestamp: new Date().toISOString()
      });
    }

    // 连续失败 3 次则尝试重连
    if (!result.available) {
      this.tunnelCheckFailCount = (this.tunnelCheckFailCount || 0) + 1;
      console.log(`[FrpTunnel] 隧道检测失败次数: ${this.tunnelCheckFailCount}`);

      if (this.tunnelCheckFailCount >= 3) {
        console.log('[FrpTunnel] 隧道连续 3 次检测失败，尝试重新连接...');
        this.tunnelCheckFailCount = 0;

        // 通知前端
        if (this.io) {
          this.io.emit('tunnel:reconnecting', {
            reason: '隧道连续检测失败',
            previousUrl: this.tunnelUrl
          });
        }

        // 重新启动隧道
        this.stop();
        const newUrl = await this.start();

        if (newUrl) {
          console.log(`[FrpTunnel] 重连成功: ${newUrl}`);
        } else {
          console.log('[FrpTunnel] 重连失败');
        }
      }
    } else {
      this.tunnelCheckFailCount = 0;
    }

    return result;
  }

  /**
   * 获取当前状态（供 API 调用）
   */
  async getStatus() {
    const servers = await this.checkAllServers();
    const tunnelCheck = await this.checkTunnelUrl();
    return {
      servers,
      tunnelUrl: this.tunnelUrl,
      tunnelAvailable: tunnelCheck.available,
      tunnelLatency: tunnelCheck.latency,
      tunnelError: tunnelCheck.error,
      selectedServer: this.selectedServer?.name || null,
      running: this.isRunning()
    };
  }
}

// 导出单例
export default new FrpTunnel();

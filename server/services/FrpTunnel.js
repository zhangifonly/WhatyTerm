import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import os from 'os';
import crypto from 'crypto';
import net from 'net';
import https from 'https';
import dependencyManager from './DependencyManager.js';
import NativeFrpClient from './frp/NativeFrpClient.js';

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
 *
 * Windows 平台使用 NativeFrpClient（纯 Node.js 实现）
 * 其他平台使用 frpc 可执行文件
 */
class FrpTunnel {
  constructor() {
    this.isWindows = process.platform === 'win32';

    this.frpProcess = null;       // frpc 子进程（非 Windows）
    this.nativeClient = null;     // NativeFrpClient 实例（Windows）
    this.tunnelUrl = '';
    this.io = null;
    this.enabled = true;
    this.localPort = 3928;
    this.subdomain = '';
    this.configPath = '';
    this.selectedServer = null;   // 当前选中的服务器
  }

  /**
   * 初始化服务
   * @param {Object} io - Socket.IO 实例
   * @param {number} port - 本地服务端口
   */
  init(io, port = 3928) {
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
   * 检查 frpc 是否已安装（优先使用 DependencyManager）
   * Windows 上使用 NativeFrpClient，不需要外部依赖
   */
  async checkInstalled() {
    // Windows 上使用 NativeFrpClient，始终可用
    if (this.isWindows) {
      return true;
    }

    // 优先检查 DependencyManager 管理的版本
    if (dependencyManager.isInstalled('frpc')) {
      return true;
    }

    // 回退：检查系统 PATH
    return new Promise((resolve) => {
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
   * 获取 frpc 可执行文件路径
   */
  getFrpcExecutable() {
    return dependencyManager.getExecutable('frpc');
  }

  /**
   * 确保 frpc 可用（验证 + 自动修复）
   * @param {Function} progressCallback - 进度回调
   * @returns {Promise<boolean>}
   */
  async ensureInstalled(progressCallback = null) {
    // 使用 ensureValid 进行验证和自动修复
    const valid = await dependencyManager.ensureValid('frpc', progressCallback);
    if (valid) {
      console.log('[FrpTunnel] frpc 已就绪');
      return true;
    }

    console.error('[FrpTunnel] frpc 不可用，无法自动修复');
    return false;
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
   * Windows 使用 NativeFrpClient，其他平台使用 frpc 可执行文件
   * @param {Function} progressCallback - 安装进度回调（可选）
   */
  async start(progressCallback = null) {
    if (!this.enabled) {
      console.log('[FrpTunnel] 服务已禁用');
      return null;
    }

    // 选择最快的服务器
    const server = await this._selectFastestServer();
    if (!server) {
      return null;
    }

    this.selectedServer = server;

    // Windows 使用 NativeFrpClient
    if (this.isWindows) {
      return this._startNativeClient(server);
    }

    // 其他平台使用 frpc 可执行文件
    return this._startFrpcProcess(server, progressCallback);
  }

  /**
   * 使用 NativeFrpClient 启动隧道（Windows）
   * @param {Object} server - 服务器配置
   */
  async _startNativeClient(server) {
    if (this.nativeClient) {
      this.stop();
    }

    console.log(`[FrpTunnel] 使用 NativeFrpClient 连接 ${server.name} (${server.addr}:${server.frpPort})...`);

    this.nativeClient = new NativeFrpClient({
      serverAddr: server.addr,
      serverPort: server.frpPort,
      token: server.token,
      useTls: server.useTls,
      localAddr: '127.0.0.1',
      localPort: this.localPort,
      heartbeatInterval: 30,
      heartbeatTimeout: 90,
    });

    // 设置事件处理
    this.nativeClient.on('connected', () => {
      console.log('[FrpTunnel] NativeFrpClient 已连接');
    });

    this.nativeClient.on('login', ({ runId }) => {
      console.log(`[FrpTunnel] 登录成功，runId: ${runId}`);
    });

    this.nativeClient.on('proxy', ({ proxyName, remoteAddr }) => {
      console.log(`[FrpTunnel] 代理已注册: ${proxyName} -> ${remoteAddr}`);
      this.tunnelUrl = `https://${this.subdomain}.${server.domain}`;
      console.log(`[FrpTunnel] 隧道 URL: ${this.tunnelUrl}`);

      this._saveTunnelUrl(this.tunnelUrl);

      if (this.io) {
        this.io.emit('tunnel:connected', {
          url: this.tunnelUrl,
          type: 'frp',
          server: server.name
        });
      }
    });

    this.nativeClient.on('heartbeat', () => {
      // 心跳正常，不需要日志
    });

    this.nativeClient.on('error', (err) => {
      console.error('[FrpTunnel] NativeFrpClient 错误:', err.message);
      if (this.io) {
        this.io.emit('tunnel:error', {
          type: 'frp',
          error: err.message
        });
      }
    });

    this.nativeClient.on('close', () => {
      console.log('[FrpTunnel] NativeFrpClient 连接已关闭');
      this.nativeClient = null;
      this.tunnelUrl = '';
      this.selectedServer = null;

      if (this.io) {
        this.io.emit('tunnel:disconnected', { type: 'frp' });
      }
    });

    try {
      // 连接到服务器
      await this.nativeClient.connect();

      // 注册 HTTP 代理
      const proxyName = `webtmux-${this.subdomain}`;
      await this.nativeClient.registerHttpProxy({
        proxyName,
        subdomain: this.subdomain,
      });

      return this.tunnelUrl;

    } catch (err) {
      console.error('[FrpTunnel] NativeFrpClient 启动失败:', err.message);
      if (this.nativeClient) {
        this.nativeClient.close();
        this.nativeClient = null;
      }
      return null;
    }
  }

  /**
   * 使用 frpc 可执行文件启动隧道（非 Windows）
   * @param {Object} server - 服务器配置
   * @param {Function} progressCallback - 安装进度回调
   */
  async _startFrpcProcess(server, progressCallback) {
    // 自动安装 frpc（如果未安装）
    const installed = await this.ensureInstalled(progressCallback);
    if (!installed) {
      console.log('[FrpTunnel] frpc 安装失败，无法启动隧道');
      return null;
    }

    if (this.frpProcess) {
      this.stop();
    }

    this._createConfig(server);

    console.log(`[FrpTunnel] 启动 FRP 客户端 (${server.name}: ${server.addr}:${server.frpPort})...`);

    return new Promise(async (resolve) => {
      const frpcPath = this.getFrpcExecutable();
      console.log(`[FrpTunnel] 使用 frpc: ${frpcPath}`);

      try {
        this.frpProcess = spawn(frpcPath, ['-c', this.configPath], {
          stdio: ['ignore', 'pipe', 'pipe']
          // 不使用 shell，直接执行可执行文件，避免路径空格问题
        });
      } catch (err) {
        // 捕获 spawn 同步异常（如 EPERM）
        if (err.code === 'EPERM') {
          console.log('[FrpTunnel] 检测到权限错误，尝试下载到用户目录...');
          try {
            await dependencyManager.install('frpc', null, true); // force=true 强制下载
            console.log('[FrpTunnel] 下载完成，重新启动...');
            const result = await this.start(server);
            resolve(result);
            return;
          } catch (downloadErr) {
            console.error('[FrpTunnel] 下载失败:', downloadErr.message);
          }
        }
        console.error('[FrpTunnel] FRP 启动失败:', err.message);
        resolve(null);
        return;
      }

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

      this.frpProcess.on('error', async (err) => {
        console.error('[FrpTunnel] FRP 启动失败:', err.message);

        // 如果是权限错误，尝试下载到用户目录并重试
        if (err.code === 'EPERM') {
          console.log('[FrpTunnel] 检测到权限错误，尝试下载到用户目录...');
          try {
            await dependencyManager.install('frpc', null, true); // force=true 强制下载
            console.log('[FrpTunnel] 下载完成，重新启动...');
            // 重新启动（递归调用）
            const result = await this.start(server);
            resolve(result);
            return;
          } catch (downloadErr) {
            console.error('[FrpTunnel] 下载失败:', downloadErr.message);
          }
        }

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
    // 停止 NativeFrpClient（Windows）
    if (this.nativeClient) {
      console.log('[FrpTunnel] 停止 NativeFrpClient...');
      this.nativeClient.close();
      this.nativeClient = null;
    }

    // 停止 frpc 进程（非 Windows）
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
    // Windows 使用 NativeFrpClient
    if (this.isWindows) {
      return this.nativeClient !== null && this.nativeClient.isConnected() && this.tunnelUrl !== '';
    }
    // 其他平台使用 frpc 进程
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
    // 检查连接是否存在
    const isConnected = this.isWindows
      ? (this.nativeClient && this.nativeClient.isConnected())
      : (this.frpProcess !== null);

    // 如果连接不存在但应该运行，尝试重启
    if (!isConnected) {
      console.log('[FrpTunnel] 检测到 FRP 连接不存在，尝试重新启动...');
      if (this.io) {
        this.io.emit('tunnel:reconnecting', {
          reason: 'FRP 连接异常断开',
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

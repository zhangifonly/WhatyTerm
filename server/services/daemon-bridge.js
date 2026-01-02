/**
 * Mux 模块桥接 - 用于从 ES Modules 导入 CommonJS 编译的 daemon 模块
 *
 * 使用方法:
 * import { muxAdapter, MuxSessionAdapter, MuxSession } from './daemon-bridge.js';
 *
 * 新架构（mux-server 守护进程）:
 * import { getMuxClient, ensureMuxServer, isMuxServerRunning } from './daemon-bridge.js';
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 创建 require 函数以导入 CommonJS 模块
const require = createRequire(import.meta.url);

// ============================================
// 旧架构：直接导入 daemon 模块（已弃用）
// ============================================

// 导入编译后的 daemon 模块
// 注意：daemon 模块编译输出在项目根目录的 dist/daemon/
const daemonPath = join(__dirname, '../../dist/daemon');

let muxSessionAdapter;
let MuxSessionAdapter;
let MuxSession;

try {
  const adapter = require(join(daemonPath, 'mux-session-adapter.js'));
  muxSessionAdapter = adapter.muxAdapter;
  MuxSessionAdapter = adapter.MuxSessionAdapter;
  MuxSession = adapter.MuxSession;
  console.log('[DaemonBridge] 旧版 Mux 模块加载成功（已弃用）');
} catch (error) {
  // 旧版模块不可用，这是正常的
  muxSessionAdapter = null;
  MuxSessionAdapter = null;
  MuxSession = null;
}

export { muxSessionAdapter, MuxSessionAdapter, MuxSession };

/**
 * 检查旧版 Mux 模块是否可用（已弃用）
 */
export function isMuxAvailable() {
  return muxSessionAdapter !== null;
}

/**
 * 获取旧版 Mux 适配器（已弃用）
 */
export function getMuxAdapter() {
  return muxSessionAdapter;
}

// ============================================
// 新架构：mux-server 守护进程
// ============================================

import { MuxClient, getMuxClient as _getMuxClient, isMuxServerAvailable } from './MuxClient.js';
import { ensureMuxServer, isMuxServerRunning, getMuxServerStatus } from './MuxServerLauncher.js';

// 重新导出新架构的函数
export { MuxClient, isMuxServerAvailable, ensureMuxServer, isMuxServerRunning, getMuxServerStatus };

/**
 * 获取 MuxClient 单例
 */
export function getMuxClient() {
  return _getMuxClient();
}

/**
 * 检查新版 mux-server 是否可用
 * 优先使用新架构
 */
export async function isMuxServerModeAvailable() {
  // 只在 Windows 上使用 mux-server
  if (process.platform !== 'win32') {
    return false;
  }

  // 检查 mux-server 是否已编译
  const muxServerPath = join(__dirname, '../mux-server/index.js');
  const fs = await import('fs');
  if (!fs.existsSync(muxServerPath)) {
    // 尝试检查 TypeScript 源文件
    const tsPath = join(__dirname, '../mux-server/index.ts');
    if (!fs.existsSync(tsPath)) {
      return false;
    }
  }

  return true;
}

/**
 * 初始化 mux-server 模式
 * 返回 MuxClient 实例（如果成功）
 */
export async function initMuxServerMode() {
  if (!await isMuxServerModeAvailable()) {
    console.log('[DaemonBridge] mux-server 模式不可用');
    return null;
  }

  // 确保 mux-server 正在运行
  const started = await ensureMuxServer();
  if (!started) {
    console.error('[DaemonBridge] 无法启动 mux-server');
    return null;
  }

  // 获取并连接客户端
  const client = getMuxClient();
  try {
    await client.connect();
    console.log('[DaemonBridge] 已连接到 mux-server');
    return client;
  } catch (err) {
    console.error('[DaemonBridge] 连接 mux-server 失败:', err.message);
    return null;
  }
}

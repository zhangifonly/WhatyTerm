/**
 * Mux 模块桥接 - 用于从 ES Modules 导入 CommonJS 编译的 daemon 模块
 *
 * 使用方法:
 * import { muxAdapter, MuxSessionAdapter, MuxSession } from './daemon-bridge.js';
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 创建 require 函数以导入 CommonJS 模块
const require = createRequire(import.meta.url);

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
  console.log('[DaemonBridge] Mux 模块加载成功');
} catch (error) {
  console.error('[DaemonBridge] Mux 模块加载失败:', error.message);
  console.error('[DaemonBridge] 请确保已编译 daemon 模块: cd server/daemon && npx tsc');
  // 创建空的占位符
  muxSessionAdapter = null;
  MuxSessionAdapter = null;
  MuxSession = null;
}

export { muxSessionAdapter, MuxSessionAdapter, MuxSession };

/**
 * 检查 Mux 模块是否可用
 */
export function isMuxAvailable() {
  return muxSessionAdapter !== null;
}

/**
 * 获取 Mux 适配器（如果可用）
 */
export function getMuxAdapter() {
  return muxSessionAdapter;
}

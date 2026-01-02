/**
 * MuxServerLauncher - 守护进程启动器
 *
 * 负责检测和启动 mux-server 守护进程
 */

import { spawn } from 'child_process';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// IPC 端点
const isWindows = process.platform === 'win32';
function getIpcPath() {
  if (isWindows) {
    return '\\\\.\\pipe\\whatyterm-mux';
  } else {
    return path.join(os.homedir(), '.whatyterm', 'mux.sock');
  }
}

/**
 * 尝试连接到 mux-server
 */
async function tryConnect(timeout = 1000) {
  return new Promise((resolve) => {
    const ipcPath = getIpcPath();
    const socket = net.createConnection(ipcPath, () => {
      socket.end();
      resolve(true);
    });

    socket.on('error', () => {
      resolve(false);
    });

    setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeout);
  });
}

/**
 * 等待 mux-server 就绪
 */
async function waitForReady(maxAttempts = 30, interval = 200) {
  for (let i = 0; i < maxAttempts; i++) {
    if (await tryConnect()) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  return false;
}

/**
 * 获取 mux-server 的路径
 */
function getMuxServerPath() {
  // 编译后的 JS 文件路径
  const compiledPath = path.join(__dirname, '../mux-server/index.js');

  // TypeScript 源文件路径（开发模式）
  const tsPath = path.join(__dirname, '../mux-server/index.ts');

  // 优先使用编译后的文件
  if (fs.existsSync(compiledPath)) {
    return compiledPath;
  }

  // 开发模式：使用 ts-node 运行 TypeScript
  if (fs.existsSync(tsPath)) {
    return tsPath;
  }

  throw new Error('mux-server not found');
}

/**
 * 启动 mux-server 守护进程
 */
async function startMuxServer() {
  const muxServerPath = getMuxServerPath();
  const isTsFile = muxServerPath.endsWith('.ts');

  console.log(`[MuxServerLauncher] 启动 mux-server: ${muxServerPath}`);

  // 确定运行命令
  let command;
  let args;
  let spawnOptions;

  if (isTsFile) {
    // 开发模式：使用 npx tsx（比 ts-node 更快，兼容性更好）
    if (process.platform === 'win32') {
      // Windows 上使用 shell: true 来正确处理 npx
      command = 'npx';
      args = ['tsx', muxServerPath];
      spawnOptions = {
        detached: true,
        stdio: 'ignore',
        shell: true,  // Windows 上需要 shell: true
        env: {
          ...process.env,
          MUX_SERVER_MODE: '1',
        },
        cwd: path.dirname(muxServerPath),
        windowsHide: true,  // 隐藏 Windows 控制台窗口
      };
    } else {
      command = 'npx';
      args = ['tsx', muxServerPath];
      spawnOptions = {
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          MUX_SERVER_MODE: '1',
        },
        cwd: path.dirname(muxServerPath),
      };
    }
  } else {
    // 生产模式：直接使用 node
    command = process.execPath;
    args = [muxServerPath];
    spawnOptions = {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        MUX_SERVER_MODE: '1',
      },
      cwd: path.dirname(muxServerPath),
    };
    if (process.platform === 'win32') {
      spawnOptions.windowsHide = true;
    }
  }

  // 启动独立进程
  const child = spawn(command, args, spawnOptions);

  // 分离进程，让它独立运行
  child.unref();

  console.log(`[MuxServerLauncher] mux-server 进程已启动，PID: ${child.pid}`);

  return child.pid;
}

/**
 * 确保 mux-server 正在运行
 * 如果没有运行，则启动它
 */
export async function ensureMuxServer() {
  console.log('[MuxServerLauncher] 检查 mux-server 状态...');

  // 检查是否已经在运行
  if (await tryConnect()) {
    console.log('[MuxServerLauncher] mux-server 已在运行');
    return true;
  }

  console.log('[MuxServerLauncher] mux-server 未运行，正在启动...');

  try {
    await startMuxServer();

    // 等待服务就绪
    const ready = await waitForReady();

    if (ready) {
      console.log('[MuxServerLauncher] mux-server 已就绪');
      return true;
    } else {
      console.error('[MuxServerLauncher] mux-server 启动超时');
      return false;
    }
  } catch (err) {
    console.error('[MuxServerLauncher] 启动 mux-server 失败:', err.message);
    return false;
  }
}

/**
 * 检查 mux-server 是否可用
 */
export async function isMuxServerRunning() {
  return await tryConnect();
}

/**
 * 获取 mux-server 状态
 */
export async function getMuxServerStatus() {
  const running = await tryConnect();

  return {
    running,
    ipcPath: getIpcPath(),
    platform: process.platform,
  };
}

export default {
  ensureMuxServer,
  isMuxServerRunning,
  getMuxServerStatus,
};

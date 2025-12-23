const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const path = require('path');
const { spawn, execSync } = require('child_process');
const fs = require('fs');

let mainWindow;
let serverProcess;

// 检查是否是开发模式
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';

// 获取资源目录
function getResourcesPath() {
  if (isDev) {
    return path.join(__dirname, '..');
  }
  return process.resourcesPath;
}

// ==================== macOS 依赖检查 ====================

// 检查 tmux 是否安装 (macOS/Linux)
function checkTmux() {
  try {
    execSync('tmux -V', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// 检查 Homebrew 是否安装
function checkHomebrew() {
  try {
    execSync('brew --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// 安装 tmux (macOS)
async function installTmuxMac() {
  return new Promise((resolve, reject) => {
    const install = spawn('brew', ['install', 'tmux'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let output = '';
    install.stdout.on('data', (data) => {
      output += data.toString();
    });
    install.stderr.on('data', (data) => {
      output += data.toString();
    });

    install.on('close', (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`安装失败，退出码: ${code}\n${output}`));
      }
    });
  });
}

// ==================== Windows WSL2 依赖检查 ====================

// 检查 WSL2 是否安装
function checkWSL() {
  try {
    const result = execSync('wsl --status', { stdio: 'pipe', encoding: 'utf-8' });
    return result.includes('默认版本') || result.includes('Default Version') || result.includes('WSL');
  } catch {
    // 尝试另一种检测方式
    try {
      execSync('wsl -l -v', { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }
}

// 获取 WSL 默认发行版
function getWSLDistro() {
  try {
    const result = execSync('wsl -l -v', { stdio: 'pipe', encoding: 'utf-8' });
    const lines = result.split('\n').filter(l => l.trim());
    for (const line of lines) {
      if (line.includes('*')) {
        // 默认发行版带 * 标记
        const match = line.match(/\*?\s*(\S+)/);
        if (match) {
          // 清理可能的 Unicode 字符
          return match[1].replace(/[^\x20-\x7E]/g, '').trim();
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

// 检查 WSL 中是否安装了 tmux
function checkTmuxInWSL() {
  try {
    execSync('wsl tmux -V', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// 在 WSL 中安装 tmux
async function installTmuxWSL() {
  return new Promise((resolve, reject) => {
    // 使用 apt 安装 tmux
    const install = spawn('wsl', ['sudo', 'apt', 'update', '&&', 'sudo', 'apt', 'install', '-y', 'tmux'], {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let output = '';
    install.stdout.on('data', (data) => {
      output += data.toString();
    });
    install.stderr.on('data', (data) => {
      output += data.toString();
    });

    install.on('close', (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`安装失败，退出码: ${code}\n${output}`));
      }
    });
  });
}

// ==================== 依赖检查对话框 ====================

// 显示进度窗口
function showProgressWindow(title, message) {
  const progressWindow = new BrowserWindow({
    width: 400,
    height: 150,
    frame: false,
    resizable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  progressWindow.loadURL(`data:text/html;charset=utf-8,
    <html>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 20px; background: #1a1a2e; color: #eee;">
      <h3 style="margin: 0 0 10px 0;">${title}</h3>
      <p style="color: #888; font-size: 12px;">${message}</p>
      <div style="background: #333; border-radius: 4px; height: 6px; margin-top: 20px;">
        <div style="background: #4CAF50; height: 100%; width: 30%; border-radius: 4px; animation: progress 2s infinite;"></div>
      </div>
      <style>
        @keyframes progress { 0% { width: 10%; } 50% { width: 70%; } 100% { width: 10%; } }
      </style>
    </body>
    </html>
  `);

  return progressWindow;
}

// macOS 依赖检查对话框
async function showMacDependencyDialog() {
  const hasTmux = checkTmux();

  if (hasTmux) {
    return true;
  }

  const hasHomebrew = checkHomebrew();

  if (hasHomebrew) {
    const result = await dialog.showMessageBox({
      type: 'question',
      title: '缺少依赖',
      message: 'WhatyTerm 需要 tmux 才能运行',
      detail: '检测到您的系统已安装 Homebrew，是否自动安装 tmux？\n\n这将执行: brew install tmux',
      buttons: ['自动安装', '手动安装', '取消'],
      defaultId: 0,
      cancelId: 2
    });

    if (result.response === 0) {
      const progressWindow = showProgressWindow('正在安装 tmux...', '请稍候，这可能需要几分钟');

      try {
        await installTmuxMac();
        progressWindow.close();
        await dialog.showMessageBox({
          type: 'info',
          title: '安装成功',
          message: 'tmux 已成功安装！',
          buttons: ['继续']
        });
        return true;
      } catch (err) {
        progressWindow.close();
        await dialog.showMessageBox({
          type: 'error',
          title: '安装失败',
          message: 'tmux 安装失败',
          detail: err.message + '\n\n请尝试手动安装: brew install tmux',
          buttons: ['确定']
        });
        return false;
      }
    } else if (result.response === 1) {
      shell.openExternal('https://github.com/tmux/tmux/wiki/Installing');
      return false;
    } else {
      return false;
    }
  } else {
    const result = await dialog.showMessageBox({
      type: 'warning',
      title: '缺少依赖',
      message: 'WhatyTerm 需要 tmux 才能运行',
      detail: '请先安装 Homebrew 和 tmux：\n\n1. 安装 Homebrew:\n/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"\n\n2. 安装 tmux:\nbrew install tmux',
      buttons: ['打开安装指南', '取消'],
      defaultId: 0,
      cancelId: 1
    });

    if (result.response === 0) {
      shell.openExternal('https://brew.sh/');
    }
    return false;
  }
}

// Windows 依赖检查对话框
async function showWindowsDependencyDialog() {
  const hasWSL = checkWSL();

  if (!hasWSL) {
    const result = await dialog.showMessageBox({
      type: 'warning',
      title: '需要安装 WSL2',
      message: 'WhatyTerm 需要 WSL2 (Windows Subsystem for Linux) 才能运行',
      detail: 'WSL2 允许在 Windows 上运行 Linux 环境，这是运行 tmux 所必需的。\n\n安装步骤：\n1. 以管理员身份打开 PowerShell\n2. 运行: wsl --install\n3. 重启电脑\n4. 重新打开 WhatyTerm',
      buttons: ['打开安装指南', '复制安装命令', '取消'],
      defaultId: 0,
      cancelId: 2
    });

    if (result.response === 0) {
      shell.openExternal('https://learn.microsoft.com/zh-cn/windows/wsl/install');
    } else if (result.response === 1) {
      const { clipboard } = require('electron');
      clipboard.writeText('wsl --install');
      await dialog.showMessageBox({
        type: 'info',
        title: '已复制',
        message: '安装命令已复制到剪贴板',
        detail: '请以管理员身份打开 PowerShell，粘贴并运行命令。',
        buttons: ['确定']
      });
    }
    return false;
  }

  // WSL 已安装，检查 tmux
  const hasTmux = checkTmuxInWSL();

  if (hasTmux) {
    return true;
  }

  // WSL 中没有 tmux
  const distro = getWSLDistro();
  const result = await dialog.showMessageBox({
    type: 'question',
    title: '需要安装 tmux',
    message: 'WhatyTerm 需要在 WSL 中安装 tmux',
    detail: `检测到 WSL 已安装${distro ? ` (${distro})` : ''}，但缺少 tmux。\n\n是否自动安装？\n\n这将执行: sudo apt install tmux`,
    buttons: ['自动安装', '手动安装', '取消'],
    defaultId: 0,
    cancelId: 2
  });

  if (result.response === 0) {
    const progressWindow = showProgressWindow('正在安装 tmux...', '请稍候，可能需要输入 WSL 密码');

    try {
      await installTmuxWSL();
      progressWindow.close();
      await dialog.showMessageBox({
        type: 'info',
        title: '安装成功',
        message: 'tmux 已成功安装！',
        buttons: ['继续']
      });
      return true;
    } catch (err) {
      progressWindow.close();
      await dialog.showMessageBox({
        type: 'error',
        title: '安装失败',
        message: 'tmux 安装失败',
        detail: err.message + '\n\n请尝试手动安装:\n1. 打开 WSL 终端\n2. 运行: sudo apt update && sudo apt install tmux',
        buttons: ['确定']
      });
      return false;
    }
  } else if (result.response === 1) {
    shell.openExternal('https://github.com/tmux/tmux/wiki/Installing');
    return false;
  } else {
    return false;
  }
}

// 统一的依赖检查入口
async function showDependencyDialog() {
  if (isWindows) {
    return await showWindowsDependencyDialog();
  } else {
    return await showMacDependencyDialog();
  }
}

// ==================== 窗口和服务器管理 ====================

function createWindow() {
  const windowOptions = {
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    title: 'WhatyTerm - AI 终端管理器',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  };

  // macOS 特有的标题栏样式
  if (isMac) {
    windowOptions.titleBarStyle = 'hiddenInset';
    windowOptions.trafficLightPosition = { x: 15, y: 15 };
  }

  mainWindow = new BrowserWindow(windowOptions);

  // 开发模式连接 Vite 开发服务器，生产模式加载本地服务器
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    waitForServer('http://localhost:3000', 30000).then(() => {
      mainWindow.loadURL('http://localhost:3000');
    }).catch(() => {
      dialog.showErrorBox('服务器启动失败', '无法连接到 WhatyTerm 服务器，请检查日志。');
      app.quit();
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 设置菜单
  const template = [
    {
      label: 'WhatyTerm',
      submenu: [
        { label: '关于 WhatyTerm', role: 'about' },
        { type: 'separator' },
        { label: '偏好设置...', accelerator: 'CmdOrCtrl+,', click: () => {
          mainWindow?.webContents.executeJavaScript('window.openSettings && window.openSettings()');
        }},
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', accelerator: 'CmdOrCtrl+Z', role: 'undo' },
        { label: '重做', accelerator: 'Shift+CmdOrCtrl+Z', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', accelerator: 'CmdOrCtrl+X', role: 'cut' },
        { label: '复制', accelerator: 'CmdOrCtrl+C', role: 'copy' },
        { label: '粘贴', accelerator: 'CmdOrCtrl+V', role: 'paste' },
        { label: '全选', accelerator: 'CmdOrCtrl+A', role: 'selectAll' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', role: 'reload' },
        { label: '强制重新加载', accelerator: 'CmdOrCtrl+Shift+R', role: 'forceReload' },
        { type: 'separator' },
        { label: '开发者工具', accelerator: 'Alt+CmdOrCtrl+I', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '放大', accelerator: 'CmdOrCtrl+Plus', role: 'zoomIn' },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', role: 'zoomOut' },
        { label: '重置缩放', accelerator: 'CmdOrCtrl+0', role: 'resetZoom' },
        { type: 'separator' },
        { label: '全屏', accelerator: 'F11', role: 'togglefullscreen' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { label: '最小化', accelerator: 'CmdOrCtrl+M', role: 'minimize' },
        { label: '关闭', accelerator: 'CmdOrCtrl+W', role: 'close' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        { label: '文档', click: () => shell.openExternal('https://github.com/anthropics/claude-code') },
        { label: '报告问题', click: () => shell.openExternal('https://github.com/anthropics/claude-code/issues') }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function startServer() {
  if (isDev) {
    console.log('[Electron] 开发模式，跳过启动内置服务器');
    return;
  }

  console.log('[Electron] 启动内置服务器...');

  const resourcesPath = getResourcesPath();
  const serverPath = path.join(resourcesPath, 'server', 'index.js');
  const nodePath = path.join(resourcesPath, 'node_modules');

  console.log('[Electron] 服务器路径:', serverPath);
  console.log('[Electron] 模块路径:', nodePath);
  console.log('[Electron] 平台:', process.platform);

  // Windows 下需要设置 WSL 模式环境变量
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: '3000',
    NODE_PATH: nodePath
  };

  if (isWindows) {
    env.WEBTMUX_USE_WSL = 'true';
  }

  serverProcess = spawn('node', [serverPath], {
    cwd: resourcesPath,
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  serverProcess.stdout.on('data', (data) => {
    console.log(`[Server] ${data}`);
  });

  serverProcess.stderr.on('data', (data) => {
    console.error(`[Server Error] ${data}`);
  });

  serverProcess.on('close', (code) => {
    console.log(`[Server] 进程退出，代码: ${code}`);
  });

  serverProcess.on('error', (err) => {
    console.error('[Server] 启动错误:', err);
  });
}

function stopServer() {
  if (serverProcess) {
    console.log('[Electron] 停止服务器...');
    serverProcess.kill();
    serverProcess = null;
  }
}

// ==================== 应用生命周期 ====================

app.whenReady().then(async () => {
  // 检查依赖
  const dependenciesOk = await showDependencyDialog();
  if (!dependenciesOk) {
    app.quit();
    return;
  }

  startServer();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopServer();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopServer();
});

// 等待服务器启动
function waitForServer(url, timeout) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const check = () => {
      const http = require('http');
      const req = http.get(url, (res) => {
        if (res.statusCode === 200) {
          resolve();
        } else {
          retry();
        }
      });
      req.on('error', retry);
      req.setTimeout(1000, retry);
    };
    const retry = () => {
      if (Date.now() - startTime > timeout) {
        reject(new Error('Server startup timeout'));
      } else {
        setTimeout(check, 500);
      }
    };
    check();
  });
}

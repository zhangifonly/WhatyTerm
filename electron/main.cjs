const { app, BrowserWindow, Menu, Tray, dialog, shell, utilityProcess, ipcMain, nativeImage } = require('electron');
const path = require('path');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

let mainWindow;
let serverProcess;
let logStream;
let tray = null;
let forceQuit = false;  // 标记是否真正退出（区别于最小化到托盘）

// 检查是否是开发模式
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';

// ==================== 自动更新配置 ====================

// 配置自动更新
function setupAutoUpdater() {
  // 配置更新服务器
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: 'https://term.whaty.org/releases'
  });

  // 自动下载更新
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  // 更新事件监听
  autoUpdater.on('checking-for-update', () => {
    writeLog('[AutoUpdater] 正在检查更新...');
    sendUpdateStatus('checking');
  });

  autoUpdater.on('update-available', (info) => {
    writeLog(`[AutoUpdater] 发现新版本: ${info.version}`);
    sendUpdateStatus('available', {
      version: info.version,
      releaseNotes: info.releaseNotes,
      releaseDate: info.releaseDate
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    writeLog('[AutoUpdater] 当前已是最新版本');
    sendUpdateStatus('up-to-date', { version: info.version });
  });

  autoUpdater.on('error', (err) => {
    writeLog(`[AutoUpdater] 更新错误: ${err.message}`);
    sendUpdateStatus('error', { message: err.message });
  });

  autoUpdater.on('download-progress', (progress) => {
    writeLog(`[AutoUpdater] 下载进度: ${progress.percent.toFixed(1)}%`);
    sendUpdateStatus('downloading', {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    writeLog(`[AutoUpdater] 更新已下载: ${info.version}`);
    sendUpdateStatus('downloaded', { version: info.version });

    // 提示用户重启安装
    if (mainWindow) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '更新已就绪',
        message: `新版本 ${info.version} 已下载完成`,
        detail: '点击"立即重启"安装更新，或稍后手动重启应用。',
        buttons: ['立即重启', '稍后'],
        defaultId: 0,
        cancelId: 1
      }).then(({ response }) => {
        if (response === 0) {
          autoUpdater.quitAndInstall();
        }
      });
    }
  });
}

// 发送更新状态到渲染进程
function sendUpdateStatus(status, data = {}) {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('update-status', { status, ...data });
  }
}

// IPC 处理器
function setupIpcHandlers() {
  // 检查更新
  ipcMain.handle('check-for-update', async () => {
    if (isDev) {
      return { status: 'dev-mode', message: '开发模式下不检查更新' };
    }
    try {
      const result = await autoUpdater.checkForUpdates();
      return { status: 'ok', updateInfo: result?.updateInfo };
    } catch (err) {
      return { status: 'error', message: err.message };
    }
  });

  // 下载更新
  ipcMain.handle('download-update', async () => {
    try {
      await autoUpdater.downloadUpdate();
      return { status: 'ok' };
    } catch (err) {
      return { status: 'error', message: err.message };
    }
  });

  // 安装更新并重启
  ipcMain.handle('install-update', () => {
    autoUpdater.quitAndInstall();
  });

  // 获取当前版本
  ipcMain.handle('get-app-version', () => {
    return app.getVersion();
  });
}

// 获取日志目录（安装目录下的 logs 文件夹）
function getLogPath() {
  if (isDev) {
    return path.join(__dirname, '..', 'logs');
  }
  // 生产环境：使用安装目录
  return path.join(path.dirname(app.getPath('exe')), 'logs');
}

// 初始化日志
function initLog() {
  const logDir = getLogPath();
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  const logFile = path.join(logDir, `whatyterm-${new Date().toISOString().slice(0, 10)}.log`);
  logStream = fs.createWriteStream(logFile, { flags: 'a' });
  writeLog('========================================');
  writeLog(`WhatyTerm 启动 - ${new Date().toISOString()}`);
  writeLog(`平台: ${process.platform}, 架构: ${process.arch}`);
  writeLog(`Electron: ${process.versions.electron}, Node: ${process.versions.node}`);
  writeLog(`安装目录: ${path.dirname(app.getPath('exe'))}`);
  writeLog('========================================');
}

// 写入日志
function writeLog(message) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${message}\n`;
  if (logStream) {
    logStream.write(logLine);
  }
  console.log(message);
}

// 获取资源目录
function getResourcesPath() {
  if (isDev) {
    return path.join(__dirname, '..');
  }
  return process.resourcesPath;
}

// ==================== macOS 依赖检查 ====================

// 内置 tmux 释放路径
const WEBTMUX_BIN_DIR = path.join(require('os').homedir(), '.webtmux', 'bin');
const WEBTMUX_TMUX_PATH = path.join(WEBTMUX_BIN_DIR, 'tmux');

// 检查 tmux 是否安装 (macOS/Linux)
function checkTmux() {
  // 优先检查内置释放的 tmux
  try {
    execSync(`"${WEBTMUX_TMUX_PATH}" -V`, { stdio: 'pipe' });
    return true;
  } catch {}
  try {
    execSync('tmux -V', { stdio: 'pipe' });
    return true;
  } catch {
    try {
      execSync('/usr/local/bin/tmux -V', { stdio: 'pipe' });
      return true;
    } catch {
      try {
        execSync('/opt/homebrew/bin/tmux -V', { stdio: 'pipe' });
        return true;
      } catch {
        return false;
      }
    }
  }
}

// 从 app 内置文件释放 tmux 到 ~/.webtmux/bin/tmux
function extractBundledTmux() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const bundledName = `tmux-${arch}`;

  // 查找内置二进制：打包环境 vs 开发环境
  let bundledPath;
  if (app.isPackaged) {
    bundledPath = path.join(process.resourcesPath, 'server', 'bin', 'darwin', bundledName);
  } else {
    bundledPath = path.join(__dirname, '..', 'server', 'bin', 'darwin', bundledName);
  }

  if (!fs.existsSync(bundledPath)) {
    console.log(`内置 tmux 不存在: ${bundledPath}`);
    return false;
  }

  try {
    // 确保目录存在
    if (!fs.existsSync(WEBTMUX_BIN_DIR)) {
      fs.mkdirSync(WEBTMUX_BIN_DIR, { recursive: true });
    }

    // 复制并设置可执行权限
    fs.copyFileSync(bundledPath, WEBTMUX_TMUX_PATH);
    fs.chmodSync(WEBTMUX_TMUX_PATH, 0o755);

    // 验证
    execSync(`"${WEBTMUX_TMUX_PATH}" -V`, { stdio: 'pipe' });
    console.log(`内置 tmux 释放成功: ${WEBTMUX_TMUX_PATH}`);
    return true;
  } catch (err) {
    console.error(`释放内置 tmux 失败: ${err.message}`);
    return false;
  }
}

// 检查 Homebrew 是否安装
function checkHomebrew() {
  const brewPaths = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];
  for (const p of brewPaths) {
    try {
      execSync(`${p} --version`, { stdio: 'pipe' });
      return p;
    } catch {}
  }
  // 也试 PATH 里的
  try {
    execSync('brew --version', { stdio: 'pipe' });
    return 'brew';
  } catch {
    return null;
  }
}

// 安装 tmux (macOS)
async function installTmuxMac(brewPath) {
  const brew = brewPath || '/opt/homebrew/bin/brew';
  return new Promise((resolve, reject) => {
    const install = spawn(brew, ['install', 'tmux'], {
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
        // macOS 12 等旧版本上 brew install 可能因 Tier 3 警告返回非零退出码
        // 但 tmux 可能已经安装成功，检查 tmux 是否实际可用
        if (checkTmux()) {
          console.log(`brew install tmux 退出码 ${code}，但 tmux 已可用`);
          resolve(output);
        } else {
          reject(new Error(`安装失败，退出码: ${code}\n${output}`));
        }
      }
    });
  });
}

// 通过 osascript 弹窗获取管理员密码
async function promptForPassword() {
  return new Promise((resolve, reject) => {
    const script = `
      set pwd to text returned of (display dialog "WhatyTerm 需要安装系统依赖，请输入管理员密码：" default answer "" with hidden answer with title "WhatyTerm 安装" buttons {"取消", "确定"} default button "确定")
      return pwd`;
    const proc = spawn('osascript', ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error('用户取消了密码输入'));
    });
  });
}

// 安装 Homebrew (macOS, 以当前用户身份运行)
// 使用 SUDO_ASKPASS 机制让 Homebrew 安装脚本内部的所有 sudo 调用都能自动获取密码
async function installHomebrewMac() {
  const password = await promptForPassword();
  return new Promise((resolve, reject) => {
    // 通过环境变量传递密码，askpass 脚本从环境变量读取，避免命令注入
    const shellCmd = `
ASKPASS=$(mktemp /tmp/whatyterm-askpass.XXXXXX)
cat > "$ASKPASS" << 'ASKEOF'
#!/bin/bash
echo "$WHATYTERM_SUDO_PWD"
ASKEOF
chmod +x "$ASKPASS"
export SUDO_ASKPASS="$ASKPASS"
sudo -A -v 2>/dev/null
NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
EXIT_CODE=$?
rm -f "$ASKPASS"
exit $EXIT_CODE`;
    const install = spawn('/bin/bash', ['-c', shellCmd], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, WHATYTERM_SUDO_PWD: password }
    });
    install.stdin.end();

    let output = '';
    install.stdout.on('data', (data) => { output += data.toString(); });
    install.stderr.on('data', (data) => { output += data.toString(); });

    install.on('close', (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        // macOS 12 等旧版本上 brew update 会返回非零退出码（Tier 3 警告）
        // 但 Homebrew 可能已经安装成功，检查 brew 是否实际可用
        const brewPath = checkHomebrew();
        if (brewPath) {
          console.log(`Homebrew 安装脚本退出码 ${code}，但 brew 已可用: ${brewPath}`);
          resolve(output);
        } else {
          reject(new Error(`安装失败，退出码: ${code}\n${output}`));
        }
      }
    });
  });
}

// ==================== Windows WSL2 依赖检查 ====================

// 检查 WSL2 是否安装
function checkWSL() {
  // 优先使用 wsl -l -v 检测，这个命令更可靠
  try {
    const result = execSync('wsl -l -v', { stdio: 'pipe', encoding: 'utf-8' });
    // 如果有任何发行版列出，说明 WSL 已安装
    if (result && result.trim().length > 0) {
      return true;
    }
  } catch {
    // 忽略错误，继续尝试其他方式
  }

  // 备用检测：wsl --status
  try {
    const result = execSync('wsl --status', { stdio: 'pipe', encoding: 'utf-8' });
    return result.includes('默认版本') || result.includes('Default Version') || result.includes('WSL');
  } catch {
    return false;
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
      <h3 id="title" style="margin: 0 0 10px 0;">${title}</h3>
      <p id="msg" style="color: #888; font-size: 12px;">${message}</p>
      <div style="background: #333; border-radius: 4px; height: 6px; margin-top: 20px;">
        <div style="background: #4CAF50; height: 100%; width: 30%; border-radius: 4px; animation: progress 2s infinite;"></div>
      </div>
      <style>
        @keyframes progress { 0% { width: 10%; } 50% { width: 70%; } 100% { width: 10%; } }
      </style>
    </body>
    </html>
  `);

  progressWindow.updateMessage = (msg, newTitle) => {
    if (progressWindow.isDestroyed()) return;
    const js = newTitle
      ? `document.getElementById('title').innerText=${JSON.stringify(newTitle)};document.getElementById('msg').innerText=${JSON.stringify(msg)};`
      : `document.getElementById('msg').innerText=${JSON.stringify(msg)};`;
    progressWindow.webContents.executeJavaScript(js).catch(() => {});
  };

  return progressWindow;
}

// macOS 依赖检查 - 优先释放内置 tmux，fallback Homebrew
async function showMacDependencyDialog() {
  if (checkTmux()) return true;

  // 尝试释放内置 tmux（秒级完成）
  if (extractBundledTmux()) return true;

  // 内置 tmux 不可用，fallback 到 Homebrew
  const progressWindow = showProgressWindow('正在准备环境...', '检测系统依赖');

  try {
    let brewPath = checkHomebrew();
    if (!brewPath) {
      progressWindow.updateMessage('正在安装 Homebrew，首次安装可能需要几分钟...', '正在安装 Homebrew...');
      await installHomebrewMac();
      brewPath = checkHomebrew();
      if (!brewPath) {
        throw new Error('Homebrew 安装完成但无法检测到，请重启应用重试');
      }
    }

    progressWindow.updateMessage('正在通过 Homebrew 安装 tmux...', '正在安装 tmux...');
    await installTmuxMac(brewPath);

    if (!progressWindow.isDestroyed()) progressWindow.close();
    return true;
  } catch (err) {
    if (!progressWindow.isDestroyed()) progressWindow.close();
    await dialog.showMessageBox({
      type: 'error',
      title: '自动安装失败',
      message: '环境依赖安装失败',
      detail: err.message + '\n\n请手动执行以下命令：\n1. /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"\n2. brew install tmux',
      buttons: ['打开安装指南', '退出']
    }).then(result => {
      if (result.response === 0) shell.openExternal('https://brew.sh/');
    });
    return false;
  }
}

// Windows 依赖检查对话框
// Windows 使用 PowerShell + node-pty ConPTY，不需要 WSL 或 tmux
async function showWindowsDependencyDialog() {
  return true;
}

// Linux 依赖检查：直接检查系统 tmux，提示手动安装
async function showLinuxDependencyDialog() {
  if (checkTmux()) return true;

  const result = await dialog.showMessageBox({
    type: 'question',
    title: '需要安装 tmux',
    message: 'WhatyTerm 需要 tmux 才能运行',
    detail: '请使用系统包管理器安装 tmux：\n\nUbuntu/Debian:  sudo apt install tmux\nFedora/RHEL:    sudo dnf install tmux\nArch:           sudo pacman -S tmux',
    buttons: ['自动安装（apt）', '查看安装指南', '退出'],
    defaultId: 0,
    cancelId: 2
  });

  if (result.response === 0) {
    const progressWindow = showProgressWindow('正在安装 tmux...', '请稍候');
    try {
      const { execSync } = require('child_process');
      execSync('sudo apt-get install -y tmux', { stdio: 'pipe', timeout: 60000 });
      if (!progressWindow.isDestroyed()) progressWindow.close();
      return checkTmux();
    } catch (err) {
      if (!progressWindow.isDestroyed()) progressWindow.close();
      await dialog.showMessageBox({
        type: 'error',
        title: '自动安装失败',
        message: '请手动安装 tmux',
        detail: 'sudo apt install tmux\n或\nsudo dnf install tmux',
        buttons: ['确定']
      });
      return false;
    }
  } else if (result.response === 1) {
    shell.openExternal('https://github.com/tmux/tmux/wiki/Installing');
    return false;
  }
  return false;
}

// 统一的依赖检查入口
async function showDependencyDialog() {
  if (isWindows) {
    return await showWindowsDependencyDialog();
  } else if (isLinux) {
    return await showLinuxDependencyDialog();
  } else {
    return await showMacDependencyDialog();
  }
}

// ==================== 窗口和服务器管理 ====================

function getServerUrl() {
  return 'http://127.0.0.1:3928';
}

function openInBrowser() {
  shell.openExternal(getServerUrl());
}

function createTray() {
  if (!isWindows) return;  // 托盘常驻主要针对 Windows

  // 使用应用图标作为托盘图标
  let trayIcon;
  const resolvedIcoPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, '..', 'build', 'icon.ico');

  if (fs.existsSync(resolvedIcoPath)) {
    trayIcon = nativeImage.createFromPath(resolvedIcoPath).resize({ width: 16, height: 16 });
  } else {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('WhatyTerm - AI 终端管理器');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
        }
      }
    },
    {
      label: '在浏览器中打开',
      click: openInBrowser
    },
    { type: 'separator' },
    {
      label: '退出 WhatyTerm',
      click: () => {
        forceQuit = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);

  // 双击托盘图标显示窗口
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });

  // 单击托盘图标也显示窗口（Windows 习惯）
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });

  writeLog('[Electron] 系统托盘已创建');
}

function createWindow() {
  writeLog('[Electron] 开始创建窗口...');

  // 运行时图标路径（extraResources 打包到 resources/ 目录）
  const iconFile = isWindows ? 'icon.ico' : (isMac ? 'icon.icns' : 'icon.png');
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, iconFile)
    : path.join(__dirname, '..', 'build', isWindows ? 'icon.ico' : isMac ? 'icon.icns' : 'icons/512x512.png');

  const windowOptions = {
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    title: 'WhatyTerm - AI 终端管理器',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs')
    }
  };

  // macOS 特有的标题栏样式
  if (isMac) {
    windowOptions.titleBarStyle = 'hiddenInset';
    windowOptions.trafficLightPosition = { x: 15, y: 15 };
  }

  mainWindow = new BrowserWindow(windowOptions);
  writeLog('[Electron] 窗口已创建');

  // 监听窗口事件
  mainWindow.webContents.on('did-start-loading', () => {
    writeLog('[Electron] 页面开始加载');
  });

  mainWindow.webContents.on('did-finish-load', () => {
    writeLog('[Electron] 页面加载完成');
  });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    writeLog(`[Electron] 页面加载失败: ${errorCode} - ${errorDescription} - ${validatedURL}`);
  });

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    writeLog(`[Electron] 渲染进程崩溃: ${details.reason} - exitCode: ${details.exitCode}`);
  });

  mainWindow.webContents.on('unresponsive', () => {
    writeLog('[Electron] 窗口无响应');
  });

  mainWindow.webContents.on('crashed', (event, killed) => {
    writeLog(`[Electron] 渲染进程崩溃: killed=${killed}`);
  });

  mainWindow.on('unresponsive', () => {
    writeLog('[Electron] 窗口变为无响应状态');
  });

  // 开发模式连接 Vite 开发服务器，生产模式加载本地服务器
  if (isDev) {
    writeLog('[Electron] 开发模式，加载 http://localhost:5173');
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    writeLog('[Electron] 生产模式，等待服务器启动...');
    waitForServer('http://localhost:3928', 30000).then(() => {
      writeLog('[Electron] 服务器已就绪，加载 http://localhost:3928');
      mainWindow.loadURL('http://localhost:3928');
    }).catch((err) => {
      writeLog(`[Electron] 服务器启动超时: ${err.message}`);
      dialog.showErrorBox('服务器启动失败', '无法连接到 WhatyTerm 服务器，请检查日志。');
      app.quit();
    });
  }

  // Windows: 关闭按钮最小化到托盘，而非退出
  mainWindow.on('close', (event) => {
    if (isWindows && !forceQuit) {
      event.preventDefault();
      mainWindow.hide();
      writeLog('[Electron] 窗口最小化到系统托盘');
    }
  });

  mainWindow.on('closed', () => {
    writeLog('[Electron] 窗口已关闭');
    mainWindow = null;
  });

  // 设置菜单
  const template = [
    {
      label: 'WhatyTerm',
      submenu: [
        { label: '关于 WhatyTerm', role: 'about' },
        { label: '检查更新...', click: () => {
          if (isDev) {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '开发模式',
              message: '开发模式下不支持自动更新',
              buttons: ['确定']
            });
          } else {
            autoUpdater.checkForUpdates().catch(err => {
              dialog.showMessageBox(mainWindow, {
                type: 'error',
                title: '检查更新失败',
                message: err.message,
                buttons: ['确定']
              });
            });
          }
        }},
        { type: 'separator' },
        { label: '偏好设置...', accelerator: 'CmdOrCtrl+,', click: () => {
          mainWindow?.webContents.executeJavaScript('window.openSettings && window.openSettings()');
        }},
        { type: 'separator' },
        { label: '在浏览器中打开', accelerator: 'CmdOrCtrl+Shift+B', click: openInBrowser },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => { forceQuit = true; app.quit(); } }
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
        { label: '文档', click: () => shell.openExternal('https://ai.whaty.org') },
        { label: '报告问题', click: () => shell.openExternal('https://github.com/zhangifonly/WhatyTerm/issues') }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function startServer() {
  if (isDev) {
    writeLog('[Electron] 开发模式，跳过启动内置服务器');
    return;
  }

  writeLog('[Electron] 启动内置服务器...');

  const resourcesPath = getResourcesPath();
  const serverPath = path.join(resourcesPath, 'server', 'index.js');
  const nodePath = path.join(resourcesPath, 'node_modules');

  writeLog(`[Electron] 资源目录: ${resourcesPath}`);
  writeLog(`[Electron] 服务器路径: ${serverPath}`);
  writeLog(`[Electron] 模块路径: ${nodePath}`);
  writeLog(`[Electron] 服务器文件存在: ${fs.existsSync(serverPath)}`);

  // 检查 server/package.json 是否存在
  const serverPkgPath = path.join(resourcesPath, 'server', 'package.json');
  writeLog(`[Electron] server/package.json 存在: ${fs.existsSync(serverPkgPath)}`);

  // Windows 下需要设置 WSL 模式环境变量
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: '3928',  // 与服务器默认端口保持一致
    NODE_PATH: nodePath,
    ELECTRON_RUN_AS_NODE: '1',  // 让 Electron 以 Node.js 模式运行
    APP_VERSION: app.getVersion()  // 传递版本号给服务端
  };

  if (isWindows) {
    env.WEBTMUX_USE_WSL = 'true';
  }

  writeLog('[Electron] 使用 ELECTRON_RUN_AS_NODE 模式启动服务器');
  writeLog(`[Electron] execPath: ${process.execPath}`);

  // 使用 Electron 自带的 Node.js 运行服务器
  serverProcess = spawn(process.execPath, [serverPath], {
    cwd: resourcesPath,
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  serverProcess.stdout.on('data', (data) => {
    const text = data.toString().trim();
    // 如果输出已经有日志前缀（如 [Server], [FrpTunnel] 等），就不再添加
    if (text.startsWith('[')) {
      writeLog(text);
    } else {
      writeLog(`[Server] ${text}`);
    }
  });

  serverProcess.stderr.on('data', (data) => {
    const text = data.toString().trim();
    // 如果输出已经有日志前缀，就不再添加
    if (text.startsWith('[')) {
      writeLog(text);
    } else {
      writeLog(`[Server Error] ${text}`);
    }
  });

  serverProcess.on('close', (code) => {
    writeLog(`[Server] 进程退出，代码: ${code}`);
  });

  serverProcess.on('error', (err) => {
    writeLog(`[Server] 启动错误: ${err.message}`);
  });
}

function stopServer() {
  if (serverProcess) {
    console.log('[Electron] 停止服务器...');
    serverProcess.kill();
    serverProcess = null;
  }
  // Windows: 关闭 mux-server 守护进程
  if (isWindows) {
    try {
      const net = require('net');
      const pipePath = '\\\\.\\pipe\\whatyterm-mux';
      const client = net.createConnection(pipePath, () => {
        // 发送 shutdown 请求（mux-server 协议：4字节长度LE + JSON）
        const msg = JSON.stringify({ id: 'shutdown-' + Date.now(), method: 'shutdown', params: {} });
        const buf = Buffer.alloc(4 + Buffer.byteLength(msg));
        buf.writeUInt32LE(Buffer.byteLength(msg), 0);
        buf.write(msg, 4);
        client.write(buf);
        setTimeout(() => client.destroy(), 500);
      });
      client.on('error', () => {}); // mux-server 可能已经不在了
    } catch {}
  }
}

// ==================== 应用生命周期 ====================

// 全局错误捕获
// ==================== 崩溃上报 ====================

function reportCrash(type, message, stack, extra) {
  try {
    const os = require('os');
    const crypto = require('crypto');
    // 匿名设备ID
    let raw = (os.cpus()[0] || {}).model || '';
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name]) {
        if (!iface.internal && iface.mac !== '00:00:00:00:00:00') { raw += iface.mac; break; }
      }
    }
    const deviceId = crypto.createHash('sha256').update(raw).digest('hex').substring(0, 32);
    // 脱敏路径
    const sanitize = (s) => (s || '')
      .replace(/\/Users\/[^/]+/g, '/Users/***')
      .replace(/C:\\Users\\[^\\]+/g, 'C:\\Users\\***')
      .replace(/\/home\/[^/]+/g, '/home/***');
    // 读最近日志
    let recentLogs = '';
    try {
      const logDir = getLogPath();
      const logFiles = fs.readdirSync(logDir).filter(f => f.endsWith('.log')).sort().reverse();
      if (logFiles.length > 0) {
        const content = fs.readFileSync(path.join(logDir, logFiles[0]), 'utf8');
        recentLogs = sanitize(content.split('\n').slice(-50).join('\n')).substring(0, 5000);
      }
    } catch {}
    const pkg = require('./package.json');
    const payload = JSON.stringify({
      deviceId, appVersion: pkg.version, platform: os.platform(), arch: os.arch(),
      osVersion: os.release(), type, message: (message || '').substring(0, 500),
      stack: sanitize(stack || '').substring(0, 3000), recentLogs,
      extra: JSON.stringify(extra || {}).substring(0, 1000), timestamp: Date.now(),
    });
    const url = new URL('https://term.whaty.org/api/crash-report');
    const mod = require('https');
    const req = mod.request({ hostname: url.hostname, port: 443, path: url.pathname,
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 10000 }, () => {});
    req.on('error', () => {});
    req.write(payload);
    req.end();
  } catch {}
}

process.on('uncaughtException', (error) => {
  writeLog(`[Electron] 未捕获的异常: ${error.message}`);
  writeLog(`[Electron] 堆栈: ${error.stack}`);
  reportCrash('uncaughtException', error.message, error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  writeLog(`[Electron] 未处理的 Promise 拒绝: ${reason}`);
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stk = reason instanceof Error ? reason.stack : '';
  reportCrash('unhandledRejection', msg, stk);
});

app.on('render-process-gone', (event, webContents, details) => {
  writeLog(`[Electron] 渲染进程退出: ${details.reason}, exitCode: ${details.exitCode}`);
  reportCrash('renderCrash', `reason=${details.reason}, exitCode=${details.exitCode}`, '');
});

app.on('child-process-gone', (event, details) => {
  writeLog(`[Electron] 子进程退出: ${details.type}, reason: ${details.reason}, exitCode: ${details.exitCode}`);
  if (details.reason !== 'clean-exit') {
    reportCrash('childProcessCrash', `type=${details.type}, reason=${details.reason}, exitCode=${details.exitCode}`, '');
  }
});

app.whenReady().then(async () => {
  // 初始化日志
  initLog();

  // 初始化 IPC 处理器
  setupIpcHandlers();

  // 初始化自动更新（仅生产环境）
  if (!isDev) {
    setupAutoUpdater();
  }

  // 检查依赖
  const dependenciesOk = await showDependencyDialog();
  if (!dependenciesOk) {
    writeLog('[Electron] 依赖检查失败，退出应用');
    app.quit();
    return;
  }

  startServer();
  createTray();
  createWindow();

  // 延迟检查更新（启动后 3 秒）
  if (!isDev) {
    setTimeout(() => {
      writeLog('[Electron] 开始检查更新...');
      autoUpdater.checkForUpdates().catch(err => {
        writeLog(`[AutoUpdater] 检查更新失败: ${err.message}`);
      });
    }, 3000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // Windows: 窗口关闭不退出，常驻托盘
  if (isWindows) return;
  stopServer();
  // macOS: 关闭窗口不退出进程（dock 保留）
  // Linux/其他: 关闭即退出
  if (!isMac) {
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
    let attemptCount = 0;

    const check = () => {
      attemptCount++;
      const http = require('http');
      // Windows 上使用 127.0.0.1 代替 localhost，避免 DNS 解析问题
      // 检查 /api/sessions 端点，这是一个总是返回 200 的 API
      const checkUrl = url.replace('localhost', '127.0.0.1') + '/api/sessions';

      if (attemptCount % 10 === 1) {
        writeLog(`[Electron] 检测服务器 (第 ${attemptCount} 次): ${checkUrl}`);
      }

      const req = http.get(checkUrl, (res) => {
        // 任何 HTTP 响应都说明服务器已启动（包括 200、404 等）
        writeLog(`[Electron] 服务器响应: ${res.statusCode}`);
        resolve();
      });

      req.on('error', (err) => {
        if (attemptCount % 10 === 1) {
          writeLog(`[Electron] 连接错误 (第 ${attemptCount} 次): ${err.code || err.message}`);
        }
        retry();
      });

      req.setTimeout(2000, () => {
        if (attemptCount % 10 === 1) {
          writeLog(`[Electron] 连接超时 (第 ${attemptCount} 次)`);
        }
        req.destroy();
        retry();
      });
    };

    const retry = () => {
      if (Date.now() - startTime > timeout) {
        writeLog(`[Electron] 服务器检测超时，共尝试 ${attemptCount} 次`);
        reject(new Error('Server startup timeout'));
      } else {
        setTimeout(check, 500);
      }
    };

    check();
  });
}

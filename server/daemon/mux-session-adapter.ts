/**
 * MuxSessionAdapter - 将 Mux 模块适配到现有 SessionManager 接口
 *
 * 这个适配器将 Mux 的 Pane/Tab/Window 概念映射到现有的 Session 接口，
 * 使得 SessionManager 可以无缝使用 Mux 进行会话管理。
 */

import * as pty from 'node-pty';
import { EventEmitter } from 'events';
import { Mux, DEFAULT_WORKSPACE, ExtendedMuxNotification } from './mux';
import { LocalDomain } from './domain';
import { Tab } from './tab';
import { LocalPane, setLocalPaneMuxInstance } from './local-pane';
import { createDefaultTerminalSize, TerminalSize } from './renderable';
import type { PaneId } from './pane';
import type { TabId } from './tab-types';
import type { WindowId } from './window';

// ============================================
// 类型定义
// ============================================

export interface MuxSessionOptions {
  id?: string;
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  shell?: string;
  shellArgs?: string[];
  env?: Record<string, string>;
}

export interface MuxSessionInfo {
  id: string;
  paneId: PaneId;
  tabId: TabId;
  windowId: WindowId;
  name: string;
  createdAt: Date;
}

// ============================================
// MuxSession 类 - 单个会话的包装
// ============================================

/**
 * MuxSession 包装一个 Mux Pane，提供与现有 Session 类兼容的接口
 */
export class MuxSession extends EventEmitter {
  private paneId: PaneId;
  private tabId: TabId;
  private windowId: WindowId;
  private _name: string;
  private _createdAt: Date;
  private outputBuffer: string = '';
  private outputCallbacks: Array<(data: string) => void> = [];
  private bellCallbacks: Array<() => void> = [];
  private mux: Mux;
  private localPane: LocalPane | null = null;

  constructor(
    mux: Mux,
    paneId: PaneId,
    tabId: TabId,
    windowId: WindowId,
    name: string
  ) {
    super();
    this.mux = mux;
    this.paneId = paneId;
    this.tabId = tabId;
    this.windowId = windowId;
    this._name = name;
    this._createdAt = new Date();

    // 获取 LocalPane 引用
    const pane = mux.getPane(paneId);
    if (pane instanceof LocalPane) {
      this.localPane = pane;
      this.setupPaneListeners();
    }
  }

  private setupPaneListeners(): void {
    if (!this.localPane) return;

    // 监听 Pane 的数据事件
    this.localPane.onData((data: string) => {
      this.outputBuffer += data;
      // 限制缓冲区大小
      if (this.outputBuffer.length > 100000) {
        this.outputBuffer = this.outputBuffer.slice(-50000);
      }
      // 通知所有回调
      this.outputCallbacks.forEach(cb => cb(data));

      // 检测 bell 字符
      if (data.includes('\x07')) {
        this.bellCallbacks.forEach(cb => cb());
      }
    });
  }

  // ============================================
  // 与现有 Session 兼容的接口
  // ============================================

  get id(): string {
    return `mux-${this.paneId}`;
  }

  get name(): string {
    return this._name;
  }

  set name(value: string) {
    this._name = value;
  }

  get createdAt(): Date {
    return this._createdAt;
  }

  getPaneId(): PaneId {
    return this.paneId;
  }

  getTabId(): TabId {
    return this.tabId;
  }

  getWindowId(): WindowId {
    return this.windowId;
  }

  write(data: string): void {
    if (this.localPane) {
      this.localPane.sendPaste(data);
    }
  }

  resize(cols: number, rows: number): void {
    if (this.localPane) {
      const size: TerminalSize = {
        cols,
        rows,
        pixelWidth: 0,
        pixelHeight: 0,
        dpi: 96,
      };
      this.localPane.resize(size);
    }
  }

  onOutput(callback: (data: string) => void): (data: string) => void {
    this.outputCallbacks.push(callback);
    return callback;
  }

  offOutput(callback: (data: string) => void): void {
    const index = this.outputCallbacks.indexOf(callback);
    if (index > -1) {
      this.outputCallbacks.splice(index, 1);
    }
  }

  onBell(callback: () => void): () => void {
    this.bellCallbacks.push(callback);
    return callback;
  }

  offBell(callback: () => void): void {
    const index = this.bellCallbacks.indexOf(callback);
    if (index > -1) {
      this.bellCallbacks.splice(index, 1);
    }
  }

  getRecentOutput(lines: number = 50): string {
    const allLines = this.outputBuffer.split('\n');
    return allLines.slice(-lines).join('\n');
  }

  getOutputBuffer(): string {
    return this.outputBuffer;
  }

  destroy(): void {
    this.outputCallbacks = [];
    this.bellCallbacks = [];
    if (this.localPane) {
      this.localPane.kill();
    }
  }

  toJSON(): MuxSessionInfo {
    return {
      id: this.id,
      paneId: this.paneId,
      tabId: this.tabId,
      windowId: this.windowId,
      name: this._name,
      createdAt: this._createdAt,
    };
  }
}

// ============================================
// MuxSessionAdapter 类 - 管理所有 Mux 会话
// ============================================

/**
 * MuxSessionAdapter 管理 Mux 实例和所有会话
 */
export class MuxSessionAdapter extends EventEmitter {
  private mux: Mux | null = null;
  private domain: LocalDomain | null = null;
  private sessions: Map<string, MuxSession> = new Map();
  private initialized: boolean = false;

  constructor() {
    super();
  }

  /**
   * 初始化 Mux
   */
  initialize(): void {
    if (this.initialized) return;

    // 创建本地域
    this.domain = new LocalDomain('local');

    // 创建 Mux 实例
    this.mux = new Mux(this.domain);
    Mux.setMux(this.mux);

    // 设置 LocalPane 的 Mux 引用
    setLocalPaneMuxInstance(this.mux as any);

    // 订阅 Mux 通知
    this.mux.subscribe((notification: ExtendedMuxNotification) => {
      this.handleMuxNotification(notification);
      return true; // 保持订阅
    });

    this.initialized = true;
    console.log('[MuxSessionAdapter] Mux 初始化完成');
  }

  /**
   * 处理 Mux 通知
   */
  private handleMuxNotification(notification: ExtendedMuxNotification): void {
    switch (notification.type) {
      case 'PaneOutput':
        this.emit('pane:output', notification.paneId);
        break;
      case 'PaneAdded':
        this.emit('pane:added', notification.paneId);
        break;
      case 'PaneRemoved':
        this.emit('pane:removed', notification.paneId);
        break;
      case 'WindowCreated':
        this.emit('window:created', notification.windowId);
        break;
      case 'WindowRemoved':
        this.emit('window:removed', notification.windowId);
        break;
      default:
        // 其他通知类型
        break;
    }
  }

  /**
   * 创建新会话
   */
  async createSession(options: MuxSessionOptions = {}): Promise<MuxSession> {
    if (!this.initialized || !this.mux || !this.domain) {
      this.initialize();
    }

    const mux = this.mux!;
    const domain = this.domain!;

    // 确定 shell 和参数
    const isWindows = process.platform === 'win32';
    const shell = options.shell || (isWindows
      ? process.env.SystemRoot
        ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
        : 'powershell.exe'
      : process.env.SHELL || '/bin/bash');
    const shellArgs = options.shellArgs || (isWindows ? ['-NoLogo'] : []);

    // 创建终端尺寸
    const size: TerminalSize = {
      cols: options.cols || 80,
      rows: options.rows || 24,
      pixelWidth: 0,
      pixelHeight: 0,
      dpi: 96,
    };

    // 创建 PTY
    const ptyProcess = pty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      cwd: options.cwd || (isWindows ? process.env.USERPROFILE : process.env.HOME),
      env: {
        ...process.env,
        ...options.env,
        TERM: 'xterm-256color',
      } as Record<string, string>,
    });

    // 创建 LocalPane
    const pane = new LocalPane(
      domain.domainId(),
      ptyProcess,
      `${shell} ${shellArgs.join(' ')}`
    );

    // 添加 Pane 到 Mux
    mux.addPane(pane);

    // 创建 Tab
    const tab = new Tab(size);
    tab.assignPane(pane);

    // 添加 Tab 到 Mux（使用 addTabAndActivePane 会自动添加 pane）
    // 但我们已经手动添加了 pane，所以使用 addTabNoPanes
    mux.addTabNoPanes(tab);

    // 创建 Window 并添加 Tab
    const windowBuilder = mux.newEmptyWindow(DEFAULT_WORKSPACE);
    const windowId = windowBuilder.getWindowId();
    windowBuilder.dispose();

    // 将 Tab 添加到 Window
    mux.addTabToWindow(tab, windowId);

    // 创建 MuxSession 包装
    const sessionName = options.name || `session-${Date.now()}`;
    const session = new MuxSession(
      mux,
      pane.paneId(),
      tab.tabId(),
      windowId,
      sessionName
    );

    // 保存会话
    this.sessions.set(session.id, session);

    console.log(`[MuxSessionAdapter] 创建会话: ${session.id} (pane=${pane.paneId()}, tab=${tab.tabId()}, window=${windowId})`);

    return session;
  }

  /**
   * 获取会话
   */
  getSession(id: string): MuxSession | undefined {
    return this.sessions.get(id);
  }

  /**
   * 通过 PaneId 获取会话
   */
  getSessionByPaneId(paneId: PaneId): MuxSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.getPaneId() === paneId) {
        return session;
      }
    }
    return undefined;
  }

  /**
   * 列出所有会话
   */
  listSessions(): MuxSessionInfo[] {
    return Array.from(this.sessions.values()).map(s => s.toJSON());
  }

  /**
   * 删除会话
   */
  deleteSession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;

    session.destroy();
    this.sessions.delete(id);

    // 从 Mux 中移除相关资源
    if (this.mux) {
      this.mux.removePane(session.getPaneId());
      this.mux.removeTab(session.getTabId());
    }

    console.log(`[MuxSessionAdapter] 删除会话: ${id}`);
    return true;
  }

  /**
   * 关闭适配器
   */
  shutdown(): void {
    // 销毁所有会话
    for (const session of this.sessions.values()) {
      session.destroy();
    }
    this.sessions.clear();

    // 关闭 Mux
    if (this.mux) {
      Mux.shutdown();
      this.mux = null;
    }

    this.domain = null;
    this.initialized = false;

    console.log('[MuxSessionAdapter] 已关闭');
  }

  /**
   * 获取 Mux 实例
   */
  getMux(): Mux | null {
    return this.mux;
  }

  /**
   * 检查是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}

// 导出单例
export const muxAdapter = new MuxSessionAdapter();

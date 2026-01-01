/**
 * @file local-pane.ts
 * @description 翻译自 WezTerm: wezterm-source/mux/src/localpane.rs
 * @source https://github.com/wez/wezterm
 * @license MIT
 *
 * 原始代码行数: 1145
 * 翻译日期: 2026-01-01
 *
 * 功能说明:
 * - 实现本地 Pane（LocalPane）
 * - 管理 PTY 进程
 * - 处理终端输入/输出
 * - 支持搜索功能
 * - 进程状态追踪
 *
 * 与原始代码的差异:
 * - Rust portable_pty → node-pty
 * - Rust termwiz → xterm.js（前端）+ 简化的后端处理
 * - Rust Mutex → 不需要（JS 单线程）
 * - Rust async_trait → TypeScript async methods
 * - Rust parking_lot::MappedMutexGuard → 直接返回值
 * - Rust procinfo → 简化的进程信息获取
 * - Rust fancy_regex → JavaScript RegExp
 * - tmux 集成暂不实现（将在 tmux.ts 中处理）
 */

import { EventEmitter } from 'events';
import type { IPty } from 'node-pty';
import type { DomainId } from './domain';
import {
  type Pane,
  type PaneId,
  type Pattern,
  type SearchResult,
  type MouseEvent,
  type KeyModifiers,
  type KeyCode,
  type KeyAssignment,
  type ColorPalette,
  type SemanticZone,
  type Progress,
  PatternType,
  CloseReason,
  CachePolicy,
  ScrollbackEraseMode,
  KeyboardEncoding,
  ExitBehavior,
  PerformAssignmentResult,
  allocPaneId,
  AbstractPane,
} from './pane';
import {
  type TerminalSize,
  type StableCursorPosition,
  type RenderableDimensions,
  type StableRowIndex,
  type SequenceNo,
  type Line,
  type ForEachPaneLogicalLine,
  type WithPaneLines,
  RangeSet,
  CursorShape,
  CursorVisibility,
  createDefaultCursorPosition,
  createDefaultDimensions,
} from './renderable';

// ============================================
// 常量
// ============================================

/** 进程信息缓存 TTL（毫秒） */
const PROC_INFO_CACHE_TTL = 300;

// ============================================
// 进程状态
// ============================================

/**
 * 进程状态类型
 */
type ProcessState =
  | {
      type: 'running';
      pid: number | null;
      killed: boolean;
    }
  | {
      type: 'dead_pending_close';
      killed: boolean;
    }
  | {
      type: 'dead';
    };

/**
 * 缓存的进程信息
 */
interface CachedProcInfo {
  /** 根进程信息 */
  root: LocalProcessInfo;
  /** 更新时间 */
  updated: number;
  /** 前台进程信息 */
  foreground: LocalProcessInfo;
}

/**
 * 本地进程信息
 */
export interface LocalProcessInfo {
  /** 进程 ID */
  pid: number;
  /** 可执行文件路径 */
  executable: string;
  /** 当前工作目录 */
  cwd: string;
  /** 启动时间 */
  startTime: number;
  /** 子进程 */
  children: Map<number, LocalProcessInfo>;
}

/**
 * 本地 Pane 连接状态
 */
export enum LocalPaneConnectionState {
  Connecting = 'connecting',
  Connected = 'connected',
}

// ============================================
// 退出行为配置
// ============================================

/**
 * 退出行为消息模式
 */
export enum ExitBehaviorMessaging {
  Verbose = 'verbose',
  Brief = 'brief',
  Terse = 'terse',
  None = 'none',
}

/**
 * LocalPane 配置
 */
export interface LocalPaneConfig {
  /** 退出行为 */
  exitBehavior: ExitBehavior;
  /** 退出消息模式 */
  exitBehaviorMessaging: ExitBehaviorMessaging;
  /** 清洁退出码列表 */
  cleanExitCodes: number[];
  /** 跳过关闭确认的进程名 */
  skipCloseConfirmationForProcessesNamed: string[];
  /** 记录未知转义序列 */
  logUnknownEscapeSequences: boolean;
}

// 默认配置
let localPaneConfig: LocalPaneConfig = {
  exitBehavior: ExitBehavior.CloseOnCleanExit,
  exitBehaviorMessaging: ExitBehaviorMessaging.Verbose,
  cleanExitCodes: [0],
  skipCloseConfirmationForProcessesNamed: [
    'bash',
    'sh',
    'zsh',
    'fish',
    'tmux',
    'nu',
    'cmd.exe',
    'pwsh.exe',
    'powershell.exe',
    'pwsh',
    'powershell',
  ],
  logUnknownEscapeSequences: false,
};

/**
 * 设置 LocalPane 配置
 */
export function setLocalPaneConfig(config: Partial<LocalPaneConfig>): void {
  localPaneConfig = { ...localPaneConfig, ...config };
}

/**
 * 获取 LocalPane 配置
 */
export function getLocalPaneConfig(): LocalPaneConfig {
  return localPaneConfig;
}

// ============================================
// Mux 接口（前向声明）
// ============================================

/**
 * Mux 通知类型
 */
export type LocalPaneMuxNotification =
  | { type: 'PaneOutput'; paneId: PaneId }
  | { type: 'Alert'; paneId: PaneId; alert: unknown };

/**
 * Mux 接口
 */
export interface LocalPaneMuxInterface {
  recordInputForCurrentIdentity(): void;
  notify(notification: LocalPaneMuxNotification): void;
  getPane(paneId: PaneId): Pane | null;
  pruneDeadWindows(): void;
}

// Mux 实例引用
let muxInstance: LocalPaneMuxInterface | null = null;

/**
 * 设置 Mux 实例
 */
export function setLocalPaneMuxInstance(mux: LocalPaneMuxInterface): void {
  muxInstance = mux;
}

/**
 * 获取 Mux 实例
 */
function getMux(): LocalPaneMuxInterface {
  if (!muxInstance) {
    throw new Error('Mux not initialized');
  }
  return muxInstance;
}

// ============================================
// 辅助函数
// ============================================

/**
 * 为 Pane 发送输出
 */
export function emitOutputForPane(paneId: PaneId, message: string): void {
  setImmediate(() => {
    const mux = getMux();
    const pane = mux.getPane(paneId);
    if (pane) {
      // 在实际实现中，这会将消息写入终端
      // pane.performActions([...]);
      mux.notify({ type: 'PaneOutput', paneId });
    }
  });
}

// ============================================
// LocalPane 类
// ============================================

/**
 * LocalPane 类
 *
 * 表示一个本地终端面板，管理 PTY 进程和终端状态。
 */
export class LocalPane extends AbstractPane {
  /** PTY 实例 */
  private pty: IPty | null = null;
  /** 进程状态 */
  private processState: ProcessState;
  /** 缓存的进程信息 */
  private procList: CachedProcInfo | null = null;
  /** 命令描述 */
  private commandDescription: string;
  /** 终端标题 */
  private terminalTitle: string = '';
  /** 光标位置 */
  private cursorPosition: StableCursorPosition;
  /** 终端维度 */
  private dimensions: RenderableDimensions;
  /** 序列号 */
  private seqno: SequenceNo = 0;
  /** 滚动缓冲区 */
  private scrollback: Line[] = [];
  /** 用户变量 */
  private userVars: Map<string, string> = new Map();
  /** 是否有未查看的输出 */
  private unseenOutput: boolean = false;
  /** 是否鼠标被捕获 */
  private mouseGrabbed: boolean = false;
  /** 是否在备用屏幕 */
  private altScreenActive: boolean = false;
  /** 当前工作目录 */
  private currentDir: string | null = null;
  /** 事件发射器 */
  private events: EventEmitter = new EventEmitter();

  /**
   * 创建新的 LocalPane
   * @param paneId Pane ID (可选，如果不提供则自动分配)
   * @param pty PTY 实例
   * @param domainId Domain ID
   * @param commandDescription 命令描述
   * @param size 初始终端尺寸 (可选)
   */
  constructor(
    paneIdOrDomainId: PaneId | DomainId,
    ptyOrNull: IPty | null,
    domainIdOrCommandDescription: DomainId | string,
    commandDescriptionOrSize?: string | TerminalSize,
    size?: TerminalSize
  ) {
    // 支持两种调用方式:
    // 1. new LocalPane(paneId, pty, domainId, commandDescription, size) - 新方式
    // 2. new LocalPane(domainId, pty, commandDescription) - 旧方式
    let actualPaneId: PaneId;
    let actualDomainId: DomainId;
    let actualCommandDescription: string;
    let actualSize: TerminalSize | undefined;

    if (typeof domainIdOrCommandDescription === 'string') {
      // 旧方式: (domainId, pty, commandDescription)
      actualPaneId = allocPaneId();
      actualDomainId = paneIdOrDomainId;
      actualCommandDescription = domainIdOrCommandDescription;
      actualSize = undefined;
    } else {
      // 新方式: (paneId, pty, domainId, commandDescription, size)
      actualPaneId = paneIdOrDomainId;
      actualDomainId = domainIdOrCommandDescription;
      actualCommandDescription = commandDescriptionOrSize as string;
      actualSize = size;
    }

    super(actualDomainId, actualPaneId);
    this.pty = ptyOrNull;
    this.commandDescription = actualCommandDescription;
    this.cursorPosition = createDefaultCursorPosition();
    this.dimensions = createDefaultDimensions();

    // 如果提供了尺寸，应用它
    if (actualSize) {
      this.dimensions.cols = actualSize.cols;
      this.dimensions.viewportRows = actualSize.rows;
      this.dimensions.pixelWidth = actualSize.pixelWidth;
      this.dimensions.pixelHeight = actualSize.pixelHeight;
      this.dimensions.dpi = actualSize.dpi;
    }

    if (ptyOrNull) {
      this.processState = {
        type: 'running',
        pid: ptyOrNull.pid,
        killed: false,
      };

      // 监听 PTY 事件
      this.setupPtyListeners();
    } else {
      this.processState = { type: 'dead' };
    }
  }

  /**
   * 设置 PTY 事件监听器
   */
  private setupPtyListeners(): void {
    if (!this.pty) return;

    // 监听数据输出
    this.pty.onData((data) => {
      this.seqno++;
      this.unseenOutput = true;
      this.events.emit('data', data);
    });

    // 监听退出
    this.pty.onExit(({ exitCode, signal }) => {
      this.handleProcessExit(exitCode, signal);
    });
  }

  /**
   * 处理进程退出
   */
  private handleProcessExit(exitCode: number, signal?: number): void {
    const success =
      exitCode === 0 || localPaneConfig.cleanExitCodes.includes(exitCode);

    const killed =
      this.processState.type === 'running' && this.processState.killed;

    const exitBehavior = localPaneConfig.exitBehavior;

    let terse = '';
    let brief = '';
    let trailer = '';
    const cmd = this.commandDescription;

    switch (exitBehavior) {
      case ExitBehavior.Close:
        this.processState = { type: 'dead' };
        break;

      case ExitBehavior.CloseOnCleanExit:
        if (!success) {
          brief = `Process ${cmd} didn't exit cleanly`;
          terse = `Exit code: ${exitCode}`;
          trailer = 'exit_behavior="CloseOnCleanExit"';
          this.processState = { type: 'dead_pending_close', killed: false };
        } else {
          this.processState = { type: 'dead' };
        }
        break;

      case ExitBehavior.Hold:
        if (!killed) {
          trailer = 'exit_behavior="Hold"';
          if (success) {
            brief = `Process ${cmd} completed.`;
            terse = 'done';
          } else {
            brief = `Process ${cmd} didn't exit cleanly`;
            terse = `Exit code: ${exitCode}`;
          }
          this.processState = { type: 'dead_pending_close', killed: false };
        } else {
          this.processState = { type: 'dead' };
        }
        break;
    }

    // 发送退出消息
    if (terse) {
      let notify = '';
      switch (localPaneConfig.exitBehaviorMessaging) {
        case ExitBehaviorMessaging.Verbose:
          notify =
            terse === 'done'
              ? `\r\n${brief}\r\n${trailer}`
              : `\r\n${brief}\r\n${terse}\r\n${trailer}`;
          break;
        case ExitBehaviorMessaging.Brief:
          notify =
            terse === 'done' ? `\r\n${brief}` : `\r\n${brief}\r\n${terse}`;
          break;
        case ExitBehaviorMessaging.Terse:
          notify = `\r\n[${terse}]`;
          break;
        case ExitBehaviorMessaging.None:
          break;
      }
      if (notify) {
        emitOutputForPane(this.paneId(), notify);
      }
    }

    // 通知 Mux 清理
    setImmediate(() => {
      try {
        getMux().pruneDeadWindows();
      } catch {
        // Mux 可能未初始化
      }
    });
  }

  // ============================================
  // Pane 接口实现
  // ============================================

  getCursorPosition(): StableCursorPosition {
    return { ...this.cursorPosition };
  }

  getCurrentSeqno(): SequenceNo {
    return this.seqno;
  }

  getMetadata(): unknown {
    return {
      password_input: false, // 简化实现
    };
  }

  getChangedSince(
    lines: { start: StableRowIndex; end: StableRowIndex },
    seqno: SequenceNo
  ): RangeSet {
    const set = new RangeSet();
    // 简化实现：如果序列号变化，标记所有行为脏
    if (seqno < this.seqno) {
      set.addRange(lines.start, lines.end);
    }
    return set;
  }

  getLines(lines: {
    start: StableRowIndex;
    end: StableRowIndex;
  }): [StableRowIndex, Line[]] {
    // 简化实现：返回空行
    const result: Line[] = [];
    for (let i = lines.start; i < lines.end; i++) {
      result.push({
        text: this.scrollback[i]?.text ?? '',
        dirty: false,
        seqno: this.seqno,
      });
    }
    return [lines.start, result];
  }

  getDimensions(): RenderableDimensions {
    return { ...this.dimensions };
  }

  getTitle(): string {
    if (this.terminalTitle && this.terminalTitle !== 'wezterm') {
      return this.terminalTitle;
    }
    // 尝试返回进程名
    const procName = this.getForegroundProcessName(CachePolicy.AllowStale);
    if (procName) {
      const parts = procName.split(/[/\\]/);
      return parts[parts.length - 1] || procName;
    }
    return this.terminalTitle || this.commandDescription;
  }

  getProgress(): Progress {
    return { type: 'none' };
  }

  async sendPaste(text: string): Promise<void> {
    getMux().recordInputForCurrentIdentity();
    if (this.pty) {
      this.pty.write(text);
    }
  }

  reader(): NodeJS.ReadableStream | null {
    // node-pty 不直接提供 ReadableStream
    // 在实际实现中，可以通过事件监听获取数据
    return null;
  }

  writer(): NodeJS.WritableStream {
    // 返回一个简单的写入接口
    const pty = this.pty;
    return {
      write(chunk: Buffer | string): boolean {
        if (pty) {
          pty.write(chunk.toString());
        }
        return true;
      },
      end(): void {},
      on(): NodeJS.WritableStream {
        return this;
      },
      once(): NodeJS.WritableStream {
        return this;
      },
      emit(): boolean {
        return true;
      },
      addListener(): NodeJS.WritableStream {
        return this;
      },
      removeListener(): NodeJS.WritableStream {
        return this;
      },
      off(): NodeJS.WritableStream {
        return this;
      },
      removeAllListeners(): NodeJS.WritableStream {
        return this;
      },
      setMaxListeners(): NodeJS.WritableStream {
        return this;
      },
      getMaxListeners(): number {
        return 10;
      },
      listeners(): Function[] {
        return [];
      },
      rawListeners(): Function[] {
        return [];
      },
      listenerCount(): number {
        return 0;
      },
      prependListener(): NodeJS.WritableStream {
        return this;
      },
      prependOnceListener(): NodeJS.WritableStream {
        return this;
      },
      eventNames(): (string | symbol)[] {
        return [];
      },
      writable: true,
      writableEnded: false,
      writableFinished: false,
      writableHighWaterMark: 16384,
      writableLength: 0,
      writableObjectMode: false,
      writableCorked: 0,
      writableNeedDrain: false,
      writableErrored: null,
      closed: false,
      errored: null,
      destroyed: false,
      _write(): void {},
      _destroy(): void {},
      _final(): void {},
      setDefaultEncoding(): NodeJS.WritableStream {
        return this;
      },
      cork(): void {},
      uncork(): void {},
      destroy(): NodeJS.WritableStream {
        return this;
      },
      pipe<T>(): T {
        return this as unknown as T;
      },
      compose(): NodeJS.WritableStream {
        return this;
      },
      [Symbol.asyncDispose](): Promise<void> {
        return Promise.resolve();
      },
    } as unknown as NodeJS.WritableStream;
  }

  async resize(size: TerminalSize): Promise<void> {
    if (this.pty) {
      this.pty.resize(size.cols, size.rows);
    }
    this.dimensions = {
      ...this.dimensions,
      cols: size.cols,
      viewportRows: size.rows,
      pixelWidth: size.pixelWidth,
      pixelHeight: size.pixelHeight,
      dpi: size.dpi,
    };
  }

  async keyDown(key: KeyCode, mods: KeyModifiers): Promise<void> {
    getMux().recordInputForCurrentIdentity();
    // 在实际实现中，这会将按键转换为终端序列并发送
    // 简化实现：直接发送字符
    if (this.pty && key.length === 1) {
      this.pty.write(key);
    }
  }

  async keyUp(_key: KeyCode, _mods: KeyModifiers): Promise<void> {
    getMux().recordInputForCurrentIdentity();
    // 大多数终端不处理 key up 事件
  }

  async mouseEvent(event: MouseEvent): Promise<void> {
    getMux().recordInputForCurrentIdentity();
    // 在实际实现中，这会将鼠标事件转换为终端序列
  }

  isDead(): boolean {
    // 检查进程状态
    if (this.processState.type === 'dead_pending_close') {
      if (this.processState.killed) {
        this.processState = { type: 'dead' };
      }
    }
    return this.processState.type === 'dead';
  }

  kill(): void {
    console.log(
      `killing process in pane ${this.paneId()}, state is ${this.processState.type}`
    );

    switch (this.processState.type) {
      case 'running':
        if (this.pty) {
          this.pty.kill();
        }
        this.processState = { ...this.processState, killed: true };
        break;
      case 'dead_pending_close':
        this.processState = { ...this.processState, killed: true };
        break;
    }
  }

  palette(): ColorPalette {
    // 返回默认调色板
    return {
      foreground: '#ffffff',
      background: '#000000',
      cursor: '#ffffff',
      selection: '#444444',
      colors: [
        '#000000',
        '#cc0000',
        '#4e9a06',
        '#c4a000',
        '#3465a4',
        '#75507b',
        '#06989a',
        '#d3d7cf',
        '#555753',
        '#ef2929',
        '#8ae234',
        '#fce94f',
        '#729fcf',
        '#ad7fa8',
        '#34e2e2',
        '#eeeeec',
      ],
    };
  }

  getKeyboardEncoding(): KeyboardEncoding {
    return KeyboardEncoding.Xterm;
  }

  copyUserVars(): Map<string, string> {
    return new Map(this.userVars);
  }

  eraseScrollback(eraseMode: ScrollbackEraseMode): void {
    switch (eraseMode) {
      case ScrollbackEraseMode.ScrollbackOnly:
        this.scrollback = [];
        break;
      case ScrollbackEraseMode.ScrollbackAndViewport:
        this.scrollback = [];
        // 也清除视口
        break;
    }
    this.seqno++;
  }

  focusChanged(focused: boolean): void {
    // 在实际实现中，这会发送焦点变化事件到终端
    this.events.emit('focus', focused);
  }

  hasUnseenOutput(): boolean {
    return this.unseenOutput;
  }

  canCloseWithoutPrompting(_reason: CloseReason): boolean {
    // 简化实现：检查进程是否已死亡
    if (this.processState.type === 'dead') {
      return true;
    }
    if (this.processState.type === 'dead_pending_close') {
      return true;
    }

    // 检查进程名是否在跳过列表中
    const procName = this.getForegroundProcessName(CachePolicy.FetchImmediate);
    if (procName) {
      const baseName = procName.split(/[/\\]/).pop() || procName;
      if (
        localPaneConfig.skipCloseConfirmationForProcessesNamed.includes(
          baseName
        )
      ) {
        return true;
      }
    }

    return false;
  }

  async search(
    pattern: Pattern,
    range: { start: StableRowIndex; end: StableRowIndex },
    limit: number | null
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const uniqMatches: Map<string, number> = new Map();

    // 编译搜索模式
    let regex: RegExp | null = null;
    let searchString: string | null = null;

    switch (pattern.type) {
      case PatternType.CaseSensitiveString:
        searchString = pattern.value;
        break;
      case PatternType.CaseInSensitiveString:
        searchString = pattern.value.toLowerCase();
        break;
      case PatternType.Regex:
        try {
          regex = new RegExp(pattern.value, 'g');
        } catch {
          return results;
        }
        break;
    }

    // 搜索滚动缓冲区
    for (let y = range.start; y < range.end; y++) {
      if (limit !== null && results.length >= limit) {
        break;
      }

      const line = this.scrollback[y];
      if (!line) continue;

      let haystack = line.text;
      if (pattern.type === PatternType.CaseInSensitiveString) {
        haystack = haystack.toLowerCase();
      }

      if (searchString) {
        let idx = 0;
        while ((idx = haystack.indexOf(searchString, idx)) !== -1) {
          const matchText = line.text.substring(idx, idx + searchString.length);
          let matchId = uniqMatches.get(matchText);
          if (matchId === undefined) {
            matchId = uniqMatches.size;
            uniqMatches.set(matchText, matchId);
          }

          results.push({
            startY: y,
            startX: idx,
            endY: y,
            endX: idx + searchString.length,
            matchId,
          });

          idx += searchString.length;

          if (limit !== null && results.length >= limit) {
            break;
          }
        }
      } else if (regex) {
        let match;
        while ((match = regex.exec(haystack)) !== null) {
          const matchText = match[0];
          let matchId = uniqMatches.get(matchText);
          if (matchId === undefined) {
            matchId = uniqMatches.size;
            uniqMatches.set(matchText, matchId);
          }

          results.push({
            startY: y,
            startX: match.index,
            endY: y,
            endX: match.index + matchText.length,
            matchId,
          });

          if (limit !== null && results.length >= limit) {
            break;
          }
        }
      }
    }

    return results;
  }

  getSemanticZones(): SemanticZone[] {
    // 简化实现：返回空数组
    return [];
  }

  isMouseGrabbed(): boolean {
    return this.mouseGrabbed;
  }

  isAltScreenActive(): boolean {
    return this.altScreenActive;
  }

  getCurrentWorkingDir(_policy: CachePolicy): string | null {
    return this.currentDir;
  }

  getForegroundProcessName(_policy: CachePolicy): string | null {
    if (this.procList) {
      return this.procList.foreground.executable;
    }
    return null;
  }

  getForegroundProcessInfo(_policy: CachePolicy): LocalProcessInfo | null {
    if (this.procList) {
      return this.procList.foreground;
    }
    return null;
  }

  ttyName(): string | null {
    // node-pty 不直接提供 TTY 名称
    return null;
  }

  exitBehavior(): ExitBehavior | null {
    return localPaneConfig.exitBehavior;
  }

  // ============================================
  // LocalPane 特有方法
  // ============================================

  /**
   * 获取 PTY 实例
   */
  getPty(): IPty | null {
    return this.pty;
  }

  /**
   * 设置终端标题
   */
  setTerminalTitle(title: string): void {
    this.terminalTitle = title;
  }

  /**
   * 设置当前工作目录
   */
  setCurrentDir(dir: string): void {
    this.currentDir = dir;
  }

  /**
   * 设置光标位置
   */
  setCursorPosition(x: number, y: StableRowIndex): void {
    this.cursorPosition.x = x;
    this.cursorPosition.y = y;
  }

  /**
   * 设置光标形状
   */
  setCursorShape(shape: CursorShape): void {
    this.cursorPosition.shape = shape;
  }

  /**
   * 设置光标可见性
   */
  setCursorVisibility(visibility: CursorVisibility): void {
    this.cursorPosition.visibility = visibility;
  }

  /**
   * 设置鼠标捕获状态
   */
  setMouseGrabbed(grabbed: boolean): void {
    this.mouseGrabbed = grabbed;
  }

  /**
   * 设置备用屏幕状态
   */
  setAltScreenActive(active: boolean): void {
    this.altScreenActive = active;
  }

  /**
   * 添加行到滚动缓冲区
   */
  addLine(text: string): void {
    this.scrollback.push({
      text,
      dirty: true,
      seqno: this.seqno,
    });
    this.seqno++;
  }

  /**
   * 清除未查看输出标记
   */
  clearUnseenOutput(): void {
    this.unseenOutput = false;
  }

  /**
   * 设置用户变量
   */
  setUserVar(key: string, value: string): void {
    this.userVars.set(key, value);
  }

  /**
   * 监听数据事件
   */
  onData(callback: (data: string) => void): void {
    this.events.on('data', callback);
  }

  /**
   * 监听焦点事件
   */
  onFocus(callback: (focused: boolean) => void): void {
    this.events.on('focus', callback);
  }

  /**
   * 写入数据到 PTY
   */
  write(data: string): void {
    if (this.pty) {
      this.pty.write(data);
    }
  }
}

// ============================================
// 工厂函数
// ============================================

/**
 * 创建新的 LocalPane
 * @param domainId Domain ID
 * @param pty PTY 实例
 * @param commandDescription 命令描述
 */
export function createLocalPane(
  domainId: DomainId,
  pty: IPty | null,
  commandDescription: string
): LocalPane {
  return new LocalPane(domainId, pty, commandDescription);
}

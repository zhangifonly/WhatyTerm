/**
 * @file pane.ts
 * @description 翻译自 WezTerm: wezterm-source/mux/src/pane.rs
 * @source https://github.com/wez/wezterm
 * @license MIT
 *
 * 原始代码行数: 1086
 * 翻译日期: 2026-01-01
 *
 * 功能说明:
 * - 定义 Pane 接口（终端面板的抽象）
 * - 定义搜索相关类型（Pattern, SearchResult）
 * - 定义逻辑行处理（LogicalLine）
 * - 提供 Pane 相关的辅助函数
 *
 * 与原始代码的差异:
 * - Rust trait Pane → TypeScript interface Pane
 * - Rust async_trait → TypeScript async methods
 * - Rust Downcast → 不需要（TypeScript 有 instanceof）
 * - Rust parking_lot::Mutex → 不需要（JS 单线程）
 * - Rust termwiz 类型 → 简化的 TypeScript 类型
 * - 测试代码未翻译（将单独创建测试文件）
 */

import type { DomainId } from './domain.js';
import {
  type StableCursorPosition,
  type RenderableDimensions,
  type StableRowIndex,
  type SequenceNo,
  type Line,
  type ForEachPaneLogicalLine,
  type WithPaneLines,
  RangeSet,
  createDefaultCursorPosition,
  createDefaultDimensions,
} from './renderable.js';

// ============================================
// 类型定义
// ============================================

/**
 * Pane ID 类型
 */
export type PaneId = number;

// Pane ID 计数器
let paneIdCounter = 0;

/**
 * 分配新的 Pane ID
 */
export function allocPaneId(): PaneId {
  return paneIdCounter++;
}

/**
 * 执行按键分配的结果
 */
export enum PerformAssignmentResult {
  /** 继续搜索处理器 */
  Unhandled = 'unhandled',
  /** 找到处理器并执行了操作 */
  Handled = 'handled',
  /** 不执行分配，将按键事件作为 key_down 处理 */
  BlockAssignmentAndRouteToKeyDown = 'block_assignment_and_route_to_key_down',
}

/**
 * 搜索结果
 */
export interface SearchResult {
  /** 匹配开始的行（稳定行索引） */
  startY: StableRowIndex;
  /** 匹配开始的列（单元格索引） */
  startX: number;
  /** 匹配结束的行（稳定行索引） */
  endY: StableRowIndex;
  /** 匹配结束的列（单元格索引） */
  endX: number;
  /** 匹配 ID（用于分组相同内容的结果） */
  matchId: number;
}

/**
 * 搜索模式类型
 */
export enum PatternType {
  CaseSensitiveString = 'case_sensitive_string',
  CaseInSensitiveString = 'case_insensitive_string',
  Regex = 'regex',
}

/**
 * 搜索模式
 */
export type Pattern =
  | { type: PatternType.CaseSensitiveString; value: string }
  | { type: PatternType.CaseInSensitiveString; value: string }
  | { type: PatternType.Regex; value: string };

/**
 * 创建默认的搜索模式
 */
export function createDefaultPattern(): Pattern {
  return { type: PatternType.CaseSensitiveString, value: '' };
}

/**
 * 获取模式的字符串值
 */
export function getPatternValue(pattern: Pattern): string {
  return pattern.value;
}

/**
 * 设置模式的字符串值
 */
export function setPatternValue(pattern: Pattern, value: string): Pattern {
  return { ...pattern, value };
}

/**
 * 关闭原因
 */
export enum CloseReason {
  /** 包含的窗口正在关闭 */
  Window = 'window',
  /** 包含的标签页正在关闭 */
  Tab = 'tab',
  /** 只有这个面板正在关闭 */
  Pane = 'pane',
}

/**
 * 逻辑行
 *
 * 表示一个逻辑行，可能由多个物理行组成（当行被换行时）。
 */
export class LogicalLine {
  /** 组成逻辑行的物理行 */
  physicalLines: Line[];
  /** 合并后的逻辑行 */
  logical: Line;
  /** 第一个物理行的稳定行索引 */
  firstRow: StableRowIndex;

  constructor(physicalLines: Line[], logical: Line, firstRow: StableRowIndex) {
    this.physicalLines = physicalLines;
    this.logical = logical;
    this.firstRow = firstRow;
  }

  /**
   * 检查是否包含指定的行
   */
  containsY(y: StableRowIndex): boolean {
    return y >= this.firstRow && y < this.firstRow + this.physicalLines.length;
  }

  /**
   * 将物理坐标 (x, y) 转换为逻辑 x 坐标
   */
  xyToLogicalX(x: number, y: StableRowIndex): number {
    let offset = 0;
    for (let idx = 0; idx < this.physicalLines.length; idx++) {
      const physY = this.firstRow + idx;
      if (y < physY) {
        // 尝试拖动到视口顶部之外
        // y 坐标在第一行之前，只能返回 0
        return 0;
      }
      if (physY === y) {
        return offset + x;
      }
      offset += this.physicalLines[idx].text.length;
    }
    // 允许选择到行尾之外
    return offset + x;
  }

  /**
   * 将逻辑 x 坐标转换为物理坐标 (y, x)
   */
  logicalXToPhysicalCoord(x: number): [StableRowIndex, number] {
    let y = this.firstRow;
    let idx = 0;
    for (const line of this.physicalLines) {
      const xOff = x - idx;
      const lineLen = line.text.length;
      if (xOff < lineLen) {
        return [y, xOff];
      }
      y++;
      idx += lineLen;
    }
    const lastLine = this.physicalLines[this.physicalLines.length - 1];
    return [y - 1, x - idx + lastLine.text.length];
  }
}

/**
 * 缓存策略
 */
export enum CachePolicy {
  /** 立即获取 */
  FetchImmediate = 'fetch_immediate',
  /** 允许使用过期数据 */
  AllowStale = 'allow_stale',
}

/**
 * 终端尺寸
 */
export interface TerminalSize {
  /** 行数 */
  rows: number;
  /** 列数 */
  cols: number;
  /** 像素宽度 */
  pixelWidth: number;
  /** 像素高度 */
  pixelHeight: number;
  /** DPI */
  dpi: number;
}

/**
 * 鼠标事件
 */
export interface MouseEvent {
  /** 事件类型 */
  kind: 'press' | 'release' | 'move' | 'wheel';
  /** 按钮 */
  button: 'left' | 'right' | 'middle' | 'none';
  /** x 坐标 */
  x: number;
  /** y 坐标 */
  y: number;
  /** 修饰键 */
  modifiers: KeyModifiers;
}

/**
 * 按键修饰符
 */
export interface KeyModifiers {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
}

/**
 * 按键代码
 */
export type KeyCode = string;

/**
 * 按键分配
 */
export interface KeyAssignment {
  key: KeyCode;
  modifiers: KeyModifiers;
  action: string;
}

/**
 * 滚动缓冲区擦除模式
 */
export enum ScrollbackEraseMode {
  /** 擦除所有滚动缓冲区 */
  All = 'all',
  /** 擦除滚动缓冲区到当前行 */
  ScrollbackOnly = 'scrollback_only',
  /** 擦除滚动缓冲区和屏幕 */
  ScrollbackAndViewport = 'scrollback_and_viewport',
}

/**
 * 进度状态
 */
export type Progress =
  | { type: 'none' }
  | { type: 'indeterminate' }
  | { type: 'percent'; value: number };

/**
 * 语义区域
 */
export interface SemanticZone {
  startY: StableRowIndex;
  startX: number;
  endY: StableRowIndex;
  endX: number;
  semanticType: string;
}

/**
 * 退出行为
 */
export enum ExitBehavior {
  /** 关闭面板 */
  Close = 'close',
  /** 保持面板打开 */
  Hold = 'hold',
  /** 关闭面板（如果成功退出） */
  CloseOnCleanExit = 'close_on_clean_exit',
}

/**
 * 键盘编码
 */
export enum KeyboardEncoding {
  Xterm = 'xterm',
  Kitty = 'kitty',
}

/**
 * 颜色调色板
 */
export interface ColorPalette {
  foreground: string;
  background: string;
  cursor: string;
  selection: string;
  colors: string[];
}

// ============================================
// Pane 接口
// ============================================

/**
 * Pane 接口
 *
 * 表示终端中的一个面板视图。
 * 这是 WezTerm mux 系统的核心抽象。
 */
export interface Pane {
  /**
   * 获取 Pane ID
   */
  paneId(): PaneId;

  /**
   * 获取光标位置（相对于可见屏幕左上角，0-based）
   */
  getCursorPosition(): StableCursorPosition;

  /**
   * 获取当前序列号
   */
  getCurrentSeqno(): SequenceNo;

  /**
   * 获取 Pane 特定的元数据
   */
  getMetadata(): unknown;

  /**
   * 获取指定范围内自指定序列号以来发生变化的行
   */
  getChangedSince(
    lines: { start: StableRowIndex; end: StableRowIndex },
    seqno: SequenceNo
  ): RangeSet;

  /**
   * 获取指定范围的行
   * 返回 [调整后的第一行索引, 行数组]
   */
  getLines(lines: {
    start: StableRowIndex;
    end: StableRowIndex;
  }): [StableRowIndex, Line[]];

  /**
   * 使用可变行引用处理指定范围的行
   */
  withLinesMut(
    lines: { start: StableRowIndex; end: StableRowIndex },
    withLines: WithPaneLines
  ): void;

  /**
   * 遍历指定范围内的逻辑行
   */
  forEachLogicalLineInStableRangeMut(
    lines: { start: StableRowIndex; end: StableRowIndex },
    forLine: ForEachPaneLogicalLine
  ): void;

  /**
   * 获取指定范围的逻辑行
   */
  getLogicalLines(lines: {
    start: StableRowIndex;
    end: StableRowIndex;
  }): LogicalLine[];

  /**
   * 获取渲染维度
   */
  getDimensions(): RenderableDimensions;

  /**
   * 获取标题
   */
  getTitle(): string;

  /**
   * 获取进度状态
   */
  getProgress(): Progress;

  /**
   * 发送粘贴文本
   */
  sendPaste(text: string): Promise<void>;

  /**
   * 获取读取器（用于读取 PTY 输出）
   */
  reader(): NodeJS.ReadableStream | null;

  /**
   * 获取写入器（用于写入 PTY 输入）
   */
  writer(): NodeJS.WritableStream;

  /**
   * 调整大小
   */
  resize(size: TerminalSize): Promise<void>;

  /**
   * 设置缩放状态
   */
  setZoomed(zoomed: boolean): void;

  /**
   * 处理按键按下事件
   */
  keyDown(key: KeyCode, mods: KeyModifiers): Promise<void>;

  /**
   * 处理按键释放事件
   */
  keyUp(key: KeyCode, mods: KeyModifiers): Promise<void>;

  /**
   * 执行按键分配
   */
  performAssignment(assignment: KeyAssignment): PerformAssignmentResult;

  /**
   * 处理鼠标事件
   */
  mouseEvent(event: MouseEvent): Promise<void>;

  /**
   * 执行终端动作
   */
  performActions(actions: unknown[]): void;

  /**
   * 检查是否已死亡
   */
  isDead(): boolean;

  /**
   * 终止 Pane
   */
  kill(): void;

  /**
   * 获取颜色调色板
   */
  palette(): ColorPalette;

  /**
   * 获取所属 Domain ID
   */
  domainId(): DomainId;

  /**
   * 获取键盘编码
   */
  getKeyboardEncoding(): KeyboardEncoding;

  /**
   * 复制用户变量
   */
  copyUserVars(): Map<string, string>;

  /**
   * 擦除滚动缓冲区
   */
  eraseScrollback(eraseMode: ScrollbackEraseMode): void;

  /**
   * 焦点变化通知
   */
  focusChanged(focused: boolean): void;

  /**
   * 通知远程 mux 这是当前身份的活动标签
   */
  adviseFocus(): void;

  /**
   * 检查是否有未查看的输出
   */
  hasUnseenOutput(): boolean;

  /**
   * 检查是否可以无提示关闭
   */
  canCloseWithoutPrompting(reason: CloseReason): boolean;

  /**
   * 执行搜索
   */
  search(
    pattern: Pattern,
    range: { start: StableRowIndex; end: StableRowIndex },
    limit: number | null
  ): Promise<SearchResult[]>;

  /**
   * 获取语义区域
   */
  getSemanticZones(): SemanticZone[];

  /**
   * 检查鼠标是否被捕获
   */
  isMouseGrabbed(): boolean;

  /**
   * 检查是否在备用屏幕
   */
  isAltScreenActive(): boolean;

  /**
   * 获取当前工作目录
   */
  getCurrentWorkingDir(policy: CachePolicy): string | null;

  /**
   * 获取前台进程名称
   */
  getForegroundProcessName(policy: CachePolicy): string | null;

  /**
   * 获取前台进程信息
   */
  getForegroundProcessInfo(policy: CachePolicy): unknown | null;

  /**
   * 获取 TTY 名称
   */
  ttyName(): string | null;

  /**
   * 获取退出行为
   */
  exitBehavior(): ExitBehavior | null;
}

// ============================================
// 辅助函数
// ============================================

/**
 * 通过 get_lines 实现 with_lines_mut
 */
export function implWithLinesViaGetLines(
  pane: Pane,
  lines: { start: StableRowIndex; end: StableRowIndex },
  withLines: WithPaneLines
): void {
  const [first, lineArray] = pane.getLines(lines);
  withLines.withLinesMut(first, lineArray);
}

/**
 * 通过 get_logical_lines 实现 for_each_logical_line_in_stable_range_mut
 */
export function implForEachLogicalLineViaGetLogicalLines(
  pane: Pane,
  lines: { start: StableRowIndex; end: StableRowIndex },
  forLine: ForEachPaneLogicalLine
): void {
  const logical = pane.getLogicalLines(lines);

  for (const line of logical) {
    const numLines = line.physicalLines.length;
    const shouldContinue = forLine.withLogicalLineMut(
      { start: line.firstRow, end: line.firstRow + numLines },
      line.physicalLines
    );
    if (!shouldContinue) {
      break;
    }
  }
}

/**
 * 通过 get_lines 实现 get_logical_lines
 */
export function implGetLogicalLinesViaGetLines(
  pane: Pane,
  lines: { start: StableRowIndex; end: StableRowIndex }
): LogicalLine[] {
  let [first, phys] = pane.getLines(lines);

  // 避免病态情况：非常长的逻辑行（如 1.5MB 的 JSON）
  const MAX_LOGICAL_LINE_LEN = 1024;
  let backLen = 0;

  // 向后查找第一个逻辑行的开始
  while (first > 0) {
    const [prior, back] = pane.getLines({ start: first - 1, end: first });
    if (prior === first) {
      break;
    }
    if (!back[0].dirty) {
      // 使用 dirty 作为 last_cell_was_wrapped 的替代
      break;
    }
    if (back[0].text.length + backLen > MAX_LOGICAL_LINE_LEN) {
      break;
    }
    backLen += back[0].text.length;
    first = prior;
    phys = [...back, ...phys];
  }

  // 向前查找最后一个逻辑行的结束
  while (phys.length > 0) {
    const last = phys[phys.length - 1];
    if (!last.dirty) {
      break;
    }
    if (last.text.length > MAX_LOGICAL_LINE_LEN) {
      break;
    }

    const nextRow = first + phys.length;
    const [lastRow, ahead] = pane.getLines({
      start: nextRow,
      end: nextRow + 1,
    });
    if (lastRow !== nextRow) {
      break;
    }
    phys = [...phys, ...ahead];
  }

  // 处理成逻辑行
  const result: LogicalLine[] = [];
  for (let idx = 0; idx < phys.length; idx++) {
    const line = phys[idx];
    const lastLogical = result[result.length - 1];

    if (!lastLogical) {
      result.push(
        new LogicalLine([line], { ...line }, first + idx)
      );
    } else if (
      lastLogical.logical.dirty &&
      lastLogical.logical.text.length <= MAX_LOGICAL_LINE_LEN
    ) {
      // 合并到上一个逻辑行
      lastLogical.logical.text += line.text;
      lastLogical.logical.dirty = false;
      lastLogical.physicalLines.push(line);
    } else {
      result.push(
        new LogicalLine([line], { ...line }, first + idx)
      );
    }
  }

  return result;
}

/**
 * 通过 with_lines_mut 实现 get_lines
 */
export function implGetLinesViaWithLines(
  pane: Pane,
  lines: { start: StableRowIndex; end: StableRowIndex }
): [StableRowIndex, Line[]] {
  let collectedFirst: StableRowIndex = 0;
  const collectedLines: Line[] = [];

  const collector: WithPaneLines = {
    withLinesMut(firstRow: StableRowIndex, lineArray: Line[]): void {
      collectedFirst = firstRow;
      collectedLines.push(...lineArray.map((l) => ({ ...l })));
    },
  };

  pane.withLinesMut(lines, collector);
  return [collectedFirst, collectedLines];
}

// ============================================
// 默认 Pane 实现（抽象基类）
// ============================================

/**
 * 抽象 Pane 基类
 *
 * 提供 Pane 接口的默认实现。
 * 具体的 Pane 实现应该继承此类并覆盖必要的方法。
 */
export abstract class AbstractPane implements Pane {
  protected _paneId: PaneId;
  protected _domainId: DomainId;

  constructor(domainId: DomainId, paneId?: PaneId) {
    this._paneId = paneId ?? allocPaneId();
    this._domainId = domainId;
  }

  paneId(): PaneId {
    return this._paneId;
  }

  domainId(): DomainId {
    return this._domainId;
  }

  getCursorPosition(): StableCursorPosition {
    return createDefaultCursorPosition();
  }

  getCurrentSeqno(): SequenceNo {
    return 0;
  }

  getMetadata(): unknown {
    return null;
  }

  getChangedSince(
    _lines: { start: StableRowIndex; end: StableRowIndex },
    _seqno: SequenceNo
  ): RangeSet {
    return new RangeSet();
  }

  abstract getLines(lines: {
    start: StableRowIndex;
    end: StableRowIndex;
  }): [StableRowIndex, Line[]];

  withLinesMut(
    lines: { start: StableRowIndex; end: StableRowIndex },
    withLines: WithPaneLines
  ): void {
    implWithLinesViaGetLines(this, lines, withLines);
  }

  forEachLogicalLineInStableRangeMut(
    lines: { start: StableRowIndex; end: StableRowIndex },
    forLine: ForEachPaneLogicalLine
  ): void {
    implForEachLogicalLineViaGetLogicalLines(this, lines, forLine);
  }

  getLogicalLines(lines: {
    start: StableRowIndex;
    end: StableRowIndex;
  }): LogicalLine[] {
    return implGetLogicalLinesViaGetLines(this, lines);
  }

  getDimensions(): RenderableDimensions {
    return createDefaultDimensions();
  }

  abstract getTitle(): string;

  getProgress(): Progress {
    return { type: 'none' };
  }

  abstract sendPaste(text: string): Promise<void>;

  reader(): NodeJS.ReadableStream | null {
    return null;
  }

  abstract writer(): NodeJS.WritableStream;

  abstract resize(size: TerminalSize): Promise<void>;

  setZoomed(_zoomed: boolean): void {}

  abstract keyDown(key: KeyCode, mods: KeyModifiers): Promise<void>;

  abstract keyUp(key: KeyCode, mods: KeyModifiers): Promise<void>;

  performAssignment(_assignment: KeyAssignment): PerformAssignmentResult {
    return PerformAssignmentResult.Unhandled;
  }

  abstract mouseEvent(event: MouseEvent): Promise<void>;

  performActions(_actions: unknown[]): void {}

  abstract isDead(): boolean;

  kill(): void {}

  abstract palette(): ColorPalette;

  getKeyboardEncoding(): KeyboardEncoding {
    return KeyboardEncoding.Xterm;
  }

  copyUserVars(): Map<string, string> {
    return new Map();
  }

  eraseScrollback(_eraseMode: ScrollbackEraseMode): void {}

  focusChanged(_focused: boolean): void {}

  adviseFocus(): void {}

  hasUnseenOutput(): boolean {
    return false;
  }

  canCloseWithoutPrompting(_reason: CloseReason): boolean {
    return false;
  }

  async search(
    _pattern: Pattern,
    _range: { start: StableRowIndex; end: StableRowIndex },
    _limit: number | null
  ): Promise<SearchResult[]> {
    return [];
  }

  getSemanticZones(): SemanticZone[] {
    return [];
  }

  isMouseGrabbed(): boolean {
    return false;
  }

  isAltScreenActive(): boolean {
    return false;
  }

  getCurrentWorkingDir(_policy: CachePolicy): string | null {
    return null;
  }

  getForegroundProcessName(_policy: CachePolicy): string | null {
    return null;
  }

  getForegroundProcessInfo(_policy: CachePolicy): unknown | null {
    return null;
  }

  ttyName(): string | null {
    return null;
  }

  exitBehavior(): ExitBehavior | null {
    return null;
  }
}

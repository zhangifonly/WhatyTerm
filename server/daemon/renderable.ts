/**
 * @file renderable.ts
 * @description 翻译自 WezTerm: wezterm-source/mux/src/renderable.rs
 * @source https://github.com/wez/wezterm
 * @license MIT
 *
 * 原始代码行数: 142
 * 翻译日期: 2026-01-01
 *
 * 功能说明:
 * - 定义光标位置（StableCursorPosition）
 * - 定义渲染维度（RenderableDimensions）
 * - 提供终端渲染相关的辅助函数
 *
 * 与原始代码的差异:
 * - Rust termwiz::surface → 简化为基本类型
 * - Rust wezterm_term::Terminal → 我们使用 xterm.js，这些函数主要用于接口定义
 * - Rust RangeSet → JavaScript Set
 * - 大部分终端渲染函数在我们的实现中由 xterm.js 处理
 */

/**
 * 终端尺寸
 * 描述终端的行列数和像素尺寸
 */
export interface TerminalSize {
  /** 行数 */
  rows: number;
  /** 列数 */
  cols: number;
  /** 像素高度 */
  pixelHeight: number;
  /** 像素宽度 */
  pixelWidth: number;
  /** DPI */
  dpi: number;
}

/**
 * 创建默认的终端尺寸
 */
export function createDefaultTerminalSize(): TerminalSize {
  return {
    rows: 24,
    cols: 80,
    pixelHeight: 0,
    pixelWidth: 0,
    dpi: 96,
  };
}

/**
 * 稳定行索引类型
 * 用于标识滚动缓冲区中的行
 */
export type StableRowIndex = number;

/**
 * 序列号类型
 * 用于追踪变更
 */
export type SequenceNo = number;

/**
 * 光标形状
 */
export enum CursorShape {
  /** 默认形状（通常是块状） */
  Default = 'default',
  /** 块状光标 */
  BlinkingBlock = 'blinking_block',
  SteadyBlock = 'steady_block',
  /** 下划线光标 */
  BlinkingUnderline = 'blinking_underline',
  SteadyUnderline = 'steady_underline',
  /** 竖线光标 */
  BlinkingBar = 'blinking_bar',
  SteadyBar = 'steady_bar',
}

/**
 * 光标可见性
 */
export enum CursorVisibility {
  Visible = 'visible',
  Hidden = 'hidden',
}

/**
 * 稳定光标位置
 *
 * 描述光标在终端中的位置，使用稳定行索引。
 */
export interface StableCursorPosition {
  /** 列位置（从 0 开始） */
  x: number;
  /** 行位置（稳定行索引） */
  y: StableRowIndex;
  /** 光标形状 */
  shape: CursorShape;
  /** 光标可见性 */
  visibility: CursorVisibility;
}

/**
 * 创建默认的光标位置
 */
export function createDefaultCursorPosition(): StableCursorPosition {
  return {
    x: 0,
    y: 0,
    shape: CursorShape.Default,
    visibility: CursorVisibility.Visible,
  };
}

/**
 * 渲染维度
 *
 * 描述终端的渲染尺寸和滚动状态。
 */
export interface RenderableDimensions {
  /** 视口宽度（列数） */
  cols: number;
  /** 视口高度（行数） */
  viewportRows: number;
  /** 滚动缓冲区总行数（包括视口） */
  scrollbackRows: number;
  /** 物理屏幕顶部的稳定行索引 */
  physicalTop: StableRowIndex;
  /** 滚动缓冲区顶部的稳定行索引 */
  scrollbackTop: StableRowIndex;
  /** DPI */
  dpi: number;
  /** 像素宽度 */
  pixelWidth: number;
  /** 像素高度 */
  pixelHeight: number;
  /** 是否反转视频 */
  reverseVideo: boolean;
}

/**
 * 创建默认的渲染维度
 */
export function createDefaultDimensions(): RenderableDimensions {
  return {
    cols: 80,
    viewportRows: 24,
    scrollbackRows: 0,
    physicalTop: 0,
    scrollbackTop: 0,
    dpi: 96,
    pixelWidth: 0,
    pixelHeight: 0,
    reverseVideo: false,
  };
}

/**
 * 行数据接口
 *
 * 表示终端中的一行内容。
 * 注意：在我们的实现中，终端渲染由 xterm.js 处理，
 * 这个接口主要用于与 WezTerm 架构保持一致。
 */
export interface Line {
  /** 行内容 */
  text: string;
  /** 是否被修改 */
  dirty: boolean;
  /** 序列号 */
  seqno: SequenceNo;
}

/**
 * 范围集合
 *
 * 用于追踪脏行（需要重新渲染的行）。
 * 简化实现，使用 Set 替代 Rust 的 RangeSet。
 */
export class RangeSet {
  private ranges: Set<StableRowIndex> = new Set();

  /**
   * 添加一个行索引
   */
  add(index: StableRowIndex): void {
    this.ranges.add(index);
  }

  /**
   * 添加一个范围
   */
  addRange(start: StableRowIndex, end: StableRowIndex): void {
    for (let i = start; i < end; i++) {
      this.ranges.add(i);
    }
  }

  /**
   * 检查是否包含某个索引
   */
  contains(index: StableRowIndex): boolean {
    return this.ranges.has(index);
  }

  /**
   * 获取所有索引
   */
  toArray(): StableRowIndex[] {
    return Array.from(this.ranges).sort((a, b) => a - b);
  }

  /**
   * 清空集合
   */
  clear(): void {
    this.ranges.clear();
  }

  /**
   * 获取大小
   */
  get size(): number {
    return this.ranges.size;
  }
}

/**
 * ForEachPaneLogicalLine 回调接口
 *
 * 用于遍历逻辑行的回调。
 * 返回 true 继续遍历，返回 false 停止遍历。
 */
export interface ForEachPaneLogicalLine {
  withLogicalLineMut(
    stableRange: { start: StableRowIndex; end: StableRowIndex },
    lines: Line[]
  ): boolean;
}

/**
 * WithPaneLines 回调接口
 *
 * 用于处理 Pane 行的回调。
 */
export interface WithPaneLines {
  withLinesMut(firstRow: StableRowIndex, lines: Line[]): void;
}

// ============================================
// 以下函数在 WezTerm 中用于 Terminal 渲染
// 在我们的实现中，这些功能由 xterm.js 处理
// 保留这些函数定义是为了与 WezTerm 架构保持一致
// ============================================

/**
 * 获取终端光标位置
 *
 * 注意：在我们的实现中，这个功能由 xterm.js 处理。
 * 这个函数仅作为接口参考。
 */
export function terminalGetCursorPosition(
  _term: unknown
): StableCursorPosition {
  // 在实际实现中，这会从 xterm.js 获取光标位置
  return createDefaultCursorPosition();
}

/**
 * 获取终端脏行
 *
 * 注意：在我们的实现中，这个功能由 xterm.js 处理。
 */
export function terminalGetDirtyLines(
  _term: unknown,
  lines: { start: StableRowIndex; end: StableRowIndex },
  _seqno: SequenceNo
): RangeSet {
  const set = new RangeSet();
  // 在实际实现中，这会从 xterm.js 获取脏行
  set.addRange(lines.start, lines.end);
  return set;
}

/**
 * 获取终端维度
 *
 * 注意：在我们的实现中，这个功能由 xterm.js 处理。
 */
export function terminalGetDimensions(_term: unknown): RenderableDimensions {
  // 在实际实现中，这会从 xterm.js 获取维度
  return createDefaultDimensions();
}

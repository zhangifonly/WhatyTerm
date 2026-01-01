/**
 * @file activity.ts
 * @description 翻译自 WezTerm: wezterm-source/mux/src/activity.rs
 * @source https://github.com/wez/wezterm
 * @license MIT
 *
 * 原始代码行数: 36
 * 翻译日期: 2026-01-01
 *
 * 功能说明:
 * - 追踪用户发起的活动数量
 * - 用于在没有窗口时保持前端活跃
 *
 * 与原始代码的差异:
 * - Rust AtomicUsize → JavaScript 普通变量（JS 单线程，不需要原子操作）
 * - Rust Drop trait → JavaScript 手动调用 dispose()
 * - Rust promise::spawn → JavaScript setTimeout/Promise
 */

import type { Mux } from './mux.js';

// 活动计数器（替代 Rust 的 AtomicUsize）
let activityCount = 0;

// Mux 实例引用（延迟绑定）
let muxInstance: Mux | null = null;

/**
 * 设置 Mux 实例引用
 * @param mux Mux 实例
 */
export function setMuxInstance(mux: Mux): void {
  muxInstance = mux;
}

/**
 * Activity 类
 *
 * 创建并持有一个 Activity 实例，用于处理用户发起的操作（如打开窗口）。
 * 操作完成后，调用 dispose() 释放 Activity。
 * Activity 用于在 mux 中没有窗口时保持前端活跃。
 *
 * 使用示例:
 * ```typescript
 * const activity = new Activity();
 * try {
 *   // 执行用户操作
 *   await openWindow();
 * } finally {
 *   activity.dispose();
 * }
 * ```
 */
export class Activity {
  private disposed = false;

  constructor() {
    activityCount++;
  }

  /**
   * 获取当前活动数量
   */
  static count(): number {
    return activityCount;
  }

  /**
   * 释放 Activity（对应 Rust 的 Drop trait）
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    activityCount--;

    // 异步清理死窗口（对应 Rust 的 promise::spawn::spawn_into_main_thread）
    setImmediate(() => {
      if (muxInstance) {
        muxInstance.pruneDeadWindows();
      }
    });
  }
}

/**
 * 使用 Activity 包装异步操作的辅助函数
 * @param fn 要执行的异步操作
 * @returns 操作结果
 */
export async function withActivity<T>(fn: () => Promise<T>): Promise<T> {
  const activity = new Activity();
  try {
    return await fn();
  } finally {
    activity.dispose();
  }
}

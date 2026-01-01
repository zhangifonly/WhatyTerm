/**
 * @file window.ts
 * @description 翻译自 WezTerm: wezterm-source/mux/src/window.rs
 * @source https://github.com/wez/wezterm
 * @license MIT
 *
 * 原始代码行数: 268
 * 翻译日期: 2026-01-01
 *
 * 功能说明:
 * - 定义 Window 类（窗口管理）
 * - 管理窗口中的标签页（Tab）
 * - 处理活动标签页切换
 * - 支持工作区（Workspace）
 *
 * 与原始代码的差异:
 * - Rust AtomicUsize → JavaScript 普通变量（JS 单线程）
 * - Rust Arc<Tab> → Tab（JS 有 GC）
 * - Rust Vec<Arc<Tab>> → Tab[]
 * - Rust &str → string
 * - Rust Option<T> → T | null
 * - Rust assert_ne! → 手动检查并抛出错误
 * - Rust config::configuration() → 简化为可配置选项
 */

import { CloseReason } from './pane';

// ============================================
// 前向声明（这些类型将在其他模块中定义）
// ============================================

/**
 * Tab ID 类型
 * 将在 tab.ts 中正式定义
 */
export type TabId = number;

/**
 * Window ID 类型
 */
export type WindowId = number;

/**
 * GUI 位置配置
 */
export interface GuiPosition {
  x: number;
  y: number;
  width?: number;
  height?: number;
}

/**
 * Tab 接口（前向声明）
 * 完整定义将在 tab.ts 中
 */
export interface Tab {
  getTabId(): TabId;
  tabId(): TabId; // 兼容旧接口
  canCloseWithoutPrompting(reason: CloseReason): boolean;
  getActivePane(): { focusChanged(focused: boolean): void } | null;
  pruneDeadPanes(): boolean;
  isDead(): boolean;
  countPanes(): number;
  iterPanesIgnoringZoom(): Array<{ pane: { paneId(): number; domainId(): number } }>;
  getSize(): { rows: number; cols: number; pixelHeight: number; pixelWidth: number; dpi: number };
  killPanesInDomain(domainId: number): boolean;
}

/**
 * Mux 通知类型
 */
export type MuxNotification =
  | { type: 'WindowTitleChanged'; windowId: WindowId; title: string }
  | { type: 'WindowWorkspaceChanged'; windowId: WindowId }
  | { type: 'WindowInvalidated'; windowId: WindowId }
  | { type: 'TabTitleChanged'; tabId: TabId; title: string }
  | { type: 'TabResized'; tabId: TabId }
  | { type: 'PaneFocused'; paneId: number };

/**
 * Mux 接口（前向声明）
 * 完整定义将在 mux.ts 中
 */
export interface MuxInterface {
  activeWorkspace(): string;
  notify(notification: MuxNotification): void;
}

// Mux 实例引用（延迟绑定）
let muxInstance: MuxInterface | null = null;

/**
 * 设置 Mux 实例引用
 * @param mux Mux 实例
 */
export function setWindowMuxInstance(mux: MuxInterface): void {
  muxInstance = mux;
}

/**
 * 获取 Mux 实例
 * @returns Mux 实例
 * @throws 如果 Mux 未初始化
 */
function getMux(): MuxInterface {
  if (!muxInstance) {
    throw new Error('Mux not initialized');
  }
  return muxInstance;
}

/**
 * 尝试获取 Mux 实例
 * @returns Mux 实例或 null
 */
function tryGetMux(): MuxInterface | null {
  return muxInstance;
}

// ============================================
// 配置选项
// ============================================

/**
 * 窗口配置
 */
export interface WindowConfig {
  /** 关闭标签页时是否切换到上一个活动标签页 */
  switchToLastActiveTabWhenClosingTab: boolean;
}

// 默认配置
let windowConfig: WindowConfig = {
  switchToLastActiveTabWhenClosingTab: true,
};

/**
 * 设置窗口配置
 * @param config 配置对象
 */
export function setWindowConfig(config: Partial<WindowConfig>): void {
  windowConfig = { ...windowConfig, ...config };
}

/**
 * 获取窗口配置
 * @returns 当前配置
 */
export function getWindowConfig(): WindowConfig {
  return windowConfig;
}

// ============================================
// Window ID 分配
// ============================================

// Window ID 计数器（替代 Rust 的 AtomicUsize）
let windowIdCounter = 0;

/**
 * 分配新的 Window ID
 */
export function allocWindowId(): WindowId {
  return windowIdCounter++;
}

// ============================================
// Window 类
// ============================================

/**
 * Window 类
 *
 * 表示一个窗口，包含多个标签页（Tab）。
 * 管理标签页的添加、删除、激活等操作。
 */
export class Window {
  /** 窗口 ID */
  private id: WindowId;
  /** 标签页列表 */
  private tabs: Tab[];
  /** 当前活动标签页索引 */
  private active: number;
  /** 上一个活动标签页 ID */
  private lastActive: TabId | null;
  /** 工作区名称 */
  private workspace: string;
  /** 窗口标题 */
  private title: string;
  /** 初始位置 */
  private initialPosition: GuiPosition | null;

  /**
   * 创建新窗口
   * @param workspace 工作区名称（可选）
   * @param initialPosition 初始位置（可选）
   */
  constructor(workspace?: string, initialPosition?: GuiPosition) {
    this.id = allocWindowId();
    this.tabs = [];
    this.active = 0;
    this.lastActive = null;
    this.title = '';
    this.workspace = workspace ?? getMux().activeWorkspace();
    this.initialPosition = initialPosition ?? null;
  }

  /**
   * 获取初始位置
   */
  getInitialPosition(): GuiPosition | null {
    return this.initialPosition;
  }

  /**
   * 获取工作区名称
   */
  getWorkspace(): string {
    return this.workspace;
  }

  /**
   * 设置窗口标题
   * @param title 新标题
   */
  setTitle(title: string): void {
    if (this.title !== title) {
      this.title = title;
      const mux = tryGetMux();
      if (mux) {
        mux.notify({
          type: 'WindowTitleChanged',
          windowId: this.id,
          title,
        });
      }
    }
  }

  /**
   * 获取窗口标题
   */
  getTitle(): string {
    return this.title;
  }

  /**
   * 设置工作区
   * @param workspace 新工作区名称
   */
  setWorkspace(workspace: string): void {
    if (workspace === this.workspace) {
      return;
    }
    this.workspace = workspace;
    getMux().notify({
      type: 'WindowWorkspaceChanged',
      windowId: this.id,
    });
  }

  /**
   * 获取窗口 ID
   */
  windowId(): WindowId {
    return this.id;
  }

  /**
   * 检查标签页是否已在窗口中
   * @param tab 要检查的标签页
   * @throws 如果标签页已存在
   */
  private checkThatTabIsntAlreadyInWindow(tab: Tab): void {
    for (const t of this.tabs) {
      if (t.tabId() === tab.tabId()) {
        throw new Error('tab already added to this window');
      }
    }
  }

  /**
   * 使窗口无效（触发重绘）
   */
  private invalidate(): void {
    const mux = getMux();
    mux.notify({
      type: 'WindowInvalidated',
      windowId: this.id,
    });
  }

  /**
   * 在指定位置插入标签页
   * @param index 插入位置
   * @param tab 要插入的标签页
   */
  insert(index: number, tab: Tab): void {
    this.checkThatTabIsntAlreadyInWindow(tab);
    this.tabs.splice(index, 0, tab);
    this.invalidate();
  }

  /**
   * 在末尾添加标签页
   * @param tab 要添加的标签页
   */
  push(tab: Tab): void {
    this.checkThatTabIsntAlreadyInWindow(tab);
    this.tabs.push(tab);
    this.invalidate();
  }

  /**
   * 检查窗口是否为空
   */
  isEmpty(): boolean {
    return this.tabs.length === 0;
  }

  /**
   * 获取标签页数量
   */
  len(): number {
    return this.tabs.length;
  }

  /**
   * 通过索引获取标签页
   * @param idx 索引
   * @returns 标签页或 null
   */
  getByIdx(idx: number): Tab | null {
    return this.tabs[idx] ?? null;
  }

  /**
   * 检查是否可以无提示关闭
   */
  canCloseWithoutPrompting(): boolean {
    for (const tab of this.tabs) {
      if (!tab.canCloseWithoutPrompting(CloseReason.Window)) {
        return false;
      }
    }
    return true;
  }

  /**
   * 通过 ID 获取标签页索引
   * @param id 标签页 ID
   * @returns 索引或 null
   */
  idxById(id: TabId): number | null {
    for (let idx = 0; idx < this.tabs.length; idx++) {
      if (this.tabs[idx].tabId() === id) {
        return idx;
      }
    }
    return null;
  }

  /**
   * 移除标签页后修复活动标签页
   * @param active 之前的活动标签页
   */
  private fixupActiveTabAfterRemoval(active: Tab | null): void {
    const len = this.tabs.length;
    if (active) {
      for (let idx = 0; idx < this.tabs.length; idx++) {
        if (this.tabs[idx].tabId() === active.tabId()) {
          this.setActiveWithoutSaving(idx);
          return;
        }
      }
    }

    if (len > 0 && this.active >= len) {
      this.setActiveWithoutSaving(len - 1);
    } else {
      this.invalidate();
    }
  }

  /**
   * 通过索引移除标签页
   * @param idx 索引
   * @returns 被移除的标签页
   */
  removeByIdx(idx: number): Tab {
    this.invalidate();
    const active = this.getActive();
    return this.doRemoveIdx(idx, active);
  }

  /**
   * 通过 ID 移除标签页
   * @param id 标签页 ID
   */
  removeById(id: TabId): void {
    const active = this.getActive();
    const idx = this.idxById(id);
    if (idx !== null) {
      this.doRemoveIdx(idx, active);
    }
  }

  /**
   * 执行移除操作
   * @param idx 索引
   * @param active 当前活动标签页
   * @returns 被移除的标签页
   */
  private doRemoveIdx(idx: number, active: Tab | null): Tab {
    const removing = this.tabs[idx];
    if (active && removing && active.tabId() === removing.tabId()) {
      if (windowConfig.switchToLastActiveTabWhenClosingTab) {
        // 如果移除的是活动标签页，切换到上一个活动标签页
        const lastActiveIdx = this.getLastActiveIdx();
        if (lastActiveIdx !== null) {
          this.setActiveWithoutSaving(lastActiveIdx);
        }
      }
    }
    const tab = this.tabs.splice(idx, 1)[0];
    this.fixupActiveTabAfterRemoval(active);
    return tab;
  }

  /**
   * 获取当前活动标签页
   */
  getActive(): Tab | null {
    return this.getByIdx(this.active);
  }

  /**
   * 获取当前活动标签页索引
   */
  getActiveIdx(): number {
    return this.active;
  }

  /**
   * 保存当前活动标签页
   */
  saveLastActive(): void {
    const tab = this.getByIdx(this.active);
    this.lastActive = tab ? tab.tabId() : null;
  }

  /**
   * 获取上一个活动标签页索引
   */
  getLastActiveIdx(): number | null {
    if (this.lastActive !== null) {
      return this.idxById(this.lastActive);
    }
    return null;
  }

  /**
   * 保存当前活动标签页并设置新的活动标签页
   * @param idx 新的活动标签页索引
   */
  saveAndThenSetActive(idx: number): void {
    if (idx === this.getActiveIdx()) {
      return;
    }
    this.saveLastActive();
    this.setActiveWithoutSaving(idx);
  }

  /**
   * 设置活动标签页（不保存上一个）
   * @param idx 新的活动标签页索引
   */
  setActiveWithoutSaving(idx: number): void {
    if (idx >= this.tabs.length) {
      throw new Error(`Invalid tab index: ${idx}`);
    }
    if (this.active !== idx) {
      const currentTab = this.tabs[this.active];
      if (currentTab) {
        const pane = currentTab.getActivePane();
        if (pane) {
          pane.focusChanged(false);
        }
      }
    }
    this.active = idx;
    this.invalidate();
  }

  /**
   * 迭代所有标签页
   */
  iter(): Tab[] {
    return [...this.tabs];
  }

  /**
   * 获取所有标签页（只读）
   */
  getTabs(): readonly Tab[] {
    return this.tabs;
  }

  /**
   * 清理死亡的标签页
   * @param liveTabIds 存活的标签页 ID 列表
   */
  pruneDeadTabs(liveTabIds: TabId[]): void {
    let invalidated = false;

    // 第一遍：清理死亡的 pane 并收集死亡的 tab
    const dead: TabId[] = [];
    for (const tab of this.tabs) {
      if (tab.pruneDeadPanes()) {
        invalidated = true;
      }
      if (tab.isDead()) {
        dead.push(tab.tabId());
      }
    }

    // 移除死亡的 tab
    for (const tabId of dead) {
      console.log(`Window.pruneDeadTabs: tab_id ${tabId} is dead`);
      this.removeById(tabId);
      invalidated = true;
    }

    // 第二遍：移除不在存活列表中的 tab
    const deadFromLive: TabId[] = [];
    for (const tab of this.tabs) {
      if (!liveTabIds.includes(tab.tabId())) {
        deadFromLive.push(tab.tabId());
      }
    }
    for (const tabId of deadFromLive) {
      console.log(`Window.pruneDeadTabs: (live) tab_id ${tabId} is dead`);
      this.removeById(tabId);
    }

    if (invalidated) {
      this.invalidate();
    }
  }
}

/**
 * @file client.ts
 * @description 翻译自 WezTerm: wezterm-source/mux/src/client.rs
 * @source https://github.com/wez/wezterm
 * @license MIT
 *
 * 原始代码行数: 75
 * 翻译日期: 2026-01-01
 *
 * 功能说明:
 * - 定义客户端标识（ClientId）
 * - 定义客户端信息（ClientInfo）
 * - 追踪客户端连接状态
 *
 * 与原始代码的差异:
 * - Rust AtomicUsize → JavaScript 普通变量
 * - Rust lazy_static → JavaScript 模块级变量
 * - Rust chrono::DateTime → JavaScript Date
 * - Rust libc::getpid → process.pid
 * - Rust hostname::get → os.hostname()
 */

import * as os from 'os';
import type { PaneId } from './pane';

// 客户端 ID 计数器（替代 Rust 的 AtomicUsize）
let clientIdCounter = 0;

// 启动时间戳（替代 Rust 的 lazy_static EPOCH）
const EPOCH = Math.floor(Date.now() / 1000);

/**
 * 客户端标识
 *
 * 唯一标识一个客户端连接，包含主机名、用户名、进程 ID 等信息。
 */
export interface ClientId {
  /** 主机名 */
  hostname: string;
  /** 用户名 */
  username: string;
  /** 进程 ID */
  pid: number;
  /** 启动时间戳 */
  epoch: number;
  /** 客户端序号 */
  id: number;
  /** SSH Agent Socket 路径（可选） */
  sshAuthSock: string | null;
}

/**
 * 创建新的客户端标识
 * @param sshAuthSock SSH Agent Socket 路径（可选）
 * @returns 新的 ClientId
 */
export function createClientId(sshAuthSock: string | null = null): ClientId {
  const id = clientIdCounter++;
  return {
    hostname: os.hostname() || 'localhost',
    username: process.env.USER || process.env.USERNAME || 'somebody',
    pid: process.pid,
    epoch: EPOCH,
    id,
    sshAuthSock: sshAuthSock || process.env.SSH_AUTH_SOCK || null,
  };
}

/**
 * 客户端信息
 *
 * 包含客户端的连接状态、活跃工作区、最后输入时间等信息。
 */
export class ClientInfo {
  /** 客户端标识 */
  clientId: ClientId;
  /** 连接时间 */
  connectedAt: Date;
  /** 活跃工作区 */
  activeWorkspace: string | null;
  /** 最后输入时间 */
  lastInput: Date;
  /** 当前聚焦的 Pane ID */
  focusedPaneId: PaneId | null;

  constructor(clientId: ClientId) {
    this.clientId = clientId;
    this.connectedAt = new Date();
    this.activeWorkspace = null;
    this.lastInput = new Date();
    this.focusedPaneId = null;
  }

  /**
   * 更新最后输入时间
   */
  updateLastInput(): void {
    this.lastInput = new Date();
  }

  /**
   * 更新聚焦的 Pane
   * @param paneId Pane ID
   */
  updateFocusedPane(paneId: PaneId): void {
    this.focusedPaneId = paneId;
  }

  /**
   * 序列化为 JSON
   */
  toJSON(): object {
    return {
      clientId: this.clientId,
      connectedAt: Math.floor(this.connectedAt.getTime() / 1000),
      activeWorkspace: this.activeWorkspace,
      lastInput: Math.floor(this.lastInput.getTime() / 1000),
      focusedPaneId: this.focusedPaneId,
    };
  }

  /**
   * 从 JSON 反序列化
   * @param json JSON 对象
   * @returns ClientInfo 实例
   */
  static fromJSON(json: any): ClientInfo {
    const info = new ClientInfo(json.clientId);
    info.connectedAt = new Date(json.connectedAt * 1000);
    info.activeWorkspace = json.activeWorkspace;
    info.lastInput = new Date(json.lastInput * 1000);
    info.focusedPaneId = json.focusedPaneId;
    return info;
  }
}

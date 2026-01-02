/**
 * MuxServer 主服务类
 *
 * 独立运行的守护进程，管理所有终端会话
 * - 通过 IPC 与 WhatyTerm 客户端通信
 * - 支持多客户端连接
 * - 空闲超时自动退出
 */

import { IpcServer, ClientConnection, RequestHandler } from './ipc-server.js';
import { SessionRegistry, MuxSession } from './session-registry.js';
import {
  RequestMessage,
  RequestMethod,
  EventType,
  CreateSessionParams,
  AttachSessionParams,
  DetachSessionParams,
  WriteInputParams,
  ResizeParams,
  GetHistoryParams,
  KillSessionParams,
  GetSessionParams,
  createEvent,
  decodeBase64,
  encodeBase64,
} from './protocol.js';

// ============================================
// 配置
// ============================================

const IDLE_TIMEOUT = 30 * 60 * 1000; // 30 分钟空闲超时
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 分钟清理一次死亡会话

// ============================================
// MuxServer 主类
// ============================================

export class MuxServer {
  private ipcServer: IpcServer;
  private sessionRegistry: SessionRegistry;
  private startTime: Date;
  private idleTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.ipcServer = new IpcServer();
    this.sessionRegistry = new SessionRegistry();
    this.startTime = new Date();

    this._setupRequestHandlers();
    this._setupSessionEvents();
  }

  /**
   * 启动服务器
   */
  async start(): Promise<void> {
    console.log('[MuxServer] 启动中...');

    await this.ipcServer.start();

    // 启动空闲检测
    this._resetIdleTimer();

    // 启动定期清理
    this.cleanupTimer = setInterval(() => {
      this.sessionRegistry.cleanupDeadSessions();
    }, CLEANUP_INTERVAL);

    console.log('[MuxServer] 已启动');
  }

  /**
   * 停止服务器
   */
  async stop(): Promise<void> {
    console.log('[MuxServer] 停止中...');

    // 清理定时器
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    // 终止所有会话
    this.sessionRegistry.killAllSessions();

    // 停止 IPC 服务器
    await this.ipcServer.stop();

    console.log('[MuxServer] 已停止');
  }

  /**
   * 设置请求处理器
   */
  private _setupRequestHandlers(): void {
    // 创建会话
    this.ipcServer.onRequest(RequestMethod.CREATE_SESSION, this._handleCreateSession.bind(this));

    // 列出会话
    this.ipcServer.onRequest(RequestMethod.LIST_SESSIONS, this._handleListSessions.bind(this));

    // 获取会话
    this.ipcServer.onRequest(RequestMethod.GET_SESSION, this._handleGetSession.bind(this));

    // 终止会话
    this.ipcServer.onRequest(RequestMethod.KILL_SESSION, this._handleKillSession.bind(this));

    // 连接会话
    this.ipcServer.onRequest(RequestMethod.ATTACH_SESSION, this._handleAttachSession.bind(this));

    // 断开会话
    this.ipcServer.onRequest(RequestMethod.DETACH_SESSION, this._handleDetachSession.bind(this));

    // 写入输入
    this.ipcServer.onRequest(RequestMethod.WRITE_INPUT, this._handleWriteInput.bind(this));

    // 调整大小
    this.ipcServer.onRequest(RequestMethod.RESIZE, this._handleResize.bind(this));

    // 获取历史
    this.ipcServer.onRequest(RequestMethod.GET_HISTORY, this._handleGetHistory.bind(this));

    // 心跳
    this.ipcServer.onRequest(RequestMethod.PING, this._handlePing.bind(this));

    // 关闭服务器
    this.ipcServer.onRequest(RequestMethod.SHUTDOWN, this._handleShutdown.bind(this));
  }

  /**
   * 设置会话事件监听
   */
  private _setupSessionEvents(): void {
    // 会话输出
    this.sessionRegistry.on('session:output', (sessionId: string, data: string) => {
      this._resetIdleTimer();
      const event = createEvent(EventType.OUTPUT, sessionId, {
        data: encodeBase64(data),
      });
      this.ipcServer.broadcastToSession(sessionId, event);
    });

    // 会话响铃
    this.sessionRegistry.on('session:bell', (sessionId: string) => {
      const event = createEvent(EventType.BELL, sessionId);
      this.ipcServer.broadcastToSession(sessionId, event);
    });

    // 会话退出
    this.sessionRegistry.on('session:exit', (sessionId: string, exitCode: number) => {
      const event = createEvent(EventType.EXIT, sessionId, { exitCode });
      this.ipcServer.broadcastToSession(sessionId, event);
    });

    // 会话创建
    this.sessionRegistry.on('session:created', (sessionInfo: any) => {
      const event = createEvent(EventType.SESSION_CREATED, sessionInfo.id, { session: sessionInfo });
      this.ipcServer.broadcastToAll(event);
    });

    // 会话关闭
    this.sessionRegistry.on('session:closed', (sessionId: string, reason: string) => {
      const event = createEvent(EventType.SESSION_CLOSED, sessionId, { sessionId, reason });
      this.ipcServer.broadcastToAll(event);
    });
  }

  /**
   * 重置空闲定时器
   */
  private _resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }

    this.idleTimer = setTimeout(() => {
      // 检查是否有活跃会话
      if (this.sessionRegistry.getAliveSessionCount() === 0) {
        console.log('[MuxServer] 空闲超时，无活跃会话，退出');
        this.stop().then(() => {
          process.exit(0);
        });
      } else {
        // 有活跃会话，重置定时器
        console.log(`[MuxServer] 空闲超时检查：${this.sessionRegistry.getAliveSessionCount()} 个活跃会话，继续运行`);
        this._resetIdleTimer();
      }
    }, IDLE_TIMEOUT);
  }

  // ============================================
  // 请求处理器
  // ============================================

  private async _handleCreateSession(
    client: ClientConnection,
    request: RequestMessage
  ): Promise<{ success: boolean; result?: any; error?: string }> {
    try {
      const params = request.params as CreateSessionParams;
      const session = this.sessionRegistry.createSession(params);

      // 自动订阅创建者
      client.subscribeSession(session.id);

      return {
        success: true,
        result: { session: session.getInfo() },
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private async _handleListSessions(
    client: ClientConnection,
    request: RequestMessage
  ): Promise<{ success: boolean; result?: any; error?: string }> {
    const sessions = this.sessionRegistry.listSessions();
    return {
      success: true,
      result: { sessions },
    };
  }

  private async _handleGetSession(
    client: ClientConnection,
    request: RequestMessage
  ): Promise<{ success: boolean; result?: any; error?: string }> {
    const params = request.params as GetSessionParams;
    const session = this.sessionRegistry.getSession(params.sessionId);

    return {
      success: true,
      result: { session: session ? session.getInfo() : null },
    };
  }

  private async _handleKillSession(
    client: ClientConnection,
    request: RequestMessage
  ): Promise<{ success: boolean; result?: any; error?: string }> {
    const params = request.params as KillSessionParams;
    const success = this.sessionRegistry.killSession(params.sessionId);

    if (success) {
      return { success: true };
    } else {
      return { success: false, error: 'Session not found' };
    }
  }

  private async _handleAttachSession(
    client: ClientConnection,
    request: RequestMessage
  ): Promise<{ success: boolean; result?: any; error?: string }> {
    const params = request.params as AttachSessionParams;
    const session = this.sessionRegistry.getSession(params.sessionId);

    if (!session) {
      return { success: false, error: 'Session not found' };
    }

    // 订阅会话输出
    client.subscribeSession(params.sessionId);

    // 返回会话信息和历史输出
    return {
      success: true,
      result: {
        session: session.getInfo(),
        history: session.getHistoryBase64(),
      },
    };
  }

  private async _handleDetachSession(
    client: ClientConnection,
    request: RequestMessage
  ): Promise<{ success: boolean; result?: any; error?: string }> {
    const params = request.params as DetachSessionParams;

    // 取消订阅
    client.unsubscribeSession(params.sessionId);

    return { success: true };
  }

  private async _handleWriteInput(
    client: ClientConnection,
    request: RequestMessage
  ): Promise<{ success: boolean; result?: any; error?: string }> {
    const params = request.params as WriteInputParams;
    const session = this.sessionRegistry.getSession(params.sessionId);

    if (!session) {
      return { success: false, error: 'Session not found' };
    }

    if (!session.isAlive) {
      return { success: false, error: 'Session is not alive' };
    }

    // 解码 Base64 数据并写入
    const data = decodeBase64(params.data);
    session.write(data);

    this._resetIdleTimer();

    return { success: true };
  }

  private async _handleResize(
    client: ClientConnection,
    request: RequestMessage
  ): Promise<{ success: boolean; result?: any; error?: string }> {
    const params = request.params as ResizeParams;
    const session = this.sessionRegistry.getSession(params.sessionId);

    if (!session) {
      return { success: false, error: 'Session not found' };
    }

    session.resize(params.cols, params.rows);

    return { success: true };
  }

  private async _handleGetHistory(
    client: ClientConnection,
    request: RequestMessage
  ): Promise<{ success: boolean; result?: any; error?: string }> {
    const params = request.params as GetHistoryParams;
    const session = this.sessionRegistry.getSession(params.sessionId);

    if (!session) {
      return { success: false, error: 'Session not found' };
    }

    return {
      success: true,
      result: { history: session.getHistoryBase64() },
    };
  }

  private async _handlePing(
    client: ClientConnection,
    request: RequestMessage
  ): Promise<{ success: boolean; result?: any; error?: string }> {
    const uptime = Date.now() - this.startTime.getTime();

    return {
      success: true,
      result: {
        pong: true,
        uptime,
        sessionCount: this.sessionRegistry.getSessionCount(),
      },
    };
  }

  private async _handleShutdown(
    client: ClientConnection,
    request: RequestMessage
  ): Promise<{ success: boolean; result?: any; error?: string }> {
    console.log('[MuxServer] 收到关闭请求');

    // 延迟关闭，先发送响应
    setTimeout(() => {
      this.stop().then(() => {
        process.exit(0);
      });
    }, 100);

    return { success: true };
  }
}

// ============================================
// 入口点
// ============================================

// 检查是否作为独立进程运行
if (process.env.MUX_SERVER_MODE === '1' || require.main === module) {
  console.log('[MuxServer] 作为独立进程启动');

  const server = new MuxServer();

  // 处理进程信号
  process.on('SIGINT', async () => {
    console.log('[MuxServer] 收到 SIGINT');
    await server.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('[MuxServer] 收到 SIGTERM');
    await server.stop();
    process.exit(0);
  });

  // 处理未捕获的异常
  process.on('uncaughtException', (err) => {
    console.error('[MuxServer] 未捕获的异常:', err);
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[MuxServer] 未处理的 Promise 拒绝:', reason);
  });

  // 启动服务器
  server.start().catch((err) => {
    console.error('[MuxServer] 启动失败:', err);
    process.exit(1);
  });
}

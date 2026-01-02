/**
 * MuxServer IPC 服务端
 *
 * 使用命名管道（Windows）或 Unix Socket（Unix）进行进程间通信
 */

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import {
  getIpcPath,
  Message,
  MessageType,
  RequestMessage,
  ResponseMessage,
  EventMessage,
  parseMessage,
  serializeMessage,
  createResponse,
} from './protocol.js';

// ============================================
// 客户端连接类
// ============================================

export class ClientConnection extends EventEmitter {
  private socket: net.Socket;
  private buffer: Buffer = Buffer.alloc(0);
  private _id: string;
  private _subscribedSessions: Set<string> = new Set();

  constructor(socket: net.Socket) {
    super();
    this.socket = socket;
    this._id = `client-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;

    this.socket.on('data', (data) => this.handleData(data));
    this.socket.on('close', () => this.emit('close'));
    this.socket.on('error', (err) => this.emit('error', err));
  }

  get id(): string {
    return this._id;
  }

  get subscribedSessions(): Set<string> {
    return this._subscribedSessions;
  }

  /**
   * 订阅会话输出
   */
  subscribeSession(sessionId: string): void {
    this._subscribedSessions.add(sessionId);
  }

  /**
   * 取消订阅会话输出
   */
  unsubscribeSession(sessionId: string): void {
    this._subscribedSessions.delete(sessionId);
  }

  /**
   * 检查是否订阅了指定会话
   */
  isSubscribed(sessionId: string): boolean {
    return this._subscribedSessions.has(sessionId);
  }

  /**
   * 处理接收到的数据
   */
  private handleData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);

    // 尝试解析所有完整的消息
    while (true) {
      const result = parseMessage(this.buffer);
      if (!result) break;

      this.buffer = result.remaining;
      this.emit('message', result.message);
    }
  }

  /**
   * 发送消息
   */
  send(message: Message): void {
    if (this.socket.writable) {
      const buffer = serializeMessage(message);
      this.socket.write(buffer);
    }
  }

  /**
   * 发送响应
   */
  sendResponse(requestId: string, success: boolean, result?: any, error?: string): void {
    this.send(createResponse(requestId, success, result, error));
  }

  /**
   * 发送事件
   */
  sendEvent(event: EventMessage): void {
    this.send(event);
  }

  /**
   * 关闭连接
   */
  close(): void {
    this.socket.end();
  }

  /**
   * 销毁连接
   */
  destroy(): void {
    this.socket.destroy();
  }
}

// ============================================
// IPC 服务端类
// ============================================

export type RequestHandler = (
  client: ClientConnection,
  request: RequestMessage
) => Promise<{ success: boolean; result?: any; error?: string }>;

export class IpcServer extends EventEmitter {
  private server: net.Server | null = null;
  private clients: Map<string, ClientConnection> = new Map();
  private requestHandlers: Map<string, RequestHandler> = new Map();
  private ipcPath: string;

  constructor() {
    super();
    this.ipcPath = getIpcPath();
  }

  /**
   * 注册请求处理器
   */
  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  /**
   * 启动服务器
   */
  async start(): Promise<void> {
    // 清理旧的 socket 文件（Unix）
    if (process.platform !== 'win32') {
      const socketDir = path.dirname(this.ipcPath);
      if (!fs.existsSync(socketDir)) {
        fs.mkdirSync(socketDir, { recursive: true });
      }
      if (fs.existsSync(this.ipcPath)) {
        fs.unlinkSync(this.ipcPath);
      }
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this.handleConnection(socket));

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.error('[IpcServer] 地址已被占用，可能已有实例运行');
        }
        reject(err);
      });

      this.server.listen(this.ipcPath, () => {
        console.log(`[IpcServer] 监听: ${this.ipcPath}`);
        resolve();
      });
    });
  }

  /**
   * 停止服务器
   */
  async stop(): Promise<void> {
    // 关闭所有客户端连接
    for (const client of this.clients.values()) {
      client.destroy();
    }
    this.clients.clear();

    // 关闭服务器
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          console.log('[IpcServer] 服务器已关闭');
          // 清理 socket 文件（Unix）
          if (process.platform !== 'win32' && fs.existsSync(this.ipcPath)) {
            try {
              fs.unlinkSync(this.ipcPath);
            } catch {}
          }
          resolve();
        });
      });
    }
  }

  /**
   * 处理新连接
   */
  private handleConnection(socket: net.Socket): void {
    const client = new ClientConnection(socket);
    this.clients.set(client.id, client);

    console.log(`[IpcServer] 新连接: ${client.id}`);
    this.emit('client:connected', client);

    client.on('message', (message: Message) => {
      this.handleMessage(client, message);
    });

    client.on('close', () => {
      console.log(`[IpcServer] 连接关闭: ${client.id}`);
      this.clients.delete(client.id);
      this.emit('client:disconnected', client);
    });

    client.on('error', (err) => {
      console.error(`[IpcServer] 连接错误 ${client.id}:`, err.message);
    });
  }

  /**
   * 处理消息
   */
  private async handleMessage(client: ClientConnection, message: Message): Promise<void> {
    if (message.type === MessageType.REQUEST) {
      await this.handleRequest(client, message as RequestMessage);
    }
  }

  /**
   * 处理请求
   */
  private async handleRequest(client: ClientConnection, request: RequestMessage): Promise<void> {
    const handler = this.requestHandlers.get(request.method);

    if (!handler) {
      client.sendResponse(request.id, false, undefined, `Unknown method: ${request.method}`);
      return;
    }

    try {
      const result = await handler(client, request);
      client.sendResponse(request.id, result.success, result.result, result.error);
    } catch (err: any) {
      console.error(`[IpcServer] 处理请求失败 ${request.method}:`, err);
      client.sendResponse(request.id, false, undefined, err.message || 'Internal error');
    }
  }

  /**
   * 向所有订阅了指定会话的客户端广播事件
   */
  broadcastToSession(sessionId: string, event: EventMessage): void {
    for (const client of this.clients.values()) {
      if (client.isSubscribed(sessionId)) {
        client.sendEvent(event);
      }
    }
  }

  /**
   * 向所有客户端广播事件
   */
  broadcastToAll(event: EventMessage): void {
    for (const client of this.clients.values()) {
      client.sendEvent(event);
    }
  }

  /**
   * 获取连接的客户端数量
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * 获取所有客户端
   */
  getClients(): ClientConnection[] {
    return Array.from(this.clients.values());
  }
}

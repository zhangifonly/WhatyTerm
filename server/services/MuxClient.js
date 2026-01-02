/**
 * MuxClient - IPC 客户端
 *
 * 用于 WhatyTerm 连接到 mux-server 守护进程
 */

import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';

// IPC 端点
const isWindows = process.platform === 'win32';
function getIpcPath() {
  if (isWindows) {
    return '\\\\.\\pipe\\whatyterm-mux';
  } else {
    return path.join(os.homedir(), '.whatyterm', 'mux.sock');
  }
}

// 消息类型
const MessageType = {
  REQUEST: 'request',
  RESPONSE: 'response',
  EVENT: 'event',
};

// 请求方法
const RequestMethod = {
  CREATE_SESSION: 'create_session',
  LIST_SESSIONS: 'list_sessions',
  GET_SESSION: 'get_session',
  KILL_SESSION: 'kill_session',
  ATTACH_SESSION: 'attach_session',
  DETACH_SESSION: 'detach_session',
  WRITE_INPUT: 'write_input',
  RESIZE: 'resize',
  GET_HISTORY: 'get_history',
  PING: 'ping',
  SHUTDOWN: 'shutdown',
};

// 事件类型
const EventType = {
  OUTPUT: 'output',
  BELL: 'bell',
  EXIT: 'exit',
  SESSION_CREATED: 'session_created',
  SESSION_CLOSED: 'session_closed',
};

/**
 * 序列化消息
 */
function serializeMessage(message) {
  const json = JSON.stringify(message);
  const jsonBuffer = Buffer.from(json, 'utf8');
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32LE(jsonBuffer.length, 0);
  return Buffer.concat([lengthBuffer, jsonBuffer]);
}

/**
 * 解析消息
 */
function parseMessage(buffer) {
  if (buffer.length < 4) {
    return null;
  }

  const length = buffer.readUInt32LE(0);

  if (buffer.length < 4 + length) {
    return null;
  }

  const jsonBuffer = buffer.slice(4, 4 + length);
  const json = jsonBuffer.toString('utf8');

  try {
    const message = JSON.parse(json);
    return {
      message,
      remaining: buffer.slice(4 + length),
    };
  } catch (e) {
    throw new Error(`Failed to parse message: ${e}`);
  }
}

/**
 * 生成唯一 ID
 */
function generateId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Base64 编码
 */
function encodeBase64(data) {
  return Buffer.from(data, 'utf8').toString('base64');
}

/**
 * Base64 解码
 */
function decodeBase64(base64) {
  return Buffer.from(base64, 'base64').toString('utf8');
}

/**
 * MuxClient 类
 */
export class MuxClient extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pendingRequests = new Map();
    this.connected = false;
    this.reconnecting = false;
    this.ipcPath = getIpcPath();
  }

  /**
   * 连接到 mux-server
   */
  async connect() {
    if (this.connected) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.socket = net.createConnection(this.ipcPath, () => {
        console.log('[MuxClient] 已连接到 mux-server');
        this.connected = true;
        this.emit('connected');
        resolve();
      });

      this.socket.on('data', (data) => this._handleData(data));

      this.socket.on('close', () => {
        console.log('[MuxClient] 连接已关闭');
        this.connected = false;
        this._rejectAllPending('Connection closed');
        this.emit('disconnected');
      });

      this.socket.on('error', (err) => {
        console.error('[MuxClient] 连接错误:', err.message);
        if (!this.connected) {
          reject(err);
        }
        this.emit('error', err);
      });
    });
  }

  /**
   * 断开连接
   */
  disconnect() {
    if (this.socket) {
      this.socket.end();
      this.socket = null;
    }
    this.connected = false;
    this._rejectAllPending('Disconnected');
  }

  /**
   * 检查是否已连接
   */
  isConnected() {
    return this.connected;
  }

  /**
   * 发送请求并等待响应
   */
  async request(method, params = {}) {
    if (!this.connected) {
      throw new Error('Not connected to mux-server');
    }

    const id = generateId();
    const message = {
      type: MessageType.REQUEST,
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      // 设置超时
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, 30000);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      const buffer = serializeMessage(message);
      this.socket.write(buffer);
    });
  }

  /**
   * 处理接收到的数据
   */
  _handleData(data) {
    this.buffer = Buffer.concat([this.buffer, data]);

    while (true) {
      const result = parseMessage(this.buffer);
      if (!result) break;

      this.buffer = result.remaining;
      this._handleMessage(result.message);
    }
  }

  /**
   * 处理消息
   */
  _handleMessage(message) {
    if (message.type === MessageType.RESPONSE) {
      this._handleResponse(message);
    } else if (message.type === MessageType.EVENT) {
      this._handleEvent(message);
    }
  }

  /**
   * 处理响应
   */
  _handleResponse(response) {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      console.warn('[MuxClient] 收到未知响应:', response.id);
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(response.id);

    if (response.success) {
      pending.resolve(response.result);
    } else {
      pending.reject(new Error(response.error || 'Request failed'));
    }
  }

  /**
   * 处理事件
   */
  _handleEvent(event) {
    const { event: eventType, sessionId, data } = event;

    switch (eventType) {
      case EventType.OUTPUT:
        // 解码 Base64 输出
        const output = data?.data ? decodeBase64(data.data) : '';
        this.emit('output', sessionId, output);
        break;

      case EventType.BELL:
        this.emit('bell', sessionId);
        break;

      case EventType.EXIT:
        this.emit('exit', sessionId, data?.exitCode);
        break;

      case EventType.SESSION_CREATED:
        this.emit('session:created', data?.session);
        break;

      case EventType.SESSION_CLOSED:
        this.emit('session:closed', sessionId, data?.reason);
        break;

      default:
        console.warn('[MuxClient] 未知事件类型:', eventType);
    }
  }

  /**
   * 拒绝所有待处理的请求
   */
  _rejectAllPending(reason) {
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }

  // ============================================
  // 高级 API
  // ============================================

  /**
   * 创建会话
   */
  async createSession(options = {}) {
    const result = await this.request(RequestMethod.CREATE_SESSION, options);
    return result.session;
  }

  /**
   * 列出所有会话
   */
  async listSessions() {
    const result = await this.request(RequestMethod.LIST_SESSIONS);
    return result.sessions;
  }

  /**
   * 获取会话信息
   */
  async getSession(sessionId) {
    const result = await this.request(RequestMethod.GET_SESSION, { sessionId });
    return result.session;
  }

  /**
   * 终止会话
   */
  async killSession(sessionId) {
    await this.request(RequestMethod.KILL_SESSION, { sessionId });
  }

  /**
   * 连接到会话（开始接收输出）
   */
  async attachSession(sessionId) {
    const result = await this.request(RequestMethod.ATTACH_SESSION, { sessionId });
    return {
      session: result.session,
      history: result.history ? decodeBase64(result.history) : '',
    };
  }

  /**
   * 断开会话（停止接收输出）
   */
  async detachSession(sessionId) {
    await this.request(RequestMethod.DETACH_SESSION, { sessionId });
  }

  /**
   * 写入数据到会话
   */
  async writeInput(sessionId, data) {
    await this.request(RequestMethod.WRITE_INPUT, {
      sessionId,
      data: encodeBase64(data),
    });
  }

  /**
   * 调整会话终端大小
   */
  async resize(sessionId, cols, rows) {
    await this.request(RequestMethod.RESIZE, { sessionId, cols, rows });
  }

  /**
   * 获取会话输出历史
   */
  async getHistory(sessionId) {
    const result = await this.request(RequestMethod.GET_HISTORY, { sessionId });
    return result.history ? decodeBase64(result.history) : '';
  }

  /**
   * 心跳检测
   */
  async ping() {
    const result = await this.request(RequestMethod.PING);
    return result;
  }

  /**
   * 关闭服务器
   */
  async shutdown() {
    await this.request(RequestMethod.SHUTDOWN);
  }
}

// 单例实例
let clientInstance = null;

/**
 * 获取 MuxClient 单例
 */
export function getMuxClient() {
  if (!clientInstance) {
    clientInstance = new MuxClient();
  }
  return clientInstance;
}

/**
 * 检查 mux-server 是否可用
 */
export async function isMuxServerAvailable() {
  const client = new MuxClient();
  try {
    await client.connect();
    await client.ping();
    client.disconnect();
    return true;
  } catch (err) {
    return false;
  }
}

export default MuxClient;

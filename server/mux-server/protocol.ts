/**
 * MuxServer IPC 协议定义
 *
 * 消息格式: [4字节长度(LE)][JSON消息体]
 */

import * as os from 'os';
import * as path from 'path';

// ============================================
// IPC 端点
// ============================================

const isWindows = process.platform === 'win32';

export function getIpcPath(): string {
  if (isWindows) {
    return '\\\\.\\pipe\\whatyterm-mux';
  } else {
    return path.join(os.homedir(), '.whatyterm', 'mux.sock');
  }
}

// ============================================
// 消息类型
// ============================================

export enum MessageType {
  // 请求类型
  REQUEST = 'request',
  // 响应类型
  RESPONSE = 'response',
  // 事件类型（服务端推送）
  EVENT = 'event',
}

export enum RequestMethod {
  // 会话管理
  CREATE_SESSION = 'create_session',
  LIST_SESSIONS = 'list_sessions',
  GET_SESSION = 'get_session',
  KILL_SESSION = 'kill_session',

  // 会话操作
  ATTACH_SESSION = 'attach_session',
  DETACH_SESSION = 'detach_session',
  WRITE_INPUT = 'write_input',
  RESIZE = 'resize',
  GET_HISTORY = 'get_history',

  // 服务管理
  PING = 'ping',
  SHUTDOWN = 'shutdown',
}

export enum EventType {
  // 终端事件
  OUTPUT = 'output',
  BELL = 'bell',
  EXIT = 'exit',

  // 会话事件
  SESSION_CREATED = 'session_created',
  SESSION_CLOSED = 'session_closed',
}

// ============================================
// 消息接口
// ============================================

export interface BaseMessage {
  type: MessageType;
  id?: string; // 请求/响应的关联 ID
}

export interface RequestMessage extends BaseMessage {
  type: MessageType.REQUEST;
  id: string;
  method: RequestMethod;
  params?: any;
}

export interface ResponseMessage extends BaseMessage {
  type: MessageType.RESPONSE;
  id: string;
  success: boolean;
  result?: any;
  error?: string;
}

export interface EventMessage extends BaseMessage {
  type: MessageType.EVENT;
  event: EventType;
  sessionId?: string;
  data?: any;
}

export type Message = RequestMessage | ResponseMessage | EventMessage;

// ============================================
// 请求参数接口
// ============================================

export interface CreateSessionParams {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  shell?: string;
  shellArgs?: string[];
  env?: Record<string, string>;
}

export interface AttachSessionParams {
  sessionId: string;
}

export interface DetachSessionParams {
  sessionId: string;
}

export interface WriteInputParams {
  sessionId: string;
  data: string; // Base64 编码的数据
}

export interface ResizeParams {
  sessionId: string;
  cols: number;
  rows: number;
}

export interface GetHistoryParams {
  sessionId: string;
}

export interface KillSessionParams {
  sessionId: string;
}

export interface GetSessionParams {
  sessionId: string;
}

// ============================================
// 响应结果接口
// ============================================

export interface SessionInfo {
  id: string;
  name: string;
  createdAt: string;
  cols: number;
  rows: number;
  cwd?: string;
  isAlive: boolean;
}

export interface CreateSessionResult {
  session: SessionInfo;
}

export interface ListSessionsResult {
  sessions: SessionInfo[];
}

export interface GetSessionResult {
  session: SessionInfo | null;
}

export interface GetHistoryResult {
  history: string; // Base64 编码的历史输出
}

export interface PingResult {
  pong: true;
  uptime: number;
  sessionCount: number;
}

// ============================================
// 事件数据接口
// ============================================

export interface OutputEventData {
  data: string; // Base64 编码的输出数据
}

export interface ExitEventData {
  exitCode: number;
}

export interface SessionCreatedEventData {
  session: SessionInfo;
}

export interface SessionClosedEventData {
  sessionId: string;
  reason: string;
}

// ============================================
// 消息序列化/反序列化
// ============================================

/**
 * 将消息序列化为 Buffer
 * 格式: [4字节长度(LE)][JSON消息体]
 */
export function serializeMessage(message: Message): Buffer {
  const json = JSON.stringify(message);
  const jsonBuffer = Buffer.from(json, 'utf8');
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32LE(jsonBuffer.length, 0);
  return Buffer.concat([lengthBuffer, jsonBuffer]);
}

/**
 * 从 Buffer 解析消息
 * 返回解析的消息和剩余的 Buffer，如果数据不完整返回 null
 */
export function parseMessage(buffer: Buffer): { message: Message; remaining: Buffer } | null {
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
    const message = JSON.parse(json) as Message;
    return {
      message,
      remaining: buffer.slice(4 + length),
    };
  } catch (e) {
    throw new Error(`Failed to parse message: ${e}`);
  }
}

/**
 * 创建请求消息
 */
export function createRequest(method: RequestMethod, params?: any): RequestMessage {
  return {
    type: MessageType.REQUEST,
    id: generateId(),
    method,
    params,
  };
}

/**
 * 创建响应消息
 */
export function createResponse(requestId: string, success: boolean, result?: any, error?: string): ResponseMessage {
  return {
    type: MessageType.RESPONSE,
    id: requestId,
    success,
    result,
    error,
  };
}

/**
 * 创建事件消息
 */
export function createEvent(event: EventType, sessionId?: string, data?: any): EventMessage {
  return {
    type: MessageType.EVENT,
    event,
    sessionId,
    data,
  };
}

/**
 * 生成唯一 ID
 */
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// ============================================
// 辅助函数
// ============================================

/**
 * 将字符串编码为 Base64
 */
export function encodeBase64(data: string): string {
  return Buffer.from(data, 'utf8').toString('base64');
}

/**
 * 将 Base64 解码为字符串
 */
export function decodeBase64(base64: string): string {
  return Buffer.from(base64, 'base64').toString('utf8');
}

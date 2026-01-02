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
export function getIpcPath() {
    if (isWindows) {
        return '\\\\.\\pipe\\whatyterm-mux';
    }
    else {
        return path.join(os.homedir(), '.whatyterm', 'mux.sock');
    }
}
// ============================================
// 消息类型
// ============================================
export var MessageType;
(function (MessageType) {
    // 请求类型
    MessageType["REQUEST"] = "request";
    // 响应类型
    MessageType["RESPONSE"] = "response";
    // 事件类型（服务端推送）
    MessageType["EVENT"] = "event";
})(MessageType || (MessageType = {}));
export var RequestMethod;
(function (RequestMethod) {
    // 会话管理
    RequestMethod["CREATE_SESSION"] = "create_session";
    RequestMethod["LIST_SESSIONS"] = "list_sessions";
    RequestMethod["GET_SESSION"] = "get_session";
    RequestMethod["KILL_SESSION"] = "kill_session";
    // 会话操作
    RequestMethod["ATTACH_SESSION"] = "attach_session";
    RequestMethod["DETACH_SESSION"] = "detach_session";
    RequestMethod["WRITE_INPUT"] = "write_input";
    RequestMethod["RESIZE"] = "resize";
    RequestMethod["GET_HISTORY"] = "get_history";
    // 服务管理
    RequestMethod["PING"] = "ping";
    RequestMethod["SHUTDOWN"] = "shutdown";
})(RequestMethod || (RequestMethod = {}));
export var EventType;
(function (EventType) {
    // 终端事件
    EventType["OUTPUT"] = "output";
    EventType["BELL"] = "bell";
    EventType["EXIT"] = "exit";
    // 会话事件
    EventType["SESSION_CREATED"] = "session_created";
    EventType["SESSION_CLOSED"] = "session_closed";
})(EventType || (EventType = {}));
// ============================================
// 消息序列化/反序列化
// ============================================
/**
 * 将消息序列化为 Buffer
 * 格式: [4字节长度(LE)][JSON消息体]
 */
export function serializeMessage(message) {
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
export function parseMessage(buffer) {
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
    }
    catch (e) {
        throw new Error(`Failed to parse message: ${e}`);
    }
}
/**
 * 创建请求消息
 */
export function createRequest(method, params) {
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
export function createResponse(requestId, success, result, error) {
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
export function createEvent(event, sessionId, data) {
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
function generateId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
// ============================================
// 辅助函数
// ============================================
/**
 * 将字符串编码为 Base64
 */
export function encodeBase64(data) {
    return Buffer.from(data, 'utf8').toString('base64');
}
/**
 * 将 Base64 解码为字符串
 */
export function decodeBase64(base64) {
    return Buffer.from(base64, 'base64').toString('utf8');
}

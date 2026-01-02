/**
 * 输出缓冲管理
 *
 * 环形缓冲区实现，用于存储会话的终端输出历史
 * 限制大小为 100KB，超出时丢弃最旧的数据
 */
// 默认缓冲区大小：100KB
const DEFAULT_MAX_SIZE = 100 * 1024;
export class OutputBuffer {
    constructor(maxSize = DEFAULT_MAX_SIZE) {
        this.writePos = 0;
        this.totalWritten = 0;
        this.maxSize = maxSize;
        this.buffer = Buffer.alloc(maxSize);
    }
    /**
     * 追加数据到缓冲区
     */
    append(data) {
        const chunk = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
        if (chunk.length === 0) {
            return;
        }
        // 如果数据大于缓冲区，只保留最后 maxSize 字节
        if (chunk.length >= this.maxSize) {
            chunk.copy(this.buffer, 0, chunk.length - this.maxSize);
            this.writePos = 0;
            this.totalWritten = this.maxSize;
            return;
        }
        // 计算可以写入的位置
        const spaceAtEnd = this.maxSize - this.writePos;
        if (chunk.length <= spaceAtEnd) {
            // 可以直接写入
            chunk.copy(this.buffer, this.writePos);
            this.writePos += chunk.length;
            if (this.writePos >= this.maxSize) {
                this.writePos = 0;
            }
        }
        else {
            // 需要分两部分写入（环绕）
            chunk.copy(this.buffer, this.writePos, 0, spaceAtEnd);
            chunk.copy(this.buffer, 0, spaceAtEnd);
            this.writePos = chunk.length - spaceAtEnd;
        }
        this.totalWritten += chunk.length;
    }
    /**
     * 获取缓冲区中的所有数据
     * 返回按时间顺序排列的数据
     */
    getHistory() {
        const usedSize = Math.min(this.totalWritten, this.maxSize);
        if (usedSize === 0) {
            return Buffer.alloc(0);
        }
        // 如果还没有环绕，直接返回已写入的部分
        if (this.totalWritten <= this.maxSize) {
            return Buffer.from(this.buffer.slice(0, this.writePos));
        }
        // 已经环绕，需要重新排列
        // writePos 指向最旧数据的位置（下一个要被覆盖的位置）
        const result = Buffer.alloc(this.maxSize);
        const oldDataSize = this.maxSize - this.writePos;
        // 先复制旧数据（从 writePos 到末尾）
        this.buffer.copy(result, 0, this.writePos, this.maxSize);
        // 再复制新数据（从开头到 writePos）
        this.buffer.copy(result, oldDataSize, 0, this.writePos);
        return result;
    }
    /**
     * 获取缓冲区中的数据（Base64 编码）
     */
    getHistoryBase64() {
        return this.getHistory().toString('base64');
    }
    /**
     * 获取当前缓冲区使用大小
     */
    getSize() {
        return Math.min(this.totalWritten, this.maxSize);
    }
    /**
     * 获取最大缓冲区大小
     */
    getMaxSize() {
        return this.maxSize;
    }
    /**
     * 清空缓冲区
     */
    clear() {
        this.buffer.fill(0);
        this.writePos = 0;
        this.totalWritten = 0;
    }
    /**
     * 检查缓冲区是否为空
     */
    isEmpty() {
        return this.totalWritten === 0;
    }
    /**
     * 获取最近 N 字节的数据
     */
    getRecent(bytes) {
        const history = this.getHistory();
        if (bytes >= history.length) {
            return history;
        }
        return history.slice(history.length - bytes);
    }
    /**
     * 获取最近 N 行的数据
     */
    getRecentLines(lines) {
        const history = this.getHistory().toString('utf8');
        const allLines = history.split('\n');
        return allLines.slice(-lines).join('\n');
    }
}
/**
 * 输出缓冲管理器
 * 管理多个会话的输出缓冲
 */
export class OutputBufferManager {
    constructor(maxSize = DEFAULT_MAX_SIZE) {
        this.buffers = new Map();
        this.maxSize = maxSize;
    }
    /**
     * 获取或创建会话的输出缓冲
     */
    getBuffer(sessionId) {
        let buffer = this.buffers.get(sessionId);
        if (!buffer) {
            buffer = new OutputBuffer(this.maxSize);
            this.buffers.set(sessionId, buffer);
        }
        return buffer;
    }
    /**
     * 追加数据到会话缓冲
     */
    append(sessionId, data) {
        this.getBuffer(sessionId).append(data);
    }
    /**
     * 获取会话的输出历史
     */
    getHistory(sessionId) {
        const buffer = this.buffers.get(sessionId);
        return buffer ? buffer.getHistory() : Buffer.alloc(0);
    }
    /**
     * 获取会话的输出历史（Base64 编码）
     */
    getHistoryBase64(sessionId) {
        const buffer = this.buffers.get(sessionId);
        return buffer ? buffer.getHistoryBase64() : '';
    }
    /**
     * 删除会话的缓冲
     */
    deleteBuffer(sessionId) {
        return this.buffers.delete(sessionId);
    }
    /**
     * 清空会话的缓冲
     */
    clearBuffer(sessionId) {
        const buffer = this.buffers.get(sessionId);
        if (buffer) {
            buffer.clear();
        }
    }
    /**
     * 获取所有会话 ID
     */
    getSessionIds() {
        return Array.from(this.buffers.keys());
    }
    /**
     * 获取缓冲区数量
     */
    getBufferCount() {
        return this.buffers.size;
    }
    /**
     * 获取总内存使用量
     */
    getTotalMemoryUsage() {
        let total = 0;
        for (const buffer of this.buffers.values()) {
            total += buffer.getSize();
        }
        return total;
    }
}

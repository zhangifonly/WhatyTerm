/**
 * 会话注册表
 *
 * 管理所有 Mux 会话的生命周期
 * - 创建/销毁会话
 * - 跟踪每个会话的订阅者（多客户端支持）
 * - 管理输出缓冲
 */
import * as pty from 'node-pty';
import { EventEmitter } from 'events';
import { OutputBuffer } from './output-buffer.js';
export class MuxSession extends EventEmitter {
    constructor(options) {
        super();
        this.ptyProcess = null;
        this._isAlive = false;
        this.id = options.id;
        this.name = options.name;
        this.createdAt = new Date();
        this._cols = options.cols || 80;
        this._rows = options.rows || 24;
        this._cwd = options.cwd || process.env.USERPROFILE || process.env.HOME || '.';
        this.outputBuffer = new OutputBuffer();
        this._startPty(options);
    }
    _startPty(options) {
        // 确定 shell
        let shell;
        let shellArgs;
        if (options.shell) {
            shell = options.shell;
            shellArgs = options.shellArgs || [];
        }
        else if (process.platform === 'win32') {
            // Windows: 使用 PowerShell
            shell = process.env.SystemRoot
                ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
                : 'powershell.exe';
            shellArgs = ['-NoLogo'];
        }
        else {
            // Unix: 使用默认 shell
            shell = process.env.SHELL || '/bin/bash';
            shellArgs = [];
        }
        // 合并环境变量
        const env = {
            ...process.env,
            TERM: 'xterm-256color',
            ...options.env,
        };
        try {
            this.ptyProcess = pty.spawn(shell, shellArgs, {
                name: 'xterm-256color',
                cols: this._cols,
                rows: this._rows,
                cwd: this._cwd,
                env: env,
            });
            this._isAlive = true;
            // 监听输出
            this.ptyProcess.onData((data) => {
                // 存储到缓冲区
                this.outputBuffer.append(data);
                // 发出输出事件
                this.emit('output', data);
                // 检测 bell 字符
                if (data.includes('\x07')) {
                    this.emit('bell');
                }
            });
            // 监听退出
            this.ptyProcess.onExit(({ exitCode }) => {
                console.log(`[MuxSession] 会话 ${this.id} 退出，exitCode=${exitCode}`);
                this._isAlive = false;
                this.ptyProcess = null;
                this.emit('exit', exitCode);
            });
            console.log(`[MuxSession] 会话 ${this.id} 已创建，shell=${shell}`);
        }
        catch (err) {
            console.error(`[MuxSession] 创建 PTY 失败:`, err.message);
            this._isAlive = false;
            throw err;
        }
    }
    /**
     * 写入数据到终端
     */
    write(data) {
        if (this.ptyProcess && this._isAlive) {
            this.ptyProcess.write(data);
        }
    }
    /**
     * 调整终端大小
     */
    resize(cols, rows) {
        this._cols = cols;
        this._rows = rows;
        if (this.ptyProcess && this._isAlive) {
            this.ptyProcess.resize(cols, rows);
        }
    }
    /**
     * 获取输出历史
     */
    getHistory() {
        return this.outputBuffer.getHistory();
    }
    /**
     * 获取输出历史（Base64 编码）
     */
    getHistoryBase64() {
        return this.outputBuffer.getHistoryBase64();
    }
    /**
     * 获取最近 N 行输出
     */
    getRecentLines(lines) {
        return this.outputBuffer.getRecentLines(lines);
    }
    /**
     * 终止会话
     */
    kill() {
        if (this.ptyProcess && this._isAlive) {
            try {
                this.ptyProcess.kill();
            }
            catch (err) {
                console.error(`[MuxSession] 终止会话 ${this.id} 失败:`, err.message);
            }
        }
        this._isAlive = false;
        this.ptyProcess = null;
    }
    /**
     * 获取会话信息
     */
    getInfo() {
        return {
            id: this.id,
            name: this.name,
            createdAt: this.createdAt.toISOString(),
            cols: this._cols,
            rows: this._rows,
            cwd: this._cwd,
            isAlive: this._isAlive,
        };
    }
    get cols() {
        return this._cols;
    }
    get rows() {
        return this._rows;
    }
    get cwd() {
        return this._cwd;
    }
    get isAlive() {
        return this._isAlive;
    }
}
// ============================================
// 会话注册表
// ============================================
export class SessionRegistry extends EventEmitter {
    constructor() {
        super(...arguments);
        this.sessions = new Map();
        this.sessionCounter = 0;
    }
    /**
     * 创建新会话
     */
    createSession(params) {
        const id = this._generateSessionId();
        const name = params.name || `session-${this.sessionCounter}`;
        const session = new MuxSession({
            id,
            name,
            cols: params.cols,
            rows: params.rows,
            cwd: params.cwd,
            shell: params.shell,
            shellArgs: params.shellArgs,
            env: params.env,
        });
        // 监听会话事件
        session.on('output', (data) => {
            this.emit('session:output', id, data);
        });
        session.on('bell', () => {
            this.emit('session:bell', id);
        });
        session.on('exit', (exitCode) => {
            this.emit('session:exit', id, exitCode);
            // 不自动删除会话，保留历史记录
        });
        this.sessions.set(id, session);
        this.emit('session:created', session.getInfo());
        console.log(`[SessionRegistry] 创建会话: ${id} (${name})`);
        return session;
    }
    /**
     * 获取会话
     */
    getSession(id) {
        return this.sessions.get(id);
    }
    /**
     * 列出所有会话
     */
    listSessions() {
        return Array.from(this.sessions.values()).map(s => s.getInfo());
    }
    /**
     * 终止会话
     */
    killSession(id) {
        const session = this.sessions.get(id);
        if (!session) {
            return false;
        }
        session.kill();
        this.sessions.delete(id);
        this.emit('session:closed', id, 'killed');
        console.log(`[SessionRegistry] 终止会话: ${id}`);
        return true;
    }
    /**
     * 获取会话数量
     */
    getSessionCount() {
        return this.sessions.size;
    }
    /**
     * 获取活跃会话数量
     */
    getAliveSessionCount() {
        let count = 0;
        for (const session of this.sessions.values()) {
            if (session.isAlive) {
                count++;
            }
        }
        return count;
    }
    /**
     * 清理已退出的会话
     */
    cleanupDeadSessions() {
        let cleaned = 0;
        for (const [id, session] of this.sessions.entries()) {
            if (!session.isAlive) {
                this.sessions.delete(id);
                this.emit('session:closed', id, 'cleanup');
                cleaned++;
            }
        }
        if (cleaned > 0) {
            console.log(`[SessionRegistry] 清理了 ${cleaned} 个已退出的会话`);
        }
        return cleaned;
    }
    /**
     * 终止所有会话
     */
    killAllSessions() {
        for (const session of this.sessions.values()) {
            session.kill();
        }
        this.sessions.clear();
        console.log('[SessionRegistry] 已终止所有会话');
    }
    /**
     * 生成会话 ID
     */
    _generateSessionId() {
        this.sessionCounter++;
        return `mux-${Date.now()}-${this.sessionCounter}`;
    }
}

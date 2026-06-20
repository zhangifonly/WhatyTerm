/**
 * RalphEngine - 自主软件工厂引擎（移植自 Ralph）
 *
 * 在可观看的 tmux 会话内，用 headless CLI 逐个执行任务队列：
 *   取任务 → Developer 执行 → Validator 逐条验收 → 失败退回重试/满5次blocked → 全部完成归档
 *
 * 复用 WebTmux 的会话/CLI 抽象，支持全部 6 种 CLI。结果用文件重定向 + DONE 标记捕获。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import progressManager from './ProgressManager.js';
import { DEVELOPER_PROMPT, VALIDATOR_PROMPT } from './ralph/prompts.js';

// 超时配置（毫秒）
const FIRST_TOKEN_TIMEOUT = 300 * 1000; // 大 prompt 经中转首字可能较慢，给 5 分钟
const IDLE_TIMEOUT = 180 * 1000;        // 输出中途静默容忍 3 分钟
const TOTAL_TIMEOUT = 30 * 60 * 1000;
const MAX_RETRY = 5;

// 生成短唯一标记（用于临时文件名 + DONE 标记）
let _uidCounter = 0;
function task_uid() {
  _uidCounter = (_uidCounter + 1) % 100000;
  return `${Date.now().toString(36)}${_uidCounter.toString(36)}`;
}

// headless CLI 命令模板
function headlessCmd(aiType, outFile) {
  switch (aiType) {
    case 'codex':
      return `codex exec --dangerously-bypass-approvals-and-sandbox`;
    case 'grok':
      return `grok -p --always-approve`;
    case 'gemini':
      return `gemini --yolo -p`;
    default: // claude / droid / opencode 走 claude 风格
      return `claude --print --dangerously-skip-permissions`;
  }
}

class RalphEngine {
  constructor(sessionManager, io) {
    this.sessionManager = sessionManager;
    this.io = io;
    this.running = new Map();   // sessionId -> { stop: boolean, phase, iteration }
    this.tmpDir = path.join(os.tmpdir(), 'webtmux-ralph');
    try { fs.mkdirSync(this.tmpDir, { recursive: true }); } catch {}
  }

  isRunning(sessionId) {
    return this.running.has(sessionId);
  }

  stop(sessionId) {
    const state = this.running.get(sessionId);
    if (state) state.stop = true;
  }

  _emit(sessionId, event, data) {
    if (this.io) this.io.emit(event, { sessionId, ...data });
  }

  _log(sessionId, msg) {
    console.log(`[RalphEngine] ${sessionId.slice(0, 8)}: ${msg}`);
    this._emit(sessionId, 'ralph:log', { line: msg, ts: Date.now() });
  }

  /** 启动自主循环（不阻塞调用方）
   * @param {object} options { maxIterations, branch, pauseAfterEachTask }
   */
  async start(sessionId, options = {}) {
    // 兼容旧签名 start(sessionId, maxIterations)
    if (typeof options === 'number') options = { maxIterations: options };
    const maxIterations = options.maxIterations || 100;
    const branch = options.branch || '';
    const pauseAfterEachTask = !!options.pauseAfterEachTask;

    if (this.running.has(sessionId)) {
      this._log(sessionId, '已在运行中，忽略重复启动');
      return;
    }
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      this._log(sessionId, '会话不存在，无法启动');
      return;
    }
    const state = { stop: false, paused: false, phase: 'idle', iteration: 0, pauseAfterEachTask };
    this.running.set(sessionId, state);
    progressManager.setMode(sessionId, 'autonomous');
    this._emit(sessionId, 'ralph:state', { running: true, phase: 'idle' });
    this._log(sessionId, `自主模式启动 (CLI: ${session.aiType || 'claude'}, 最大迭代: ${maxIterations})`);

    try {
      // 护栏2：自动切换到专属分支（隔离改动）
      if (branch) {
        await this._ensureBranch(sessionId, session, branch);
        if (state.stop) return;
      }
      await this._loop(sessionId, session, state, maxIterations);
    } catch (err) {
      this._log(sessionId, `循环异常终止: ${err.message}`);
    } finally {
      this.running.delete(sessionId);
      this._emit(sessionId, 'ralph:state', { running: false, phase: 'stopped' });
    }
  }

  /** 暂停后恢复执行 */
  resume(sessionId) {
    const state = this.running.get(sessionId);
    if (state && state.paused) {
      state.paused = false;
      this._log(sessionId, '收到继续指令，恢复执行');
      this._emit(sessionId, 'ralph:state', { running: true, phase: state.phase });
    }
  }

  /** 在会话内切换/创建专属分支 */
  async _ensureBranch(sessionId, session, branch) {
    this._log(sessionId, `切换到专属分支: ${branch}`);
    const safe = branch.replace(/[^a-zA-Z0-9/_.-]/g, '-');
    // 已存在则切换，不存在则创建
    const cmd = `git checkout ${this._sh(safe)} 2>/dev/null || git checkout -b ${this._sh(safe)}`;
    await this._execShell(sessionId, session, cmd, '建分支', 30 * 1000);
  }

  /** 主循环：逐个任务 Developer → Validator */
  async _loop(sessionId, session, state, maxIterations) {
    for (let i = 1; i <= maxIterations; i++) {
      if (state.stop) { this._log(sessionId, '收到停止指令，退出循环'); return; }
      state.iteration = i;

      const task = progressManager.getNextTask(sessionId);
      if (!task) {
        this._log(sessionId, '没有可执行任务，全部完成或被阻塞');
        this._emit(sessionId, 'ralph:state', { running: false, phase: 'done' });
        return;
      }

      // ── Developer 阶段 ──
      this._setPhase(sessionId, state, 'developing', task);
      progressManager.updateFeatureStatus(sessionId, task.id, { status: 'in_progress' });
      this._log(sessionId, `迭代 ${i}/${maxIterations} - 开发任务: ${task.name}`);
      const devOk = await this._runDeveloper(sessionId, session, task);
      if (state.stop) return;
      if (!devOk) {
        this._log(sessionId, `任务 ${task.id} 开发阶段超时/失败，稍后重试`);
        progressManager.updateFeatureStatus(sessionId, task.id, { status: 'pending' });
        await this._sleep(2000);
        continue;
      }

      // ── Validator 阶段 ──
      this._setPhase(sessionId, state, 'validating', task);
      this._log(sessionId, `迭代 ${i} - 验证任务: ${task.name}`);
      const verdict = await this._runValidator(sessionId, session, task);
      if (state.stop) return;

      if (verdict.passed) {
        progressManager.updateFeatureStatus(sessionId, task.id, {
          status: 'completed',
          passes: { implemented: true, compiles: true, tested: true }
        });
        this._log(sessionId, `✓ 任务 ${task.id} 验证通过`);
      } else {
        const r = progressManager.recordValidationFailure(sessionId, task.id, verdict.notes, MAX_RETRY);
        if (r?.blocked) {
          this._log(sessionId, `✗ 任务 ${task.id} 已达最大重试(${MAX_RETRY})，标记 blocked 跳过`);
        } else {
          this._log(sessionId, `✗ 任务 ${task.id} 验证失败 (第${r?.retryCount}次)，退回重试: ${verdict.notes}`);
        }
      }

      this._setPhase(sessionId, state, 'idle', null);
      if (!progressManager.hasRunnableTask(sessionId)) {
        this._log(sessionId, '所有任务已解决（完成或阻塞），结束');
        this._emit(sessionId, 'ralph:state', { running: false, phase: 'done' });
        return;
      }

      // 护栏3：每任务完成后可暂停，等用户 review 再继续
      if (state.pauseAfterEachTask) {
        state.paused = true;
        this._setPhase(sessionId, state, 'paused', null);
        this._emit(sessionId, 'ralph:paused', { iteration: i });
        this._log(sessionId, '任务完成，已暂停（点继续执行下一个）');
        while (state.paused && !state.stop) {
          await this._sleep(500);
        }
        if (state.stop) { this._log(sessionId, '暂停中收到停止'); return; }
      }
      await this._sleep(1000);
    }
    this._log(sessionId, `已达最大迭代次数 ${maxIterations}`);
  }

  _setPhase(sessionId, state, phase, task) {
    state.phase = phase;
    this._emit(sessionId, 'ralph:state', {
      running: true, phase, iteration: state.iteration,
      currentTask: task ? { id: task.id, name: task.name } : null
    });
  }

  /** 构建任务上下文（项目 CLAUDE.md + patterns + 任务详情） */
  _buildTaskContext(sessionId, session, task) {
    const parts = [];
    const claudeMd = path.join(session.workingDir || '', 'CLAUDE.md');
    try {
      if (session.workingDir && fs.existsSync(claudeMd)) {
        parts.push(`# 项目上下文（CLAUDE.md）\n${fs.readFileSync(claudeMd, 'utf-8').substring(0, 4000)}`);
      }
    } catch {}
    const progress = progressManager.loadProgress(sessionId);
    if (progress?.patterns?.length) {
      parts.push(`# Codebase Patterns（复用经验）\n- ${progress.patterns.join('\n- ')}`);
    }
    const ac = (task.acceptanceCriteria || []).map(c => `- ${c}`).join('\n') || '- （未指定，按需求合理判断）';
    parts.push(
      `# 当前任务 [${task.id}] ${task.name}\n` +
      `优先级: ${task.priority}  分支: ${task.branch || '(当前分支)'}\n\n` +
      `## 需求与技术设计\n${task.description}\n\n## 验收标准\n${ac}`
    );
    return parts.join('\n\n---\n\n');
  }

  /** Developer 阶段：执行实现 */
  async _runDeveloper(sessionId, session, task) {
    const ctx = this._buildTaskContext(sessionId, session, task);
    const prompt = `${ctx}\n\n---\n\n${DEVELOPER_PROMPT}\n\n立即开始执行当前任务，不要询问确认。`;
    const out = await this._execHeadless(sessionId, session, prompt, '开发', TOTAL_TIMEOUT);
    if (out === null) return false;
    // 抓取 PATTERN: 学习并记录
    const m = out.match(/PATTERN:\s*(.+)/i);
    if (m) progressManager.addPattern(sessionId, m[1].trim().slice(0, 200));
    return true;
  }

  /** Validator 阶段：逐条验收，解析 VALIDATION: PASS/FAIL */
  async _runValidator(sessionId, session, task) {
    const ctx = this._buildTaskContext(sessionId, session, task);
    const prompt = `${ctx}\n\n---\n\n${VALIDATOR_PROMPT}\n\n立即开始验证，不要询问确认。`;
    const out = await this._execHeadless(sessionId, session, prompt, '验证', TOTAL_TIMEOUT * 2);
    if (out === null) return { passed: false, notes: '验证阶段超时或无输出' };
    if (/VALIDATION:\s*PASS/i.test(out)) return { passed: true, notes: '' };
    const fail = out.match(/VALIDATION:\s*FAIL\s*-?\s*(.+)/i);
    if (fail) return { passed: false, notes: fail[1].trim().slice(0, 300) };
    // 没有明确标记：保守判失败，记录原因
    return { passed: false, notes: '未输出明确验证结论（缺少 VALIDATION 标记）' };
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /**
   * 在会话 tmux 内执行一次 headless CLI 调用。
   * 机制：prompt 写临时文件，stdout/err 重定向到输出文件，命令尾部 echo DONE 标记。
   * 引擎轮询输出文件大小（检测活跃）+ DONE 标记（检测完成），三层超时兜底。
   * 返回输出文本，超时/失败返回 null。
   */
  async _execHeadless(sessionId, session, prompt, label, totalTimeout) {
    const aiType = session.aiType || 'claude';
    const tag = `${task_uid()}`;
    const promptFile = path.join(this.tmpDir, `prompt-${tag}.txt`);
    const outFile = path.join(this.tmpDir, `out-${tag}.txt`);
    const doneMarker = `__RALPH_DONE_${tag}__`;

    try {
      fs.writeFileSync(promptFile, prompt, 'utf-8');
    } catch (e) {
      this._log(sessionId, `${label}: 写入 prompt 文件失败 ${e.message}`);
      return null;
    }

    const cli = headlessCmd(aiType, outFile);
    // prompt 经 stdin 传入；CLI 输出重定向到 outFile；完成后把 DONE 标记+rc 追加到 outFile 末尾。
    // 用文件末尾的标记检测完成（而非屏幕），彻底避免命令回显里的 marker 造成误判。
    const shellCmd = `cat ${this._sh(promptFile)} | ${cli} > ${this._sh(outFile)} 2>&1; echo "${doneMarker} rc=$?" >> ${this._sh(outFile)}`;
    this._log(sessionId, `${label}: 启动 headless ${aiType}`);

    // 通过会话写入命令（用户可在 tmux 里观看）
    try {
      session.write(shellCmd + '\r');
    } catch (e) {
      this._log(sessionId, `${label}: 写入命令失败 ${e.message}`);
      return null;
    }

    const start = Date.now();
    let lastSize = 0;
    let lastEmitLen = 0; // 已推送给前端的字符数（实时输出流）
    let lastChangeAt = Date.now();
    let gotFirst = false;

    while (true) {
      const st = this.running.get(sessionId);
      if (st?.stop) { this._killInSession(session); return null; }

      // 检测完成：读输出文件末尾的 DONE 标记（CLI 完成后由 shell 追加到文件）
      // 不从屏幕检测，避免命令回显里的 marker 造成误判
      const rawOut = this._readOut(outFile);
      const doneMatch = rawOut.match(new RegExp(doneMarker + '\\s+rc=(\\d+)'));
      if (doneMatch) {
        const rc = doneMatch[1];
        // 去掉结果末尾的 DONE 标记行
        const result = rawOut.replace(new RegExp('\\n?' + doneMarker + '\\s+rc=\\d+\\s*$'), '');
        this._cleanup(promptFile, outFile);
        this._log(sessionId, `${label}: 完成 (rc=${rc}, ${Math.round((Date.now() - start) / 1000)}s)`);
        if (rc !== '0') {
          this._log(sessionId, `${label}: 进程返回非零退出码 rc=${rc}`);
          return null;
        }
        return result;
      }

      // 检测输出文件增长（活跃度）+ 实时推送新增输出（让前端看到 CLI 正在产出什么）
      let size = 0;
      try { size = fs.existsSync(outFile) ? fs.statSync(outFile).size : 0; } catch {}
      if (size > lastSize) {
        lastSize = size; lastChangeAt = Date.now(); gotFirst = true;
        // 新增文本：去掉 DONE 标记行、空行，限长，取最近若干行推送
        const fresh = rawOut.slice(lastEmitLen);
        lastEmitLen = rawOut.length;
        const lines = fresh.split('\n')
          .map(s => s.replace(/\s+$/, ''))
          .filter(s => s && !s.includes(doneMarker))
          .map(s => s.slice(0, 500));
        this._emit(sessionId, 'ralph:progress', {
          label, bytes: size, elapsedMs: Date.now() - start,
          lines: lines.slice(-20)
        });
      }

      const now = Date.now();
      const idle = now - lastChangeAt;
      if (now - start > totalTimeout) {
        this._log(sessionId, `${label}: 总时长超时 (${Math.round((now - start) / 1000)}s)`);
        this._killInSession(session); this._cleanup(promptFile, outFile); return null;
      }
      if (!gotFirst && idle > FIRST_TOKEN_TIMEOUT) {
        this._log(sessionId, `${label}: 首字响应超时`);
        this._killInSession(session); this._cleanup(promptFile, outFile); return null;
      }
      if (gotFirst && idle > IDLE_TIMEOUT) {
        this._log(sessionId, `${label}: 持续无输出超时`);
        this._killInSession(session); this._cleanup(promptFile, outFile); return null;
      }
      await this._sleep(1000);
    }
  }

  _readOut(outFile) {
    try { return fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf-8') : ''; }
    catch { return ''; }
  }

  _cleanup(...files) {
    for (const f of files) { try { fs.unlinkSync(f); } catch {} }
  }

  /** 中断会话内正在跑的 headless 进程（发 Ctrl+C） */
  _killInSession(session) {
    try { session.write('\x03'); } catch {}
  }

  /** shell 路径转义（路径在 tmpDir，无空格也兜底加引号） */
  _sh(p) { return `'${String(p).replace(/'/g, "'\\''")}'`; }

  /** 在会话内执行一条普通 shell 命令（如 git），用 DONE 标记+输出文件检测完成 */
  async _execShell(sessionId, session, cmd, label, timeout = 30000) {
    const tag = task_uid();
    const outFile = path.join(this.tmpDir, `sh-${tag}.txt`);
    const doneMarker = `__RALPH_DONE_${tag}__`;
    const shellCmd = `{ ${cmd} ; } > ${this._sh(outFile)} 2>&1; echo "${doneMarker} rc=$?" >> ${this._sh(outFile)}`;
    try { session.write(shellCmd + '\r'); } catch (e) {
      this._log(sessionId, `${label}: 写入命令失败 ${e.message}`);
      return null;
    }
    const start = Date.now();
    while (true) {
      const st = this.running.get(sessionId);
      if (st?.stop) return null;
      const raw = this._readOut(outFile);
      const m = raw.match(new RegExp(doneMarker + '\\s+rc=(\\d+)'));
      if (m) {
        this._cleanup(outFile);
        this._log(sessionId, `${label}: 完成 (rc=${m[1]})`);
        return m[1] === '0' ? raw.replace(new RegExp('\\n?' + doneMarker + '\\s+rc=\\d+\\s*$'), '') : null;
      }
      if (Date.now() - start > timeout) {
        this._log(sessionId, `${label}: 超时`);
        this._cleanup(outFile);
        return null;
      }
      await this._sleep(500);
    }
  }
}

export default RalphEngine;

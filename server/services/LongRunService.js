/**
 * 长程编排：服务层
 *
 * 把五个模块（Prompts / Sandbox / Runner / Supervisor / Loop）组装成可被 socket
 * 调用的运行实例，并管理它们的生命周期。
 *
 * 凭据从 **CC Switch** 取（经 AIEngine），不引入编排器原来的 .env 机制 ——
 * 项目规矩是禁止硬编码 Key。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { loadPrompts, loadRequirement, renderRefsSection, extraDirsOf } from './LongRunPrompts.js';
import { LongRunSandbox, sandboxRoots, assertSandboxed } from './LongRunSandbox.js';
import { LongRunRunner } from './LongRunRunner.js';
import { Supervisor, loadSystemPrompt } from './LongRunSupervisor.js';
import { LongRunLoop, Stop, HANDOFF_FLOOR, HANDOFF_CEILING, HARD_KILL } from './LongRunLoop.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_FILE = path.join(HERE, '..', 'prompts', 'longrun', '提示词.txt');
/**
 * 面板粘贴的需求文本落盘处。网页拿不到本机文件的绝对路径，所以粘贴的文本要先
 * 变成文件再走原流程（编排器全程只认文档路径）。**不放沙箱根里**：沙箱名可能撞上。
 */
/** 每个任务在内存里留多少条事件供回放。一轮实测过程事件与对话约 30:1，给宽 */
export const EVENT_BUFFER = 1000;

export const REQUIREMENT_DIR = path.join(os.homedir(), '.webtmux', 'longrun-requirements');

/** 从需求正文取名：首个 Markdown 标题，其次首个非空行。 */
export function deriveName(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const head = lines.find((l) => /^#{1,3}\s+\S/.test(l)) || lines[0] || '';
  return head.replace(/^#+\s*/, '').replace(/[^\w\u4e00-\u9fa5-]/g, '-')
    .replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'longrun';
}

/**
 * 一次运行的实例。
 * 事件既推给 socket 房间，也落盘到 <沙箱>/.run/orchestrator.jsonl。
 */
class LongRunTask {
  constructor({ id, sandbox, loop, requirement, io }) {
    this.id = id;
    this.sandbox = sandbox;
    this.loop = loop;
    this.requirement = requirement;
    this.io = io;
    this.startedAt = Date.now();
    this.state = 'running';      // running | done | failed
    this.report = null;
    /** 最近的运行态快照，供 longrun:status 查询 */
    this.snapshot = { legs: 0, handoffs: 0, costUsd: 0, contextPeak: 0, occupied: 0, lastLabel: '' };
    /**
     * 事件自增序号。前端折叠状态必须按它做键 —— 用数组下标的话，条目被挤出缓冲时
     * 下标整体错位，展开状态会跳到别的条目上（原编排器看板踩过）。
     */
    this.seq = 0;
    /** 最近事件的环形缓冲，刷新页面后 longrun:subscribe 靠它回放 */
    this.events = [];
  }

  get room() { return `longrun:${this.id}`; }

  /** 人工回答的等待队列（needs_human 时用） */
  _humanWaiter = null;

  answerHuman(text) {
    if (!this._humanWaiter) return false;
    const resolve = this._humanWaiter;
    this._humanWaiter = null;
    resolve(String(text || ''));
    return true;
  }

  toJSON() {
    return {
      id: this.id,
      sandboxRoot: this.sandbox.root,
      state: this.state,
      startedAt: this.startedAt,
      requirementSource: this.requirement?.source || '',
      thresholds: {
        handoffFloor: this.loop.handoffFloor,
        handoffCeiling: this.loop.handoffCeiling,
        hardKill: this.loop.hardKill,
      },
      totalBudgetUsd: this.loop.totalBudgetUsd,
      ...this.snapshot,
      report: this.report,
      // 人工干预入口（文件约定，看板保持只读）
      injectPath: this.loop.injectPath,
      pausePath: this.loop.pausePath,
      paused: existsSync(this.loop.pausePath),
      awaitingHuman: !!this._humanWaiter,
    };
  }
}

export class LongRunService {
  /**
   * @param {object} o
   * @param {object} o.io        socket.io 实例（推事件用）
   * @param {object} o.aiEngine  取凭据 + 调 LLM（监督者走它，从而走 CC Switch）
   */
  constructor({ io, aiEngine } = {}) {
    this.io = io;
    this.aiEngine = aiEngine;
    /** id → LongRunTask */
    this.tasks = new Map();
  }

  /**
   * 监督者的 LLM 调用。走 AIEngine → CC Switch 凭据 + Claude Relay 伪装头。
   *
   * ⚠ 这是我们与原编排器的**唯一实现差异**：它从 .env 读 SUPERVISOR_API_KEY，
   *   我们禁止硬编码 Key，一律从 CC Switch 取。行为等价，凭据来源不同。
   */
  _makeComplete(providerId = null) {
    const engine = this.aiEngine;
    if (!engine) return null;
    return async (systemPrompt, userText) => {
      const config = providerId
        ? engine.resolveSessionSettings('claude', providerId)
        : engine.getSettings()?.claude;
      if (!config?.apiUrl || !config?.apiKey) {
        throw new Error('监督者供应商未配置：请在 CC Switch 里选一个 Claude 供应商');
      }
      // 把 system 与 user 拼给现成的调用口。它内部处理伪装头、模型降级、结构化输出。
      const r = await engine._callClaudeApi(
        `${systemPrompt}\n\n---\n\n${userText}`, config, {});
      return {
        text: r?.text || '',
        inputTokens: r?.usage?.input_tokens || 0,
        outputTokens: r?.usage?.output_tokens || 0,
        stopReason: r?.stopReason || r?.stop_reason || 'end_turn',
      };
    };
  }

  /**
   * 预检：解析需求文档，给出沙箱建议与外部参考清单。**不启动任何进程。**
   * 对应编排器的 --plan-only。
   */
  /**
   * 粘贴的文本 → 文件路径。按内容哈希命名，**幂等**：plan 与 start 各调一次
   * 只会落同一个文件，不会攒出两份。
   */
  resolveDocPath({ docPath, requirementText }) {
    if (docPath) return docPath;
    const text = String(requirementText || '').trim();
    if (!text) throw new Error('需求为空：请粘贴需求文本，或填写本机需求文档的绝对路径');
    const hash = createHash('sha256').update(text).digest('hex').slice(0, 12);
    const file = path.join(REQUIREMENT_DIR, `${deriveName(text)}-${hash}.md`);
    mkdirSync(REQUIREMENT_DIR, { recursive: true });
    if (!existsSync(file)) writeFileSync(file, text + '\n', 'utf8');
    return file;
  }

  plan({ docPath: rawDoc, requirementText, sandboxName }) {
    const docPath = this.resolveDocPath({ docPath: rawDoc, requirementText });
    const prompts = loadPrompts(PROMPT_FILE);          // 缺段就在这里硬失败
    const req = loadRequirement(docPath, null);         // spec=null：只解析不登记
    const baseName = requirementText && !rawDoc
      ? deriveName(requirementText) : path.basename(docPath);
    const name = sandboxName || baseName.replace(/\.[^.]+$/, '')
      .replace(/[^\w一-龥-]/g, '-').slice(0, 40) || 'longrun';
    return {
      docPath,
      sandboxName: name,
      sandboxRoot: path.join(sandboxRoots()[0], name),
      requirementChars: req.text.length,
      refs: req.refs.map((r) => ({ path: r.path, isDir: r.isDir })),
      urls: req.urls,
      rejected: req.rejected,
      extraDirs: extraDirsOf(req),
      promptSlots: Object.keys(prompts).filter((k) => k !== 'source'),
      // ⚠ --add-dir 给的是**读写**权限。启动时要让用户看见这一点
      writableWarning: extraDirsOf(req).length
        ? `这 ${extraDirsOf(req).length} 个外部目录对执行者是**可写**的（--add-dir 非只读）`
        : '',
    };
  }

  /**
   * 启动一次长程运行。
   * @returns {object} 任务快照（异步跑，通过 socket 房间推事件）
   */
  start({ docPath: rawDoc, requirementText, sandboxName, providerId = null, thresholds = {}, totalBudgetUsd,
          maxLegs = 0, skipInit = false, costCeiling = 0 } = {}) {
    const prompts = loadPrompts(PROMPT_FILE);
    const docPath = this.resolveDocPath({ docPath: rawDoc, requirementText });
    const plan = this.plan({ docPath, sandboxName });
    const sandbox = LongRunSandbox.create(plan.sandboxName);
    // 需求文档要在沙箱建好之后再解析一次：这次带 spec，外部参考才会被登记 + 校验
    const req = loadRequirement(docPath, sandbox);
    sandbox.verifyClean();                            // 运行前复核

    // 发给执行者的正文 = 需求原文 + 参考清单（与编排器一致）
    const fullRequirement = req.text + (req.refs.length || req.urls.length
      ? '\n\n' + renderRefsSection(req) : '');

    const complete = this._makeComplete(providerId);
    const supervisor = complete
      ? new Supervisor({ complete, systemPrompt: loadSystemPrompt().text, maxTokens: 4000 })
      : null;

    const id = `${plan.sandboxName}-${Date.now().toString(36)}`;
    const task = new LongRunTask({ id, sandbox, loop: null, requirement: req, io: this.io });

    const loop = new LongRunLoop({
      sandbox, prompts, requirementText: fullRequirement, supervisor,
      handoffFloor: thresholds.handoffFloor ?? HANDOFF_FLOOR,
      handoffCeiling: thresholds.handoffCeiling ?? HANDOFF_CEILING,
      hardKill: thresholds.hardKill ?? HARD_KILL,
      totalBudgetUsd, maxLegs, skipInit, costCeiling,
      makeRunner: (killAt) => new LongRunRunner({
        cwd: sandbox.root,
        env: sandbox.childEnv(),                      // 已清掉监督者凭据与记忆变量
        eventsPath: path.join(sandbox.runDir, 'orchestrator.jsonl'),
        contextLimit: killAt || 0,
        costCeiling,
        extraDirs: sandbox.extraDirs,
        wallTimeout: 7200,
        checkInject: () => loop.takeInject(),
        // 执行层事件加 exec. 前缀：runner 与 loop 都有 send，不区分前端会一发显示两条
        emit: (k, d) => this._push(task, `exec.${k}`, d),
      }),
      // 不再推 need_human.waiting：loop.askHumanFor 调这里之前已带着原因推过一次。
      // Promise 执行器同步运行，waiter 在同一 tick 挂好，不存在答复先到的竞态。
      askHuman: () => new Promise((resolve) => { task._humanWaiter = resolve; }),
      emit: (k, d) => this._push(task, k, d),
    });
    task.loop = loop;
    this.tasks.set(id, task);

    // 异步跑，不阻塞 socket 回调
    loop.run().then((report) => {
      task.report = report;
      task.state = report.stop === Stop.PROJECT_DONE ? 'done' : 'failed';
      // finished 事件 loop.run 已推过；这里只补一条状态，供面板切换徽标
      this._push(task, 'state', { state: task.state, stop: report.stop });
    }).catch((e) => {
      task.state = 'failed';
      task.report = { stop: Stop.ERROR, needsFromHuman: e.message };
      this._push(task, 'error', { message: e.message });
    });

    return task.toJSON();
  }

  /** 把事件推给 socket 房间，并顺带更新快照。 */
  _push(task, kind, data) {
    if (kind === 'result') {
      task.snapshot.legs = data.leg ?? task.snapshot.legs;
      task.snapshot.costUsd = Math.round((task.loop?.spentUsd || 0) * 1e4) / 1e4;
      task.snapshot.contextPeak = Math.max(task.snapshot.contextPeak, data.contextPeak || 0);
      task.snapshot.lastLabel = data.label || '';
    } else if (kind === 'handoff.done') {
      task.snapshot.handoffs = data.count ?? task.snapshot.handoffs;
    } else if (kind === 'exec.context') {
      task.snapshot.contextPeak = Math.max(task.snapshot.contextPeak, data.peak || 0);
      task.snapshot.occupied = data.occupied || 0;
    } else if (kind === 'exec.send') {
      task.snapshot.occupied = 0;                    // 新的一发，水位从头算
    }
    task.seq += 1;
    // ⚠ kind 放在展开之后：data 里若也带 kind 字段会把事件类型覆盖掉
    const ev = { ...data, taskId: task.id, seq: task.seq, ts: Date.now(), kind };
    task.events.push(ev);
    if (task.events.length > EVENT_BUFFER) task.events.splice(0, task.events.length - EVENT_BUFFER);
    this.io?.to(task.room).emit('longrun:event', ev);
  }

  /** 某任务最近的事件（刷新页面后回放用）。 */
  history(taskId) {
    return this.tasks.get(taskId)?.events.slice() || [];
  }

  status(taskId) {
    if (taskId) return this.tasks.get(taskId)?.toJSON() || null;
    return [...this.tasks.values()].map((t) => t.toJSON());
  }

  /**
   * 人工注入。写文件而非直接调 —— 与编排器的文件约定一致，
   * 这样从终端/编辑器投件与从面板投件走同一条路。
   */
  inject(taskId, text, immediate = false) {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: '任务不存在' };
    const file = immediate ? task.loop.injectNowPath : task.loop.injectPath;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, String(text || ''), 'utf8');
    return { ok: true, path: file, immediate };
  }

  /** 暂停/继续：建或删 .run/pause 空文件。 */
  pause(taskId, on = true) {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: '任务不存在' };
    const f = task.loop.pausePath;
    if (on) {
      mkdirSync(path.dirname(f), { recursive: true });
      writeFileSync(f, '', 'utf8');
    } else if (existsSync(f)) {
      try { unlinkSync(f); } catch {}
    }
    return { ok: true, paused: on };
  }

  /**
   * 优雅停止：先立即打断当前这发，再挂上暂停闸。
   *
   * ⚠ 顺序要紧：反过来先建 pause 的话，当前这发会照常跑完（暂停闸在派发口，
   *   不在运行中），而那可能还有一两个小时。
   */
  stop(taskId, reason = '用户请求停止') {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: '任务不存在' };
    this.inject(taskId, `!!${reason}`, true);
    this.pause(taskId, true);
    return { ok: true, note: '已打断当前发次并挂上暂停闸；删掉 pause 会继续，不是终止' };
  }
}

/**
 * 长程编排：服务层
 *
 * 把 Launch（入口语义）/ Sandbox / Supervisor / Loop 组装成可被 socket 调用的运行实例，
 * 并管理生命周期。对应原版 start.py + resume.py + cli_common.build_loop；看板换成 WebTmux 面板。
 *
 * 凭据从 **CC Switch** 取（经 AIEngine），不引入原版的 SUPERVISOR_* 环境变量 ——
 * 项目规矩是禁止硬编码 Key。这是与原版唯一的凭据来源差异。
 */

import { existsSync, writeFileSync, mkdirSync, unlinkSync, statSync } from 'fs';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { loadPrompts, loadRequirement, extraDirsOf, PROMPT_SLOTS } from './LongRunPrompts.js';
import { LongRunSandbox } from './LongRunSandbox.js';
import { Supervisor, loadSystemPrompt } from './LongRunSupervisor.js';
import { SupervisorCredentials } from './LongRunSupervisorCreds.js';
import { LongRunLoop, Stop, assertThresholds, HANDOFF_FLOOR, HANDOFF_CEILING, HARD_KILL,
  MAINTENANCE_EVERY, TOTAL_BUDGET_USD, MAX_LEGS } from './LongRunLoop.js';
import { TASK_WAIT } from './LongRunRunner.js';
import { LongRunBoard } from './LongRunBoard.js';
import { replay as replayRun, EVENTS_FILE } from './LongRunReplay.js';
import { apiSessions, apiSession } from './LongRunTranscript.js';
import {
  LaunchError, deriveSandboxName, memoryFiles, priorState, checkRejectedRefs, requirementInput,
  previewRequirement, resolveProjectRoot, projectDirState, prepareProject, listLongRunProjects,
} from './LongRunLaunch.js';
import {
  SelfCheck, reportPrompts, reportClaudeTemplate, reportJobguard, reportInject, reportPriorState,
  reportRequirement, reportSupervisor,
} from './LongRunSelfCheck.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROMPT_FILE = path.join(HERE, '..', 'prompts', 'longrun', '提示词.txt');


/**
 * 「停下」时发给执行者的默认打断语（与面板的安全措辞模板一致）。
 * ⚠ 暂停不是终止：之后发的是「继续完成项目」。写成"停下别干了"会留在会话历史里与继续指令矛盾，
 *   还可能被执行者当结论写进记忆库，那条记忆比这次暂停活得久得多。
 */
export const STOP_REASON = '先停一下，把当前在做的这一步收个尾、记下进度。我看完就让你接着做，不要写"任务终止"之类的结论。';

/**
 * 面板粘贴的需求文本落盘处。网页拿不到本机文件的绝对路径，粘贴的文本要先变成文件再走原流程
 * （编排器全程只认文档路径）。**不放沙箱根里**：沙箱名可能撞上。
 */
/**
 * 这些事件会改变左侧列表上看得见的东西（徽标、发次、费用），发生时向**所有**客户端广播任务摘要。
 * 列表要显示每个任务是否在等你，而只有打开的那个任务才入了房间收全量事件。
 */
const LIST_KINDS = new Set(['selfcheck', 'send', 'result', 'handoff.done', 'supervisor.decided', 'need_human',
  'need_human.done', 'paused', 'resumed', 'finished', 'state', 'error']);

const MODE_TEXT = { start: '新建', takeover: '接管已有项目', resume: '续跑' };

export const REQUIREMENT_DIR = path.join(os.homedir(), '.webtmux', 'longrun-requirements');

/** 粘贴需求的名字：首个 Markdown 标题，其次首个非空行；再按 start.py 规则清洗成沙箱名。 */
export function deriveName(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const head = (lines.find((l) => /^#{1,3}\s+\S/.test(l)) || lines[0] || '').replace(/^#+\s*/, '');
  return deriveSandboxName(`${head}.md`);
}

/**
 * 一次运行的实例。事件落盘由 loop 负责（.run/orchestrator.jsonl）；这里维护看板状态并推 socket。
 * 刷新页面时 longrun:subscribe 拿看板快照（时间线/过程明细/编排日志都在里面），之后收增量。
 */
class LongRunTask {
  constructor({ id, mode, sandbox, docPath, requirementText, requirementDoc, options, selfCheck, supervisorInfo }) {
    Object.assign(this, { id, mode, sandbox, docPath, requirementText, options, selfCheck, supervisorInfo });
    // 与原版 start_web 一致：标题是文档名，需求卡片显示需求文档原文（不是拼了参考资料/续跑包装的那份）
    this.board = new LongRunBoard({ title: path.basename(docPath), requirement: requirementDoc, sandbox: sandbox.root });
    this.loop = null;
    this.startedAt = Date.now();
    this.state = 'running';      // running | done | failed
    this.report = null;
    this.snapshot = { legs: 0, handoffs: 0, maintenances: 0, decisions: 0, costUsd: 0,
      contextPeak: 0, occupied: 0, lastLabel: '' };
    /** 推送序号：前端据此丢弃订阅快照之前的重复增量 */
    this.seq = 0;
    /** 等人回答的挂起点（need_human 时由 loop 经 humanChannel 挂上） */
    this._humanWaiter = null;
  }

  get room() { return `longrun:${this.id}`; }

  toJSON() {
    const loop = this.loop;
    return {
      id: this.id,
      sessionId: this.sessionId || null,
      mode: this.mode,
      sandboxName: path.basename(this.sandbox.root),
      sandboxRoot: this.sandbox.root,
      docPath: this.docPath,
      requirementChars: this.requirementText.length,
      state: this.state,
      startedAt: this.startedAt,
      options: this.options,
      thresholds: { handoffFloor: loop.handoffFloor, handoffCeiling: loop.handoffCeiling, hardKill: loop.hardKill },
      totalBudgetUsd: loop.totalBudgetUsd,
      maxLegs: loop.maxLegs,
      supervisor: this.supervisorInfo,
      selfCheck: this.selfCheck,
      ...this.snapshot,
      report: this.report,
      injectPath: loop.injectPath,
      injectNowPath: loop.injectNowPath,
      pausePath: loop.pausePath,
      // 两个状态分开：闸已挂上（pause 文件在）≠ 真停在派发口（当前这发会照常跑完）
      pauseArmed: existsSync(loop.pausePath),
      halted: !!loop.halted,
      awaitingHuman: !!this._humanWaiter,
      aborted: loop.aborted || '',
    };
  }
}

/** 数值参数：缺省取默认，给了就必须合法（原版 argparse 按类型拒绝）。 */
function num(v, def, name, { min = 0, int = false } = {}) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || (int && !Number.isInteger(n))) {
    throw new LaunchError(`${name} 必须是 ≥ ${min} 的${int ? '整数' : '数'}，收到 ${JSON.stringify(v)}`);
  }
  return n;
}

/**
 * 启动参数（对应原版 start.py / resume.py 的全部命令行参数；--web/--port 由面板取代）。
 * 返回规整后的副本，也原样挂在任务快照上供面板复述"这次是按什么参数跑的"。
 */
export function normalizeOptions(o = {}) {
  const mode = ['resume', 'takeover'].includes(o.mode) ? o.mode : 'start';
  const out = {
    mode,
    sandboxName: o.sandboxName ? String(o.sandboxName).trim() : '',
    fresh: mode === 'start' && !!o.fresh,
    model: o.model ? String(o.model).trim() : '',
    promptsFile: o.promptsFile ? String(o.promptsFile).trim() : '',
    supervisorPrompt: o.supervisorPrompt ? String(o.supervisorPrompt).trim() : '',
    totalBudgetUsd: num(o.totalBudgetUsd, TOTAL_BUDGET_USD, '总预算'),
    maxLegs: num(o.maxLegs, MAX_LEGS, '调用次数上限', { min: 1, int: true }),
    handoffFloor: num(o.handoffFloor, HANDOFF_FLOOR, '交接下限', { min: 1, int: true }),
    handoffCeiling: num(o.handoffCeiling, HANDOFF_CEILING, '主动打断线', { min: 1, int: true }),
    hardKill: num(o.hardKill, HARD_KILL, '硬上限', { min: 1, int: true }),
    maintenanceEvery: num(o.maintenanceEvery, MAINTENANCE_EVERY, '记忆维护间隔', { int: true }),
    taskWait: num(o.taskWait, TASK_WAIT, '后台任务等待上限'),
    noAsk: !!o.noAsk,
    noSupervisor: !!o.noSupervisor,
    allowMissingRefs: !!o.allowMissingRefs,
    providerId: o.providerId || null,
  };
  try { assertThresholds(out); } catch (e) { throw new LaunchError(e.message); }
  return out;
}

export class LongRunService {
  /**
   * @param {object} o
   * @param {object} o.io        socket.io 实例（推事件用）
   * @param {object} o.aiEngine  取 CC Switch 凭据 + 调监督者 LLM
   * @param {function} [o.runnerFactory]  执行者工厂（仅测试注入；缺省起真 claude 进程）
   * @param {() => string[]} [o.providerPriority]  借用供应商时的名称优先级，与 AI 监控共用
   * @param {object} [o.sessionBinder]  会话条目绑定（index.js 注入）：
   *   bind(root, {projectName}) → Promise<sessionId>  找/建该目录的会话条目并切到长程模式；claude 正在跑则抛错
   *   get(sessionId) → 会话摘要（含 workingDir、runMode）或 null
   */
  constructor({ io, aiEngine, runnerFactory = null, providerPriority = () => [], sessionBinder = null } = {}) {
    this.io = io;
    this.aiEngine = aiEngine;
    this.providerPriority = providerPriority;
    this.sessionBinder = sessionBinder;
    this.runnerFactory = runnerFactory;
    /** id → LongRunTask */
    this.tasks = new Map();
  }

  /**
   * cli_common.make_supervisor。需求文档同时给执行者和监督者，必须是同一份文本。
   * 提示词读不到硬失败（以为换了规则而实际跑的是默认那份，最难察觉）；
   * 凭据取不到则不启用并警告（原版 LLMError 分支），执行者每次结束都停机等人。
   * 凭据来源与轮换见 LongRunSupervisorCreds.js。
   * @param {() => object} getTask  换供应商时往该任务的编排日志里记一笔（任务在监督者之后才建出来）
   */
  _makeSupervisor(o, requirementText, getTask = () => null) {
    if (o.noSupervisor) return { supervisor: null, info: { status: 'off' } };
    const { text, source } = loadSystemPrompt(o.supervisorPrompt || null);
    const builtinText = o.supervisorPrompt ? loadSystemPrompt().text : text;
    const creds = new SupervisorCredentials({
      engine: this.aiEngine, providerId: o.providerId, priority: this.providerPriority,
      onSwitch: ({ from, to, error }) => getTask()?.loop?.log(`  监督者供应商 ${from} 调不通（${String(error).slice(0, 80)}），换用 ${to}`),
    });
    const cred = creds.resolve();
    if (!cred) {
      return { supervisor: null, info: { status: 'unavailable', error: o.providerId
        ? '所选供应商没有可用的地址与密钥（明确选定的供应商不会被自动换掉）'
        : 'CC Switch 里没有带地址与密钥的 Claude 供应商' } };
    }
    const supervisor = new Supervisor({
      requirementText, systemPrompt: text, promptSource: source, maxTokens: 4000,
      complete: (system, user) => creds.complete(system, user),
    });
    return { supervisor,
      info: { status: 'on', model: cred.config.model, baseUrl: cred.config.apiUrl, providerName: cred.name,
        borrowed: cred.borrowed, promptSource: source, promptText: text, builtinText } };
  }

  /** 粘贴的文本 → 文件路径。按内容哈希命名，幂等：plan 与 start 各调一次只落同一个文件。 */
  resolveDocPath({ docPath, requirementText }) {
    if (docPath) return String(docPath);
    const text = String(requirementText || '').trim();
    if (!text) throw new LaunchError('需求为空：请粘贴需求文本，或填写本机需求文档的绝对路径');
    const hash = createHash('sha256').update(text).digest('hex').slice(0, 12);
    const file = path.join(REQUIREMENT_DIR, `${deriveName(text)}-${hash}.md`);
    mkdirSync(REQUIREMENT_DIR, { recursive: true });
    if (!existsSync(file)) writeFileSync(file, text + '\n', 'utf8');
    return file;
  }

  /** 该沙箱上正在跑的任务（同一沙箱同时只允许一个：两个执行者抢同一个 git 仓库与记忆库）。 */
  _runningOn(root) {
    return [...this.tasks.values()].find((t) => t.state === 'running' && t.sandbox.root === root) || null;
  }

  /** 项目目录：给了绝对路径用它；否则名字 → 需求标题/文档名派生，放在项目根下。 */
  _projectRoot(opts, docPath) {
    const projectName = opts.projectName || opts.sandboxName
      || (opts.requirementText && !opts.docPath ? deriveName(opts.requirementText) : deriveSandboxName(docPath));
    return resolveProjectRoot({ projectRoot: opts.projectRoot, projectName });
  }

  /**
   * 预检：解析需求、给出项目目录现状与参考清单。**不建目录、不起进程、不删任何东西。**
   * 面板据此提示：新建 / 接管已有项目 / 续跑。
   */
  plan({ docPath: rawDoc, requirementText, projectRoot, projectName, sandboxName, promptsFile } = {}) {
    const docPath = this.resolveDocPath({ docPath: rawDoc, requirementText });
    const prompts = loadPrompts(promptsFile || PROMPT_FILE);   // 缺段就在这里硬失败
    const req = previewRequirement(docPath);
    const root = this._projectRoot({ docPath: rawDoc, requirementText, projectRoot, projectName, sandboxName }, docPath);
    const state = projectDirState(root);
    const dirs = extraDirsOf(req);
    return {
      docPath,
      projectRoot: root,
      projectName: path.basename(root),
      dirState: state,
      suggestedMode: state === 'project' ? 'takeover' : state === 'longrun' ? 'resume' : 'start',
      resumable: state === 'longrun' && memoryFiles(root).length > 0,
      prior: state === 'missing' ? null : priorState(root),
      runningTaskId: this._runningOn(root)?.id || null,
      projects: listLongRunProjects(),
      // 旧字段名，界面改完前保留
      sandboxName: path.basename(root), sandboxRoot: root, sandboxExists: state !== 'missing',
      requirementChars: req.text.length,
      refs: req.refs.map((r) => ({ path: r.path, isDir: r.isDir })),
      urls: req.urls,
      rejected: req.rejected,
      extraDirs: dirs,
      promptSource: prompts.source,
      promptSlots: Object.keys(PROMPT_SLOTS),
      writableWarning: dirs.length ? `这 ${dirs.length} 个外部目录对执行者是可写的（--add-dir 非只读）` : '',
    };
  }

  /**
   * 启动一次运行。
   *   start    新项目（start.py）：发初始化提示词 + 需求全文
   *   takeover 接管已有传统项目：发初始化提示词建记忆库，需求按"在已有进度上继续"包装；不删不覆盖，原有 Claude 记忆复制进 .memory
   *   resume   续跑（resume.py）：跳过初始化，需求按"新增"包装
   * 能在动目录之前查出的问题全部先查：参数、文档、提示词、监督者提示词、参考路径。
   * 原版有几项放在建沙箱之后才查，带 --fresh 时等于先删了旧成果才报错 —— 这里前移。
   * @returns {object} 任务快照（异步跑，事件推 socket 房间 longrun:<id>）
   */
  async start(opts = {}) {
    const o = normalizeOptions(opts);
    const docPath = this.resolveDocPath(opts);
    if (!existsSync(docPath) || !statSync(docPath).isFile()) throw new LaunchError(`需求文档不存在: ${path.resolve(docPath)}`);
    const prompts = loadPrompts(o.promptsFile || PROMPT_FILE);
    if (!o.noSupervisor) loadSystemPrompt(o.supervisorPrompt || null);          // 读不到硬失败
    checkRejectedRefs(previewRequirement(docPath), o);

    const root = this._projectRoot(opts, docPath);
    const busy = this._runningOn(root);
    if (busy) throw new LaunchError(`项目 ${path.basename(root)} 上已有长程任务在跑（${busy.id}）。同一项目同时只能跑一个。`);
    prepareProject(root, { mode: o.mode, fresh: o.fresh });
    // 长程是会话条目的一种运行模式：找/建这个目录的条目。里面 claude 正在跑就拒绝 ——
    // 两个执行者同时改一个目录、抢一份 git 与记忆（绑定失败时什么都还没动）
    let sessionId = null;
    if (this.sessionBinder) {
      try { sessionId = await this.sessionBinder.bind(root, { projectName: path.basename(root) }); }
      catch (e) { throw new LaunchError(e.message); }
    }

    let sandbox;
    try {
      sandbox = LongRunSandbox.open(root, { importMemory: o.mode === 'takeover' });
    } catch (e) { throw new LaunchError(e.message); }
    return this._launch({ o, docPath, prompts, sandbox, sessionId });
  }

  /** 建好沙箱之后：登记参考路径、收集自检清单、组装监督者与循环、异步开跑。 */
  _launch({ o, docPath, prompts, sandbox, sessionId = null }) {
    const resume = o.mode === 'resume';
    const continuing = resume || o.mode === 'takeover';    // 在已有进度上继续：需求按"新增"包装
    // 带 spec 再解析一次：外部参考这次才真正登记进沙箱（--add-dir）。与预检同一套规则
    const req = loadRequirement(docPath, sandbox);
    checkRejectedRefs(req, o);

    const sc = new SelfCheck();
    reportPrompts(sc, prompts);
    sc.info('项目', `项目: ${sandbox.root}（${MODE_TEXT[o.mode]}）`);
    reportClaudeTemplate(sc, sandbox);
    reportJobguard(sc);
    reportInject(sc, sandbox);
    if (continuing) reportPriorState(sc, priorState(sandbox.root));
    reportRequirement(sc, req, o);

    const input = requirementInput(req, { resume: continuing });
    let task = null;
    const { supervisor, info } = this._makeSupervisor(o, input, () => task);
    reportSupervisor(sc, info);
    const { promptText, builtinText, ...supervisorInfo } = info;   // 全文不进快照

    const id = `${path.basename(sandbox.root)}-${Date.now().toString(36)}`;
    task = new LongRunTask({ id, mode: o.mode, sandbox, docPath, requirementText: input, requirementDoc: req.text,
      options: { ...o }, selfCheck: sc.toJSON(), supervisorInfo });
    task.sessionId = sessionId;
    task.loop = new LongRunLoop({
      sandbox, prompts, requirementText: input, supervisor,
      model: o.model, handoffFloor: o.handoffFloor, handoffCeiling: o.handoffCeiling, hardKill: o.hardKill,
      maintenanceEvery: o.maintenanceEvery, totalBudgetUsd: o.totalBudgetUsd, maxLegs: o.maxLegs,
      taskWait: o.taskWait, askHuman: !o.noAsk, skipInit: resume,
      onEvent: (ev) => this._push(task, ev),
      // Promise 执行器同步运行，waiter 在同一 tick 挂好，不存在回答先到的竞态
      // 挂起点就绪后立刻广播：need_human 事件先于挂起发出，那一刻的摘要里 awaitingHuman 还是 false，
      // 不补这一下列表徽标和回答框都出不来
      humanChannel: () => new Promise((resolve) => { task._humanWaiter = resolve; this._broadcast(task); }),
      ...(this.runnerFactory ? { runnerFactory: this.runnerFactory } : {}),
    });
    this.tasks.set(id, task);
    this._emit(task, 'selfcheck', { items: task.selfCheck });

    task.loop.run().then((report) => {
      task.report = report;
      task.state = report.stop === Stop.PROJECT_DONE ? 'done' : 'failed';
      task._humanWaiter = null;
      this._emit(task, 'state', { state: task.state, stop: report.stop });   // finished 已由 loop 发过
    }).catch((e) => {
      task.state = 'failed';
      task.report = { stop: Stop.ERROR, needs_from_human: e.message };
      this._emit(task, 'error', { message: e.message });
    });
    return task.toJSON();
  }

  /** 服务层自己的事件，形状与 loop 一致（kind + at 秒）。 */
  _emit(task, kind, data = {}) {
    this._push(task, { ...data, kind, at: Date.now() / 1000 });
  }

  /** 推 socket 房间、进回放缓冲，并顺带更新快照。 */
  _push(task, ev) {
    const s = task.snapshot;
    switch (ev.kind) {
      case 'send': s.occupied = 0; s.lastLabel = ev.label || ''; break;     // 新一发，水位从头算
      case 'exec.context':
        s.occupied = ev.occupied || 0;
        s.contextPeak = Math.max(s.contextPeak, ev.peak || 0);
        break;
      case 'result':
        s.legs = ev.leg ?? s.legs;
        s.costUsd = Math.round((task.loop?.spentUsd || 0) * 1e4) / 1e4;  // loop 实账（被杀的发次按估算记）
        s.contextPeak = Math.max(s.contextPeak, ev.context_peak || 0);
        break;
      case 'handoff.done': s.handoffs = ev.count ?? s.handoffs; break;
      case 'maintenance.done': s.maintenances = ev.count ?? s.maintenances; break;
      case 'supervisor.decided': s.decisions = task.loop?.decisions ?? s.decisions + 1; break;
      case 'finished':
        Object.assign(s, { legs: ev.legs, handoffs: ev.handoffs, maintenances: ev.maintenances,
          decisions: ev.decisions, costUsd: ev.cost_usd });
        break;
      default: break;
    }
    // 看板状态吃事件；命中归类规则的会带回 _entry（时间线条目），随事件一起推
    const handled = task.board.handle(ev);
    task.seq += 1;
    // ⚠ kind 放在展开之后：数据里若也带 kind 字段不能覆盖事件类型
    const out = { ...handled, taskId: task.id, seq: task.seq, kind: ev.kind };
    this.io?.to(task.room).emit('longrun:event', out);
    if (LIST_KINDS.has(ev.kind)) this._broadcast(task);
  }

  /** 向所有客户端广播任务摘要（左侧列表用）。不走事件的状态变化（挂起等人、面板暂停）也要调它 */
  _broadcast(task) {
    this.io?.emit?.('longrun:task', task.toJSON());
  }

  // ── 查询 ───────────────────────────────────────────────────

  /** 看板快照（刷新页面/首次打开时用；之后收增量）。seq 是快照对应的推送序号，前端丢弃 ≤ 它的增量。 */
  board(taskId) {
    const task = this.tasks.get(taskId);
    return task ? { seq: task.seq, snapshot: task.board.snapshot() } : null;
  }

  /**
   * 事后回放（view.py）。内存里有这个沙箱最近的任务就直接给它的看板 —— 那份比落盘文件多了实时状态；
   * 否则读 .run/orchestrator.jsonl（服务重启后、或原版 Python 跑出来的轮次）。
   */
  replay({ sandboxName, projectRoot, file } = {}) {
    if ((sandboxName || projectRoot) && !file) {
      let root;
      try {
        root = projectRoot ? resolveProjectRoot({ projectRoot })
          : (listLongRunProjects().find((p) => p.name === sandboxName)?.root || resolveProjectRoot({ projectName: sandboxName }));
      } catch (e) { return { ok: false, error: e.message }; }
      const live = [...this.tasks.values()].filter((t) => t.sandbox.root === root).sort((a, b) => b.startedAt - a.startedAt)[0];
      if (live) return { ok: true, live: true, taskId: live.id, file: path.join(root, '.run', EVENTS_FILE), sandboxRoot: root,
        notices: [], snapshot: live.board.snapshot() };
    }
    return replayRun({ sandboxName, projectRoot, file });
  }

  /**
   * 某个会话条目的长程视图：该条目最近一次任务（内存里有）→ 实时看板；否则按条目工作目录从磁盘回放。
   * 服务重启后内存里的任务丢了，条目仍是长程模式，靠这条路径看到上一轮。
   */
  forSession(sessionId) {
    const task = [...this.tasks.values()].filter((t) => t.sessionId === sessionId).sort((a, b) => b.startedAt - a.startedAt)[0];
    if (task) return { ok: true, taskId: task.id, task: task.toJSON() };
    const s = this.sessionBinder?.get(sessionId);
    if (!s?.workingDir) return { ok: false, error: '会话不存在或没有工作目录' };
    return { ...this.replay({ projectRoot: s.workingDir }), projectRoot: s.workingDir };
  }

  /** 会话记录（transcript.py）：列出某工作目录的会话，缺省为沙箱根。 */
  transcriptSessions(dir) { return apiSessions(dir); }

  transcriptSession(file) { return apiSession(file); }

  status(taskId) {
    if (taskId) return this.tasks.get(taskId)?.toJSON() || null;
    return [...this.tasks.values()].map((t) => t.toJSON());
  }

  /** 跑过长程的项目与各自上次运行痕迹（续跑与回放挑项目用，resume.py list_sandboxes + show_prior_state）。 */
  sandboxes() {
    return listLongRunProjects().map(({ name, root, legacy }) => {
      return { name, root, legacy, resumable: memoryFiles(root).length > 0, prior: priorState(root),
        hasEvents: existsSync(path.join(root, '.run', EVENTS_FILE)),
        runningTaskId: this._runningOn(root)?.id || null };
    });
  }

  // ── 人工干预 ───────────────────────────────────────────────

  /** 取运行中的任务；不在跑时拒绝 —— 投件/暂停文件留在沙箱里，会在下一次续跑时突然生效。 */
  _running(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return [null, { ok: false, error: '任务不存在（服务重启后内存里的任务会丢失）' }];
    if (task.state !== 'running') return [null, { ok: false, error: '任务已结束' }];
    return [task, null];
  }

  /**
   * 人工注入。写文件而非直接调 —— 与原版文件约定一致，终端投件与面板投件走同一条路。
   * immediate 写 inject!.txt（立即打断），否则 inject.txt（下一个工具间隙）。
   */
  inject(taskId, text, immediate = false) {
    const [task, err] = this._running(taskId);
    if (err) return err;
    const t = String(text || '').trim();
    if (!t) return { ok: false, error: '注入内容为空' };
    const file = immediate ? task.loop.injectNowPath : task.loop.injectPath;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, t, 'utf8');
    return { ok: true, path: file, immediate: !!immediate };
  }

  /** 暂停/继续：建或删 .run/pause 空文件。暂停闸在派发口，当前这发照常跑完。 */
  pause(taskId, on = true) {
    const [task, err] = this._running(taskId);
    if (err) return err;
    const f = task.loop.pausePath;
    if (on) {
      mkdirSync(path.dirname(f), { recursive: true });
      writeFileSync(f, '', 'utf8');
    } else if (existsSync(f)) {
      try { unlinkSync(f); } catch (e) { return { ok: false, error: `删除暂停文件失败: ${e.message}` }; }
    }
    this._broadcast(task);
    return { ok: true, pauseArmed: !!on };
  }

  /**
   * 停下（不是终止）：先立即打断当前这发，再挂暂停闸。
   * ⚠ 顺序要紧：反过来当前这发会照常跑完（暂停闸只在派发口），那可能还要一两个小时。
   */
  stop(taskId, reason) {
    const r = this.inject(taskId, reason || STOP_REASON, true);
    if (!r.ok) return r;
    const p = this.pause(taskId, true);
    if (!p.ok) return p;
    return { ok: true, note: '已打断当前发次并挂上暂停闸；点「继续」会接着干，不是终止' };
  }

  /** 回答执行者的提问。原样发给执行者；空回答 = 停机（与原版终端直接回车一致）。 */
  answer(taskId, text) {
    const [task, err] = this._running(taskId);
    if (err) return err;
    if (!task._humanWaiter) return { ok: false, error: '执行者当前没有在等回答' };
    const resolve = task._humanWaiter;
    task._humanWaiter = null;
    resolve(String(text || ''));
    this._broadcast(task);
    return { ok: true, answered: !!String(text || '').trim() };
  }

  /**
   * 终止：杀执行者整个进程组，唤醒暂停与等人，本轮以「人工终止」收工并打快照。
   * 与「停下」不同，终止后这个任务不会再动；沙箱与记忆都在，可以随时续跑。
   */
  terminate(taskId, reason = '用户在面板上终止') {
    const [task, err] = this._running(taskId);
    if (err) return err;
    task.loop.abort(reason);
    if (task._humanWaiter) {
      const resolve = task._humanWaiter;
      task._humanWaiter = null;
      resolve('');
    }
    this._broadcast(task);
    return { ok: true, note: '已终止：执行者已被结束，本轮收工并打快照。沙箱与记忆都保留，可以续跑。' };
  }
}

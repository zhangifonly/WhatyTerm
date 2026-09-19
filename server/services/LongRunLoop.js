/**
 * 长程编排：会话循环 —— 管上下文生命周期，不管任务内容
 *
 * 逐函数移植自长程编排器 orchestrator/session_loop.py。编排器只做四件事：
 *   1. 按固定顺序发提示词原文（一字不改）
 *   2. 监控 token 水位，到阈值就交接
 *   3. 让监督者判断该继续、该叫人，还是项目已完成
 *   4. 把过程推给看板（并落盘 .run/orchestrator.jsonl，python view.py 可回放）
 * **不做**任务拆解、验证命令、判别力检查、失败回退。执行者自己管 git、测试、完成判断。
 *
 * 一次运行的输入序列：
 *     初始化提示词 → 需求文档全文 → [继续完成项目] × n
 *                                ↓ 水位到阈值且未完成
 *                           旧对话收尾提示词 ↓ 新进程
 *                           新对话开始提示词 → [继续完成项目] × n → …
 * 每第 3 次交接，在收尾提示词之前依次插入维护提示词 1、2。
 *
 * 与原版的差异（均有意为之）：
 *   · 等人回答走面板（humanChannel），不读终端 stdin；askHuman=false 等价于原版 --no-ask
 *   · 新增「终止」（abort）：原版靠终端 Ctrl+C；网页上没有，用 Stop.INTERRUPTED 落地
 *   · 水位三档启动时校验顺序（原版无校验，写反会让每发刚开跑就被打断）
 *   · run() 兜住非预算异常记为 Stop.ERROR 并写 report.json（原版会直接崩、不写报告）
 *   · 日志写 .run/loop.log 并推事件，不打印到服务进程 stdout（面板就是终端）
 */

import { writeFileSync, appendFileSync, mkdirSync, existsSync, readFileSync, unlinkSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import { ExitReason, LongRunRunner, DEFAULT_TOOLS, TASK_WAIT, looksLikeQuestion } from './LongRunRunner.js';
import { Judgement, Verdict } from './LongRunSupervisor.js';
import { CONTINUE_PROMPT, MODE_SWITCH_NOTICE } from './LongRunPrompts.js';
import { realResolve } from './LongRunSandbox.js';
import { memoryFiles } from './LongRunLaunch.js';
import { briefLine, classifyError } from './longrunErrorBrief.js';
import { planRecovery } from './longrunRecovery.js';

/** 正常结束且水位过此线 → 交接（不再继续追问，换个干净窗口） */
export const HANDOFF_FLOOR = 200_000;
/**
 * 运行中水位过此线 → 在工具间隙主动打断。定在 35 万而非 40 万：给收尾提示词留出
 * 写记忆的窗口 —— 收尾本身要读会话、写多个文件，很吃 token。
 */
export const HANDOFF_CEILING = 350_000;
/** 硬上限。到这里连收尾都来不及，直接 kill */
export const HARD_KILL = 400_000;
/** 每第 N 次交接，在收尾之前跑一轮记忆维护 */
export const MAINTENANCE_EVERY = 3;
/**
 * 总预算上限（美元）。默认 100 万 = 实际不限：一个偏小的默认值会在半路截断，
 * 而截断点通常正好落在该交接的地方（sekiro 被截时水位 331,721）。
 */
export const TOTAL_BUDGET_USD = 1_000_000;
/** 运行中费用刹车的宽容系数。估算中位误差 9%、最坏 41%，拿估算当硬上限会把误差变成误杀 */
export const COST_TOLERANCE = 1.5;
/** 默认调用次数上限（原版 --max-legs 默认值） */
export const MAX_LEGS = 200;
/** 默认墙钟上限（原版 SessionLoop.wall_timeout） */
export const LOOP_WALL_TIMEOUT = 7200.0;
/** 暂停期间多久看一次闸门。人删完文件会盯着等反应，更长会让人以为没生效 */
export const PAUSE_POLL_S = 3.0;

/** 成果摘要落盘文件名。与 report.json 分开：report.json 的字段要与原版逐字段一致 */
export const OUTCOME_FILE = 'outcome.json';

export const Stop = {
  PROJECT_DONE: 'project_done',   // 监督者判定整体完成
  NEEDS_HUMAN: 'needs_human',     // 需人类介入且未获回复
  BUDGET: 'budget',               // 预算耗尽
  MAX_LEGS: 'max_legs',           // 调用次数上限
  ERROR: 'error',                 // 连续异常
  INTERRUPTED: 'interrupted',     // 人为中断（面板上的「终止」）
};

/** 预算在派发口被拦下。 */
export class BudgetExceeded extends Error {
  constructor(message) { super(message); this.name = 'BudgetExceeded'; }
}
/** 人在面板上点了「终止」。 */
export class LoopInterrupted extends Error {
  constructor(message) { super(message); this.name = 'LoopInterrupted'; }
}

/** 三档水位必须有序。原版无此校验，写反会让每发刚开跑就被打断（ceiling 低于 floor）。 */
export function assertThresholds({ handoffFloor, handoffCeiling, hardKill }) {
  if (!(handoffFloor < handoffCeiling && handoffCeiling < hardKill)) {
    throw new Error(
      `水位三档必须满足 交接下限 < 主动打断 < 硬上限，实际 ${handoffFloor} / ${handoffCeiling} / ${hardKill}。\n`
      + '写反了会让每发刚开跑就被打断（ceiling 低于 floor）或收尾来不及（ceiling 贴着 hardKill）。');
  }
}

/** 收工报告的文本版（原版 LoopReport.render） */
export function renderReport(r) {
  const lines = [
    `停机原因: ${r.stop}`,
    `执行者调用 ${r.legs} 次 · 上下文交接 ${r.handoffs} 次 · 记忆维护 ${r.maintenances} 次 · 监督者代答 ${r.decisions} 次`,
    `耗时 ${r.elapsed_s.toFixed(0)}s · 费用 $${r.cost_usd.toFixed(4)}`,
  ];
  if (r.needs_from_human) lines.push(`需人类提供: ${r.needs_from_human}`);
  return lines.join('\n');
}

const pad2 = (n) => String(n).padStart(2, '0');
const hms = () => { const d = new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };

export class LongRunLoop {
  /**
   * @param {object} o 与原版 SessionLoop.__init__ 一一对应（驼峰）：
   *   sandbox prompts requirementText supervisor model allowedTools handoffFloor handoffCeiling
   *   hardKill maintenanceEvery totalBudgetUsd maxLegs wallTimeout taskWait askHuman skipInit
   *   extraDirs onEvent
   * 另有：humanChannel(result, judgement) => Promise<string>（面板等人回答）；
   *       runnerFactory(opts) => runner（测试注入）
   */
  constructor(o = {}) {
    o.sandbox.verifyClean();
    this.spec = o.sandbox;
    this.prompts = o.prompts;
    this.requirementText = o.requirementText || '';
    this.supervisor = o.supervisor || null;
    this.model = o.model || '';
    // 供应商侧故障的自救状态：失败次数决定等多久，试过的模型不重复试
    this.providerFailures = 0;
    this.triedModels = this.model ? [this.model] : [];
    this.recoveries = [];              // 自救记录，收工报告里要如实说
    this.modelLister = o.modelLister || null;   // () => Promise<string[]>；测试注入，缺省不查
    this.allowedTools = o.allowedTools ?? DEFAULT_TOOLS;
    this.handoffFloor = o.handoffFloor ?? HANDOFF_FLOOR;
    this.handoffCeiling = o.handoffCeiling ?? HANDOFF_CEILING;
    this.hardKill = o.hardKill ?? HARD_KILL;
    assertThresholds(this);
    this.maintenanceEvery = o.maintenanceEvery ?? MAINTENANCE_EVERY;
    this.totalBudgetUsd = o.totalBudgetUsd ?? TOTAL_BUDGET_USD;
    this.maxLegs = o.maxLegs ?? MAX_LEGS;
    this.wallTimeout = o.wallTimeout ?? LOOP_WALL_TIMEOUT;
    // 主线说完后等后台 subagent 收尾的上限。不等的话它们随进程退出连坐死掉
    this.taskWait = o.taskWait ?? TASK_WAIT;
    this.askHuman = o.askHuman ?? true;
    // 断点续跑：跳过初始化提示词，第一发就是「新对话开始提示词」+ 新需求
    this.skipInit = !!o.skipInit;
    // 续接终端那条 Claude 对话的 id（从终端转长程且选「续同一条对话」时给）。
    // 给了它就不发初始化/新对话提示词，见 open()
    this.resumeSessionId = o.resumeSessionId || '';
    this.extraDirs = [...(o.extraDirs || []), ...(this.spec.extraDirs || [])];
    this.humanChannel = o.humanChannel || null;
    this.runnerFactory = o.runnerFactory || ((opts) => new LongRunRunner(opts));
    this._onEvent = o.onEvent || null;

    this.spentUsd = 0;
    this.legs = 0;
    this.handoffs = 0;
    this.maintenances = 0;
    this.decisions = 0;          // 监督者代委托人作答的次数（唯一能事后发现"哪些决定不是人做的"的线索）
    this.emptyResults = 0;       // 空返回次数。连续多次说明不是脏会话，要停机
    this.sessionId = null;
    this._lastResult = null;
    this._currentRunner = null;
    this.aborted = null;         // 面板「终止」的原因
    this.halted = false;         // 正停在暂停闸前（面板区分"闸已挂"与"已停住"）

    const run = this.spec.runDir;
    this.logPath = path.join(run, 'loop.log');
    this.statePath = path.join(run, 'session_state.json');
    // 人工打断的投件口。写文件即生效，见 takeInject()
    this.injectPath = path.join(run, 'inject.txt');
    this.injectNowPath = path.join(run, 'inject!.txt');
    // 编排层事件落盘，供 view.py 回放。追写：续跑同一沙箱时接在后面，不覆盖上一轮
    this.eventsPath = path.join(run, 'orchestrator.jsonl');
    // 暂停闸。文件存在则不再派发下一发，删掉就继续
    this.pausePath = path.join(run, 'pause');
  }

  // ── 日志与事件 ─────────────────────────────────────────────

  log(msg) {
    try { appendFileSync(this.logPath, `[${hms()}] ${msg}\n`, 'utf8'); } catch { /* 日志问题不该把任务弄死 */ }
    this.emit('log', { message: msg });
  }

  /**
   * 发观察事件：先落盘，再推给看板。**落盘与 onEvent 无关**，没人看也写 ——
   * .run/events/ 是 CLI 原始事件，层级不对，恢复不出"哪一发发的是哪段提示词、监督者判了什么"。
   * 字段名与原版一致（at、下划线），python view.py 靠这个文件回放。
   */
  emit(kind, data = {}) {
    const ev = { ...data, kind, at: Date.now() / 1000 };
    try { appendFileSync(this.eventsPath, JSON.stringify(ev) + '\n', 'utf8'); } catch { /* 落盘失败不影响执行 */ }
    if (!this._onEvent) return;
    try { this._onEvent(ev); } catch { /* 监控挂了不该影响执行 */ }
  }

  /** 落盘运行状态，供断点续跑（resume.py 的"上次运行"）与手工 claude --resume <id>。 */
  saveState() {
    writeFileSync(this.statePath, JSON.stringify({
      updated_at: Date.now() / 1000, session_id: this.sessionId, legs: this.legs,
      handoffs: this.handoffs, maintenances: this.maintenances, decisions: this.decisions,
      spent_usd: Math.round(this.spentUsd * 1e4) / 1e4,
    }, null, 2), 'utf8');
  }

  // ── git 快照 ───────────────────────────────────────────────

  _git(args) {
    try {
      // ⚠ LC_ALL=C：snapshotCommit 靠英文 "nothing to commit" 判断无改动。原版没固定语言，
      //   中文 git 下每次无改动都误报「快照 commit 失败」（本机实测）
      const out = execFileSync('git', ['--no-pager', ...args], {
        cwd: this.spec.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, LC_ALL: 'C' },
      });
      return [0, String(out).trim()];
    } catch (e) {
      return [e.status ?? 1, (String(e.stdout || '') + String(e.stderr || '')).trim()];
    }
  }

  /** git 认为的仓库根（跟随符号链接）。不在任何仓库里返回空串。 */
  _gitToplevel() {
    const [code, out] = this._git(['rev-parse', '--show-toplevel']);
    return code === 0 && out ? realResolve(out) : '';
  }

  /**
   * 项目必须是**自己的** git 仓库，纯为交接前打快照。
   *
   * ⚠ 判据是 `--show-toplevel === 项目根`，不是 `rev-parse` 成功：项目放在 ~/Documents/ClaudeCode 下，
   *   而 ClaudeCode 本身是个有远端、混着多个客户资料的仓库。子目录没有自己的 .git 时 rev-parse 会找到外层仓库，
   *   快照的 `git add -A` 就把整个工作区暂存提交进去（原版只判 rev-parse 成功，放进嵌套目录必出事）。
   *   外层仓库里已有 67 个自带 .git 的子项目，这里建的是同一种形态。
   * 删除失败会留下只含 objects 的残壳（目录在但仓库不可用）—— 先清掉残壳再 init。
   * ⚠ .gitignore 只忽略 .run/：**.memory/ 必须进快照**，回滚时记忆与代码才一致（审计 #3）。
   *   接管已有项目时它可能已有 .gitignore：只追加 .run/，别的不动。
   */
  ensureRepo() {
    const root = realResolve(this.spec.root);
    if (this._gitToplevel() !== root) {
      const shell = path.join(root, '.git');
      if (existsSync(shell)) rmSync(shell, { recursive: true, force: true });
      this._git(['init', '-q']);
      this._git(['config', 'user.email', 'orchestrator@local']);
      this._git(['config', 'user.name', 'orchestrator']);
      if (this._gitToplevel() !== root) {
        throw new Error(`项目目录没能成为独立的 git 仓库（git 认为仓库根是 ${this._gitToplevel() || '(无)'}），`
          + '拒绝继续：否则快照会提交进外层仓库');
      }
      this._ensureIgnoreRun(root);
      this._git(['add', '-A']);
      this._git(['commit', '-q', '-m', 'orchestrator: init sandbox', '--allow-empty']);
      return;
    }
    this._ensureIgnoreRun(root);
  }

  /** 保证 .run/（运行现场、执行者配置、备份）不进快照。已被忽略就不动 .gitignore。 */
  _ensureIgnoreRun(root) {
    const [ignored] = this._git(['check-ignore', '-q', '.run/']);
    if (ignored === 0) return;
    const gi = path.join(root, '.gitignore');
    const cur = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
    const add = cur ? `${cur.endsWith('\n') ? '' : '\n'}.run/\n` : '.run/\n__pycache__/\n*.pyc\n';
    writeFileSync(gi, cur + add, 'utf8');
  }

  /**
   * 收尾时的成果摘要：本轮改了哪些文件、快照 commit、记忆条数。给界面的结论卡用。
   *
   * ⚠ 整段包在 try 里：统计只是锦上添花，**不能让收尾失败**（收尾失败等于任务白跑）。
   * 拿不到就返回 null，界面相应不显示成果行 —— 宁可不显示，也不显示编出来的数字。
   */
  collectOutcome(stop) {
    try {
      // 始终再收一次工作区：没打过收尾快照的停机原因（预算/次数上限/异常/等人）靠它保住最后一段工作；
      // 已经打过的（project_done/interrupted）这里是空提交，git 自己会拒绝，不会多出垃圾提交
      const commit = this.snapshotCommit(String(stop || 'stopped')) || this.finishCommit || '';
      if (!this.startCommit) {
        return { commit, files: [], fileCount: 0, memoryCount: memoryFiles(this.spec.root).length, ...this._failureBrief() };
      }
      const [code, out] = this._git(['diff', '--numstat', `${this.startCommit}..HEAD`]);
      const rows = code === 0 ? String(out).split('\n').filter(Boolean) : [];
      let insertions = 0, deletions = 0;
      const files = [];
      for (const row of rows) {
        const [add, del, file] = row.split('\t');
        insertions += Number(add) || 0;          // 二进制文件是 '-'，Number('-') 是 NaN → 计 0
        deletions += Number(del) || 0;
        if (file) files.push(file);
      }
      return {
        commit, fileCount: files.length, files: files.slice(0, 5), insertions, deletions,
        memoryCount: memoryFiles(this.spec.root).length,
        ...this._failureBrief(),
      };
    } catch (e) {
      this.log(`  成果摘要统计失败（不影响收尾）: ${e.message}`);
      return null;
    }
  }

  /**
   * 最后一发的错误摘要与归类，写进 outcome.json 供结论卡用。
   *
   * 为什么要归类而不只是原文：错在供应商（没渠道/限流/认证）时，
   * 「先转为终端手工跑一下」这条默认建议是**有害的** —— 手工跑必然再撞同一个 503，
   * 白花时间。归类为 provider 的，结论卡会改口让人换模型/换供应商或等一会儿。
   */
  _failureBrief() {
    // 自救记录即使最终跑成了也要留：人有权知道"这一轮中途等过 5 分钟、换过模型"，
    // 否则只看到耗时变长却不知道为什么。
    const recs = Array.isArray(this.recoveries) ? this.recoveries : [];
    const out = recs.length ? { recoveries: recs.slice(0, 8), recoveryCount: recs.length } : {};
    const raw = this._lastResult?.error || '';
    if (!raw) return out;
    const c = classifyError(raw);
    return { ...out, failure: { kind: c.kind, label: c.label, advice: c.advice, detail: c.detail, actionable: c.actionable } };
  }

  /** 打一个快照 commit。只是存点保命，不做成败判定 —— 跑坏了能回退到任意一次交接点。 */
  snapshotCommit(label) {
    this._git(['add', '-A']);
    const [code, out] = this._git(['commit', '-q', '-m', `orchestrator snapshot: ${label}`]);
    if (code !== 0 && !out.includes('nothing to commit')) {
      this.log(`  快照 commit 失败: ${out.slice(0, 200)}`);
      return null;
    }
    const [, sha] = this._git(['rev-parse', '--short', 'HEAD']);
    return sha || null;
  }

  // ── 单次执行者调用 ─────────────────────────────────────────

  /**
   * 本发允许估算花到多少就刹车 = (总预算 − 已结算) × 宽容系数。
   * 预算是默认的 100 万（等于不限）时返回 null —— 不给刹车（审计 #1）。
   */
  costCeiling() {
    if (this.totalBudgetUsd >= TOTAL_BUDGET_USD) return null;
    const remaining = this.totalBudgetUsd - this.spentUsd;
    if (remaining <= 0) return null;   // 已超支，send 入口那道会直接拦下
    return remaining * COST_TOLERANCE;
  }

  /** 续跑时的主动打断阈值。用 ceiling 而非 hardKill：留出余量让收尾写得完记忆（审计 G13）。 */
  killAt() { return this.handoffCeiling; }

  /** 构造 runner。killAt 为 null 表示这一段不主动打断 —— 收尾与维护本来就要在高水位下跑完。 */
  _runner(killAt) {
    return this.runnerFactory({
      cwd: this.spec.root,
      // envOverride：人在面板上换供应商时注入的地址与密钥（下一发生效）。
      // 执行者本来继承 CC Switch 全局配置，不注入的话换供应商按钮就是假的。
      env: { ...this.spec.childEnv(), ...(this.envOverride || {}) },
      allowedTools: this.allowedTools,
      model: this.model,
      // 不设 handoffLimit：水位判断统一在本循环里做，避免两处阈值各说一套
      contextLimit: killAt || 1e12,
      handoffLimit: 0,
      costCeiling: this.costCeiling(),
      extraDirs: this.extraDirs,
      // 执行者专用配置（权限白名单、MCP 闸、禁改项目外 CLAUDE.md）。不写进项目配置，同目录的终端会话看不到
      settingsFile: this.spec.executorSettingsPath || '',
      wallTimeout: this.wallTimeout,
      taskWait: this.taskWait,
      eventsDir: path.join(this.spec.runDir, 'events'),
      onStream: ({ kind, ...rest }) => this.emit(`exec.${kind}`, rest),
      checkInject: () => this.takeInject(),
    });
  }

  _checkAborted() {
    if (this.aborted) throw new LoopInterrupted(this.aborted);
  }

  /**
   * 发一段输入给执行者，等它跑完。label 只用于日志与看板，**不影响发出去的内容**。
   *
   * 派发前查暂停与预算：这是唯一能覆盖全部派发点的位置 —— 开场两发与交接段的
   * 收尾、维护都不走主循环（sekiro：--budget 50，第 1 发 $59 超了第 2 发照样花 $88）。
   */
  async send(prompt, label, { resume, killAt = null } = {}) {
    await this.waitIfPaused(label);
    this._checkAborted();
    if (this.spentUsd >= this.totalBudgetUsd) {
      throw new BudgetExceeded(
        `已花 $${this.spentUsd.toFixed(2)}，达到上限 $${this.totalBudgetUsd.toFixed(2)}，不再派发「${label}」`);
    }
    this.legs += 1;
    this.log(`[${this.legs}] 发送「${label}」${resume ? '（续同一会话）' : '（新会话）'}`);
    this.emit('send', { label, text: prompt, resume, leg: this.legs });

    const runner = this._runner(killAt);
    this._currentRunner = runner;
    let result;
    try {
      result = await runner.run(prompt, resume ? this.sessionId : null, resume);
    } finally {
      this._currentRunner = null;
    }
    this.sessionId = result.sessionId;
    // 被 kill 的发次没有 result，costUsd 是 0 —— 但钱确实花了，退回估算记账，否则预算失真
    const billed = result.costUsd || result.costEstimate || 0;
    this.spentUsd += billed;
    this._lastResult = result;

    const est = result.costUsd ? '' : '（估算）';
    this.log(`    ${result.exitReason} · 水位 ${result.contextPeak.toLocaleString('en-US')} · `
      + `${result.durationS.toFixed(0)}s · $${billed.toFixed(4)}${est}`);
    // 每发就把错误正文落进 loop.log。原先只记 exitReason，实测四发全 error 的日志里
    // 只有四行 `error`，真因（503 无可用渠道）只存在于 .run/events/*.jsonl 里，
    // 而那是给人看的最后一道口 —— 提示语还让人「去看 loop.log」，看了也没有。
    if (result.error) this.log(`    ↳ ${briefLine(result.error)}`);
    if (result.pendingTasks?.length) {
      const names = result.pendingTasks.slice(0, 4).map((t) => t.description || t.task_id || '?').join('、');
      this.log(`    ⚠ ${result.pendingTasks.length} 个后台任务仍在飞: ${names}`);
    }
    this.emit('result', {
      label, leg: this.legs, exit_reason: result.exitReason,
      context_peak: result.contextPeak,
      duration_s: Math.round(result.durationS * 10) / 10,
      cost_usd: Math.round(billed * 1e4) / 1e4,
      cost_is_estimate: !result.costUsd,
      text: String(result.finalText || '').slice(-8000),
      session_id: result.sessionId,
      pending_tasks: result.pendingTasks || [],
    });
    this.saveState();
    this._checkAborted();          // 终止时执行者被杀，这一发的结果不再往下判
    return result;
  }

  // ── 交接 ───────────────────────────────────────────────────

  /**
   * 一次完整的上下文交接：[每 N 次：维护1 → 维护2] → 收尾提示词 → 快照 commit → 会话归零。
   * ⚠ 维护必须在收尾**之前**：整理记忆需要"当前会话还记得来龙去脉"。
   */
  async handoff(reason) {
    this.handoffs += 1;
    this.log(`── 第 ${this.handoffs} 次上下文交接（${reason}）──`);
    this.emit('handoff.start', { count: this.handoffs, reason });

    if (this.maintenanceEvery && this.handoffs % this.maintenanceEvery === 0) {
      this.maintenances += 1;
      this.log(`  第 ${this.handoffs} 次交接是 ${this.maintenanceEvery} 的倍数，先跑两轮记忆维护`);
      this.emit('maintenance.start', { count: this.maintenances });
      // 不设 killAt：维护本身就是在高水位下做的事
      await this.send(this.prompts.maintain_1, '定期维护提示词1', { resume: true });
      await this.send(this.prompts.maintain_2, '定期维护提示词2', { resume: true });
      this.emit('maintenance.done', { count: this.maintenances });
    }

    const wrap = await this.send(this.prompts.wrapup, '旧对话收尾提示词', { resume: true });

    // 收尾发进了黑洞（空 success）。实测只在续一个被 wall_timeout 杀掉的会话时出现。
    // ⚠ 兜底**不是重发同一段**（同一脏会话再续仍空），而是开新会话补做收尾
    if (wrap.exitReason === ExitReason.EMPTY_RESULT) {
      this.log('  ⚠ 收尾返回空（一个 turn 都没跑），会话已不可续');
      this.emit('wrapup.empty', { count: this.handoffs });
      this.sessionId = null;
      this.log('  改为在新会话里补一次收尾');
      await this.send(this.prompts.resume, '新对话开始提示词', { resume: false, killAt: this.hardKill });
      const retry = await this.send(this.prompts.wrapup, '旧对话收尾提示词（补做）', { resume: true });
      if (retry.exitReason === ExitReason.EMPTY_RESULT) {
        this.log('  ⚠ 补做的收尾同样返回空，本次交接没有记忆产出');   // 别再烧钱重试
      }
    }

    const sha = this.snapshotCommit(`handoff #${this.handoffs}`);
    if (sha) this.log(`  已打快照 commit ${sha}`);
    this.sessionId = null;         // 会话归零：下一发用「新对话开始提示词」开新进程
    this.emit('handoff.done', { count: this.handoffs, commit: sha });
  }

  // ── 人类介入 ───────────────────────────────────────────────

  /**
   * 叫人并等回答。原版在终端等 stdin；这里经面板（humanChannel）。
   * askHuman=false（原版 --no-ask）或没有可等的通道时立即停机 ——
   * 等一个不在场的人，等于把无人值守变成永久挂死。
   */
  async askHumanFor(run, judgement) {
    this.emit('need_human', {
      question: String(run.finalText || '').slice(-3000),
      needs: judgement.needsFromHuman, reason: judgement.reason,
    });
    if (!this.askHuman) {
      this.log('  未启用等待人类输入（不等人），停机');
      return '';
    }
    if (!this.humanChannel) {
      this.log('  没有可等待人类输入的通道，停机');
      return '';
    }
    const answer = String((await this.humanChannel(run, judgement)) || '').trim();
    this._checkAborted();
    this.emit('need_human.done', { answered: !!answer, text: answer });
    return answer;
  }

  // ── 主流程 ─────────────────────────────────────────────────

  async run() {
    this.ensureRepo();
    const started = Date.now() / 1000;
    // 开跑时的 HEAD：收尾时用它 diff 出「本轮改了哪些文件」（拿不到就不给成果摘要，不报错）
    this.startCommit = this._git(['rev-parse', '--short', 'HEAD'])[1] || '';
    this.log(`沙箱: ${this.spec.root}`);
    this.log(`记忆: ${this.spec.memoryDir}`);
    this.log(`提示词: ${this.prompts.source}`);
    this.log(`水位: 交接下限 ${this.handoffFloor.toLocaleString('en-US')} · `
      + `主动打断 ${this.handoffCeiling.toLocaleString('en-US')} · 硬上限 ${this.hardKill.toLocaleString('en-US')}`);
    if (this.extraDirs.length) this.log(`外部目录（对执行者可写）: ${this.extraDirs.length} 个`);

    let stop, needs = '';
    try {
      stop = await this.open();
      if (stop == null) [stop, needs] = await this.mainPhase();
    } catch (e) {
      if (e instanceof BudgetExceeded) {
        // 派发口拦下的：可能在开场、主循环或交接中途 —— 无论哪里都不再花钱
        this.log(`预算耗尽: ${e.message}`);
        [stop, needs] = [Stop.BUDGET, e.message];
      } else if (e instanceof LoopInterrupted) {
        this.log(`■ 人工终止: ${e.message}`);
        this.finishCommit = this.snapshotCommit('interrupted');
        [stop, needs] = [Stop.INTERRUPTED, e.message];
      } else {
        this.log(`异常停机: ${e.stack || e.message}`);
        [stop, needs] = [Stop.ERROR, e.message];
      }
    }

    const report = {
      stop, legs: this.legs, handoffs: this.handoffs, maintenances: this.maintenances,
      elapsed_s: Date.now() / 1000 - started, cost_usd: this.spentUsd,
      decisions: this.decisions, needs_from_human: needs,
    };
    // 成果摘要给界面用，**不能进 report 与 finished 事件**：那两处与原版逐字段对拍（多一个键就整片不一致）。
    // 单独落 .run/outcome.json，服务层读它挂到任务上。
    const outcome = this.collectOutcome(stop);
    if (outcome) {
      try { writeFileSync(path.join(this.spec.runDir, OUTCOME_FILE), JSON.stringify(outcome, null, 2), 'utf8'); }
      catch (e) { this.log(`  成果摘要落盘失败（不影响收尾）: ${e.message}`); }
    }
    this.outcome = outcome;
    this.saveState();
    this.log('\n' + renderReport(report));
    this.emit('finished', {
      stop, legs: this.legs, handoffs: this.handoffs, maintenances: this.maintenances,
      decisions: this.decisions, elapsed_s: Math.round(report.elapsed_s * 10) / 10,
      cost_usd: Math.round(this.spentUsd * 1e4) / 1e4, needs_from_human: needs,
    });
    writeFileSync(path.join(this.spec.runDir, 'report.json'), JSON.stringify({
      stop, legs: this.legs, handoffs: this.handoffs, maintenances: this.maintenances,
      decisions: this.decisions, elapsed_s: report.elapsed_s, cost_usd: this.spentUsd,
      needs_from_human: needs,
    }, null, 2), 'utf8');
    return report;
  }

  /** 开场：新项目发初始化 + 需求；续跑发新对话开始 + 需求。返回非 null 表示开场就该停机。 */
  async open() {
    // 从终端会话转入长程、且选了「续同一条对话」：不发初始化、不发新对话开始提示词，
    // 直接续那条已有的 Claude 会话 —— 上下文一字不丢，它记得刚才说过的每句话。
    //
    // ⚠ 第一发必须先声明规则变了：长程执行者跑在更严的权限白名单下
    //   （executorSettings），而这条对话是在终端的宽松规则下开始的。
    //   静默换规则会让它按旧印象去做现在做不了的事，然后在权限拒绝上反复撞墙。
    if (this.resumeSessionId) {
      this.sessionId = this.resumeSessionId;
      this.log(`续接终端会话 ${this.resumeSessionId.slice(0, 8)}…：不发初始化，声明运行方式后继续`);
      const first = this.requirementText
        ? `${MODE_SWITCH_NOTICE}\n\n【本次新增需求】\n${this.requirementText}`
        : MODE_SWITCH_NOTICE;
      await this.send(first, '运行方式变更声明', { resume: true, killAt: this.hardKill });
      return null;
    }

    if (this.skipInit) {
      this.log('断点续跑模式：跳过初始化提示词');
      await this.send(this.prompts.resume, '新对话开始提示词', { resume: false, killAt: this.hardKill });
      await this.send(this.requirementText, '新需求文档', { resume: true, killAt: this.hardKill });
      return null;
    }

    const init = await this.send(this.prompts.init, '初始化提示词', { resume: false, killAt: this.hardKill });

    // 初始化提示词要求"没开启或不确定就停下来告诉我怎么开启"，这里只关心它是不是卡住在等人。
    // ⚠ 与原版逐字一致地保留判据 looksLikeQuestion(init)。注意原版这里实际**永不触发**：
    //   runner 已把"完成 + 像提问"改写成 ASKED_HUMAN，而 looksLikeQuestion 要求 COMPLETED。
    //   这是原版的潜在缺陷，按 1:1 保留，是否修正需与原版同步决定。
    if (this.supervisor && looksLikeQuestion(init)) {
      const j = await this.supervisor.judge(init, '初始化记忆库');
      this.log(`  监督者: ${j.render()}`);
      this.emit('supervisor', {
        phase: 'init', verdict: j.verdict, confidence: j.confidence,
        reason: j.reason, needs_from_human: j.needsFromHuman,
      });
      if (j.decided) {
        this.decisions += 1;
        this.log(`  监督者代答: ${j.reply.slice(0, 80)}`);
        this.emit('supervisor.decided', { text: j.reply, reason: j.reason, confidence: j.confidence });
        await this.send(j.reply, '监督者代答', { resume: true, killAt: this.hardKill });
      } else if (j.needsHuman) {
        const answer = await this.askHumanFor(init, j);
        if (!answer) return Stop.NEEDS_HUMAN;
        await this.send(answer, '人类回复', { resume: true, killAt: this.hardKill });
      }
    }

    await this.send(this.requirementText, '需求文档', { resume: true, killAt: this.hardKill });
    return null;
  }

  /** 主循环：判断 → 继续 / 交接 / 叫人 / 收工。分支顺序与原版 _main_phase 逐条一致。 */
  async mainPhase() {
    let consecutiveErrors = 0;
    for (;;) {
      this._checkAborted();
      // 真正的拦截在 send 入口。这里再查一次是为了超支时省下一次监督者调用（审计 G26）
      if (this.spentUsd >= this.totalBudgetUsd) {
        return [Stop.BUDGET, `已花 $${this.spentUsd.toFixed(2)}，达到上限 $${this.totalBudgetUsd.toFixed(2)}`];
      }
      if (this.legs >= this.maxLegs) return [Stop.MAX_LEGS, ''];

      const last = this._lastResult;
      if (!last) return [Stop.ERROR, '没有可判断的执行者输出'];

      // 进程异常：连续三次才停，单次异常可能只是网络抖动。
      // ⚠ 在原会话里催继续重试，**不是交接**（审计 G11）；计数器在这之后立刻清零（G12）
      if (last.exitReason === ExitReason.ERROR) {
        consecutiveErrors += 1;
        // ⚠ 必须带上错误正文。Hitech 2026-09-18 实测：真因是「503 无可用渠道（模型
        //   claude-fable-5-1）」，重试 10 次全败，而停机只说「连续 3 次进程异常」——
        //   人看不出是换模型还是等一会儿，只能自己去翻 .run/events/*.jsonl。
        // 拿不到错误正文时**保持原版文案逐字不变**（38 个 parity 场景按字节比对 needs）；
        // 有正文才追加 —— 那种情况原版同样拿不到，不构成行为分歧。
        // 供应商侧故障（503 / 无渠道 / 限流）先自救：等待，再换模型。
        // 不这样做的后果实测过：CLI 内部已指数退避重试 10 次约 3 分钟，我们零等待又发 3 发，
        // 12 分钟全撞在同一个坏渠道上然后停机（Hitech 2026-09-18）。
        //
        // ⚠ 没有错误正文时**一律不介入**，走原版路径：原版就是拿不到正文照样重试 3 次，
        //   38 个 parity 场景按字节比对 sent/events，这里多等一次或少发一发都会红。
        //   自救只在"认出是供应商侧故障"时才启动 —— 那种情况原版同样只能干等着挂。
        const rec = last.error
          ? planRecovery({
            error: last.error,
            providerFailures: this.providerFailures + 1,
            triedModels: this.triedModels,
            available: await this.availableModels(),
          })
          : { action: 'stop', waitMs: 0, model: '', reason: '' };
        if (rec.action !== 'stop') {
          this.providerFailures += 1;
          this.log(`  自动恢复：${rec.reason}`);
          this.emit('recovery', { attempt: this.providerFailures, action: rec.action, reason: rec.reason, model: rec.model || '' });
          this.recoveries.push(rec.reason);
          if (rec.action === 'wait') await this.pauseSleep(rec.waitMs / 1000);
          else if (rec.action === 'switch_model') { this.model = rec.model; this.triedModels.push(rec.model); }
          this._checkAborted();          // 等待期间人可能已经终止
          consecutiveErrors = 0;         // 自救过就重新计数，别让等待被当成第 N 次失败
          await this.send(CONTINUE_PROMPT, '继续完成项目', { resume: true, killAt: this.killAt() });
          continue;
        }

        // 自动恢复无能为力（不是供应商侧故障，或手段用尽）→ 按原逻辑停机
        if (consecutiveErrors >= 3 || rec.reason) {
          const why = rec.reason || `连续 ${consecutiveErrors} 次进程异常${last.error ? `：${briefLine(last.error)}` : ''}`;
          return [Stop.ERROR, consecutiveErrors >= 3 && !rec.reason ? why : `连续 ${consecutiveErrors} 次进程异常：${rec.reason}`];
        }
        this.log(`  进程异常（第 ${consecutiveErrors} 次）${last.error ? `：${briefLine(last.error)}` : ''}，重试`);
        await this.send(CONTINUE_PROMPT, '继续完成项目', { resume: true, killAt: this.killAt() });
        continue;
      }
      consecutiveErrors = 0;

      // 人工打断 → 把人的话原样发下去，续同一会话。不问监督者：人已明确表了态。
      // 续同一 session 是关键：执行者记得自己被打断过
      if (last.exitReason === ExitReason.INTERRUPTED_BY_HUMAN) {
        if (!last.injectText) {
          this.log('  人工打断但未取到注入内容，停机');   // 不猜人的意图
          return [Stop.NEEDS_HUMAN, '已打断执行者，但没有取到注入的提示词'];
        }
        this.log(`  人工打断，注入: ${last.injectText.slice(0, 80)}`);
        this.emit('inject.applied', { text: last.injectText });
        await this.send(last.injectText, '人工注入', { resume: true, killAt: this.killAt() });
        continue;
      }

      // 费用刹车 → 停机，不交接：交接还要发收尾＋维护，那都是钱。把现场保住让人来看
      if (last.exitReason === ExitReason.COST_KILLED) {
        this.snapshotCommit('cost ceiling reached');
        return [Stop.BUDGET, `${last.error}。已结算 $${this.spentUsd.toFixed(2)}，上限 $${this.totalBudgetUsd.toFixed(2)}`];
      }

      // 水位触顶被打断 → 直接交接，不问监督者：输出本来就不完整，判断没有意义
      if (last.exitReason === ExitReason.BUDGET_KILLED) {
        await this.handoff(`运行中水位触顶 ${last.contextPeak.toLocaleString('en-US')}`);
        await this.send(this.prompts.resume, '新对话开始提示词', { resume: false, killAt: this.hardKill });
        continue;
      }

      // 一个 turn 都没跑。**绝不能交给监督者**：空输出最可能被判 continue，循环空转烧钱
      if (last.exitReason === ExitReason.EMPTY_RESULT) {
        this.emptyResults += 1;
        this.log(`  ⚠ 执行者返回空（第 ${this.emptyResults} 次），会话不可续，换新会话`);
        if (this.emptyResults >= 3) {
          // 换过会话仍连续空返回，不是脏会话能解释的（审计 G25）
          this.snapshotCommit('empty results');
          return [Stop.NEEDS_HUMAN, `执行者连续 ${this.emptyResults} 次返回空结果（一个 turn 都没跑），已换新会话仍未恢复`];
        }
        this.sessionId = null;
        await this.send(this.prompts.resume, '新对话开始提示词', { resume: false, killAt: this.hardKill });
        continue;
      }

      if (last.exitReason === ExitReason.HANG_KILLED || last.exitReason === ExitReason.WALL_TIMEOUT) {
        this.log(`  ${last.exitReason}${last.error ? `：${last.error}` : ''}，按交接处理`);
        await this.handoff(last.exitReason);
        await this.send(this.prompts.resume, '新对话开始提示词', { resume: false, killAt: this.hardKill });
        continue;
      }

      // 正常结束（含 ASKED_HUMAN / MAX_TURNS / 高水位完成）→ 交给监督者。
      // 没有监督者时由人接管这个判断（审计 G14：早先直接停机，人在场也没机会接管）
      if (!this.supervisor) {
        const answer = await this.askHumanFor(last, new Judgement({
          verdict: Verdict.NEEDS_HUMAN, confidence: 1.0,
          reason: '未配置监督者，由你判断这一发的输出',
          needsFromHuman: '若未完成，写下要它接着做什么；若已完成，直接留空停机',
        }));
        if (!answer) {
          this.log('  未配置监督者且无人接管，停机');
          return [Stop.NEEDS_HUMAN, '未配置监督者，需人工判断执行者输出'];
        }
        this.log('  收到人类判断，续跑');
        await this.send(answer, '人类回复', { resume: true, killAt: this.killAt() });
        continue;
      }

      const j = await this.supervisor.judge(last, '开发中');
      this.log(`  监督者: ${j.render()}`);
      this.emit('supervisor', {
        phase: 'main', verdict: j.verdict, confidence: j.confidence, reason: j.reason,
        needs_from_human: j.needsFromHuman, question: String(last.finalText || '').slice(-2000),
      });

      if (j.projectDone) {
        this.finishCommit = this.snapshotCommit('project done');   // 停机前保住最后一段工作（审计 G22）
        return [Stop.PROJECT_DONE, ''];
      }

      // 代答 → 原样发下去，续同一会话。不加"这是推断"的标注（用户明确选择）。
      // supervisor.decided **只在真代答时**发，带原文 —— 那是事后唯一能查证的线索（审计 G19）
      if (j.decided) {
        this.decisions += 1;
        this.log(`  监督者代答，续跑: ${j.reply.slice(0, 80)}`);
        this.emit('supervisor.decided', { text: j.reply, reason: j.reason, confidence: j.confidence });
        await this.send(j.reply, '监督者代答', { resume: true, killAt: this.killAt() });
        continue;
      }

      if (j.needsHuman) {
        const answer = await this.askHumanFor(last, j);
        if (!answer) {
          this.snapshotCommit('blocked on human');
          return [Stop.NEEDS_HUMAN, j.needsFromHuman];
        }
        // 原样发出，不加包装：编排器替人补一句解释会改变执行者对这句话权重的判断
        this.log('  收到人类回复，续跑');
        await this.send(answer, '人类回复', { resume: true, killAt: this.killAt() });
        continue;
      }

      // 未完成：水位过下限就先交接，否则直接催它继续
      if (last.contextPeak >= this.handoffFloor) {
        await this.handoff(`正常结束但水位 ${last.contextPeak.toLocaleString('en-US')} 已过 ${this.handoffFloor.toLocaleString('en-US')}`);
        await this.send(this.prompts.resume, '新对话开始提示词', { resume: false, killAt: this.hardKill });
        continue;
      }
      await this.send(CONTINUE_PROMPT, '继续完成项目', { resume: true, killAt: this.killAt() });
    }
  }

  // ── 暂停、注入、终止 ───────────────────────────────────────

  /** 暂停轮询的等待。单独成方法便于测试同步驱动（原版用线程测会占住沙箱目录）。 */
  pauseSleep(seconds) { return new Promise((r) => setTimeout(r, seconds * 1000)); }

  /**
   * 当前供应商支持的模型清单，供自动换模型用。查不到就返回空数组 ——
   * 那时 planRecovery 会退回"继续等待"，绝不凭名字规律拼一个不存在的模型。
   */
  async availableModels() {
    if (!this.modelLister) return [];
    try {
      const list = await this.modelLister();
      return Array.isArray(list) ? list : [];
    } catch (e) {
      this.log(`  查询可用模型失败（不影响自救，退回等待）: ${e.message}`);
      return [];
    }
  }

  /**
   * 暂停闸：.run/pause 存在就原地等，删掉才继续。**粒度是"一发"**：当前那发会跑完，
   * 停在下一次派发之前。想立刻停就先用 inject!.txt 打断，再建 pause。
   */
  async waitIfPaused(label) {
    if (!existsSync(this.pausePath)) return;
    let waited = 0;
    this.halted = true;
    this.log(`⏸ 暂停中（${this.pausePath} 存在），下一发「${label}」暂不派发`);
    this.log('   删掉该文件即继续。执行者已停在上一发结束处，不烧钱。');
    this.emit('paused', { label, path: this.pausePath });
    try {
      while (existsSync(this.pausePath) && !this.aborted) {
        await this.pauseSleep(PAUSE_POLL_S);
        waited += PAUSE_POLL_S;
        // 每 5 分钟报一次，否则一小时后回来看不出它是在等还是挂死了
        if (waited % 300 < PAUSE_POLL_S) this.log(`   仍在暂停，已等 ${(waited / 60).toFixed(0)} 分钟`);
      }
    } finally {
      this.halted = false;
    }
    this._checkAborted();
    this.log(`▶ 已继续（暂停 ${(waited / 60).toFixed(1)} 分钟），派发「${label}」`);
    this.emit('resumed', { label, paused_s: Math.round(waited * 10) / 10 });
  }

  /**
   * 取一次人工注入，有则返回 [提示词, 是否立即] 并删掉投件文件。
   * inject.txt 在下一个工具间隙生效；inject!.txt 或正文以 !! 开头则立即打断。
   * **先删再用**：宁可丢一次投件，也不要重复注入。
   */
  takeInject() {
    for (const [file, immediate] of [[this.injectPath, false], [this.injectNowPath, true]]) {
      if (!existsSync(file)) continue;
      let text;
      try { text = readFileSync(file, 'utf8').trim(); } catch { continue; }
      try { unlinkSync(file); } catch { /* 忽略 */ }
      if (!text) continue;
      if (text.startsWith('!!')) return [text.slice(2).trimStart(), true];
      return [text, immediate];
    }
    return null;
  }

  /** 面板「终止」：杀当前执行者整组，唤醒暂停与等人，本轮以 Stop.INTERRUPTED 停机并打快照。 */
  abort(reason = '用户在面板上终止') {
    if (this.aborted) return;
    this.aborted = reason;
    this._currentRunner?.abort?.();
  }
}

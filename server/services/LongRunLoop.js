/**
 * 长程编排：会话循环
 *
 * 移植自长程编排器 orchestrator/session_loop.py。**管上下文生命周期，不管任务内容** ——
 * 不拆任务、不定验证命令、不做判别力检查。执行者自己管 git、自己跑测试、
 * 自己判断做完没做完。
 *
 * 这是刻意的取舍：换来执行者不被干涉，代价是"假成功"没有机器拦截。
 */

import { writeFileSync, appendFileSync, mkdirSync, existsSync, readFileSync, unlinkSync } from 'fs';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import path from 'path';
import { ExitReason, looksLikeQuestion, LongRunRunner } from './LongRunRunner.js';
import { Verdict } from './LongRunSupervisor.js';
import { CONTINUE_PROMPT } from './LongRunPrompts.js';

/** 水位三档。必须 floor < ceiling < hardKill —— 原实现无校验，这里补上。 */
/** 正常结束且水位过此值 → 交接换新窗口 */
export const HANDOFF_FLOOR = 200_000;
/**
 * 运行中过此值 → 在工具间隙主动打断。
 * 定在 35 万而非 40 万，是为了给收尾提示词留出写记忆的窗口 ——
 * 收尾本身要读会话、写多个文件，很吃 token。
 */
export const HANDOFF_CEILING = 350_000;
/** 硬上限。到这里连收尾都来不及，直接 kill。 */
export const HARD_KILL = 400_000;
/** 每第 N 次交接，在收尾之前跑一轮记忆维护 */
export const MAINTENANCE_EVERY = 3;

/** 停止原因。 */
export const Stop = {
  PROJECT_DONE: 'project_done',
  NEEDS_HUMAN: 'needs_human',
  BUDGET: 'budget',
  MAX_LEGS: 'max_legs',
  ERROR: 'error',
};

/** 预算在派发口被拦下。 */
export class BudgetExceeded extends Error {
  constructor(message) { super(message); this.name = 'BudgetExceeded'; }
}

/**
 * 校验三档水位的顺序。
 * ⚠ 原实现**没有校验**：写反了会有奇怪行为（ceiling 低于 floor 会让每发刚开跑
 *   就被打断）。移植时补上这道，报错要说清怎么改。
 */
export function assertThresholds({ handoffFloor, handoffCeiling, hardKill }) {
  if (!(handoffFloor < handoffCeiling && handoffCeiling < hardKill)) {
    throw new Error(
      `水位三档必须满足 交接下限 < 主动打断 < 硬上限，实际 `
      + `${handoffFloor} / ${handoffCeiling} / ${hardKill}。\n`
      + `写反了会让每发刚开跑就被打断（ceiling 低于 floor）或收尾来不及（ceiling 贴着 hardKill）。`
    );
  }
}

export class LongRunLoop {
  /**
   * @param {object} o
   * @param {object} o.sandbox        LongRunSandbox 实例（已 verifyClean）
   * @param {object} o.prompts        loadPrompts() 的结果
   * @param {string} o.requirementText 需求文档全文（含参考清单）
   * @param {object} o.supervisor     Supervisor 实例；null 表示未配（会叫人）
   * @param {function} o.makeRunner   (killAt) => LongRunRunner，便于测试注入
   * @param {function} o.askHuman     (result, judgement) => Promise<string>，返回空表示停机
   * @param {function} o.emit         (kind, data) => void
   */
  constructor(o = {}) {
    this.spec = o.sandbox;
    this.prompts = o.prompts;
    this.requirementText = o.requirementText || '';
    this.supervisor = o.supervisor || null;
    this.makeRunner = o.makeRunner || ((killAt) => new LongRunRunner({
      cwd: this.spec.root, env: this.spec.childEnv(),
      eventsPath: path.join(this.spec.runDir, 'orchestrator.jsonl'),
      contextLimit: killAt || 0, costCeiling: this.costCeiling,
      extraDirs: this.spec.extraDirs,
      checkInject: () => this.takeInject(),
      emit: (k, d) => this.emit(k, d),
    }));
    this.askHuman = o.askHuman || (async () => '');
    this._emit = o.emit || (() => {});

    this.handoffFloor = o.handoffFloor ?? HANDOFF_FLOOR;
    this.handoffCeiling = o.handoffCeiling ?? HANDOFF_CEILING;
    this.hardKill = o.hardKill ?? HARD_KILL;
    assertThresholds(this);
    this.maintenanceEvery = o.maintenanceEvery ?? MAINTENANCE_EVERY;
    /** 总预算。默认极大 = 实际不限，由用户显式设小才生效。 */
    this.totalBudgetUsd = o.totalBudgetUsd ?? 1e9;
    this.costCeiling = o.costCeiling || 0;
    this.maxLegs = o.maxLegs ?? 0;
    this.skipInit = !!o.skipInit;

    this.sessionId = null;
    this.legs = 0;
    this.handoffs = 0;
    this.maintenances = 0;
    this.decisions = 0;
    this.spentUsd = 0;
    this._lastResult = null;
    this._sentLabels = [];      // 供测试核对发了哪些段、什么顺序
  }

  emit(kind, data = {}) {
    this._emit(kind, data);
    try {
      appendFileSync(path.join(this.spec.runDir, 'orchestrator.jsonl'),
        JSON.stringify({ ts: Date.now() / 1000, kind, ...data }) + '\n', 'utf8');
    } catch { /* 落盘失败不该拖垮运行 */ }
  }

  log(msg) { this.emit('log', { msg }); }

  _git(args) {
    try {
      const out = execFileSync('git', args, {
        cwd: this.spec.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      return [0, String(out).trim()];
    } catch (e) {
      return [e.status ?? 1, String(e.stdout || '') + String(e.stderr || '')];
    }
  }

  /**
   * 沙箱是 git 仓库，纯为交接前打快照。
   *
   * 判据是 `rev-parse --git-dir` 成功而非 `.git` 目录存在：删除失败会留下只含
   * objects 的残壳，此时目录在但仓库不可用。
   */
  ensureRepo() {
    const [code, out] = this._git(['rev-parse', '--git-dir']);
    if (code === 0 && out) return;
    this._git(['init', '-q']);
    this._git(['config', 'user.email', 'orchestrator@local']);
    this._git(['config', 'user.name', 'orchestrator']);
    const gi = path.join(this.spec.root, '.gitignore');
    if (!existsSync(gi)) writeFileSync(gi, '.run/\n.memory/\nnode_modules/\n', 'utf8');
    this._git(['add', '-A']);
    this._git(['commit', '-q', '-m', 'orchestrator: init sandbox', '--allow-empty']);
  }

  /**
   * 交接前打一个快照 commit。
   * 只是存点保命，不做任何成败判定 —— 执行者自己管版本，这个快照的作用是
   * "跑坏了能回退到任意一次交接点"。
   */
  snapshotCommit(label) {
    this._git(['add', '-A']);
    const [code, out] = this._git(['commit', '-q', '-m', `orchestrator snapshot: ${label}`]);
    if (code !== 0 && !out.includes('nothing to commit')) {
      this.log(`快照 commit 失败: ${out.slice(0, 200)}`);
      return null;
    }
    const [, sha] = this._git(['rev-parse', '--short', 'HEAD']);
    return sha || null;
  }

  /** 暂停开关：<沙箱>/.run/pause 存在就等。删掉才继续。 */
  get pausePath() { return path.join(this.spec.runDir, 'pause'); }
  get injectPath() { return path.join(this.spec.runDir, 'inject.txt'); }
  get injectNowPath() { return path.join(this.spec.runDir, 'inject!.txt'); }

  async waitIfPaused(label) {
    let announced = false;
    while (existsSync(this.pausePath)) {
      if (!announced) {
        // ⚠ 删掉 pause 之后发的是「继续完成项目」，执行者会**接着干** ——
        //   暂停不是终止。想让它停，打断时那句话别写成"停下别干了"。
        this.log(`已暂停（${path.basename(this.pausePath)} 存在），删掉它继续。待发: ${label}`);
        this.emit('paused', { label });
        announced = true;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (announced) {
      this.log('已继续');
      this.emit('resumed', { label });
    }
  }

  /**
   * 取一次人工注入。有则返回 [提示词, 是否立即]，并把投件文件删掉。
   *
   * 用文件投递而不是给看板开写入端点：看板是刻意只读的，加写入口会改变它的
   * 安全性质。文件投递还天然支持从任何地方投 —— 另一个终端、编辑器、脚本都行。
   *
   * 约定：往 .run/inject.txt 写自然语言即可，在**下一个工具间隙**打断。
   * 文件名以 ! 开头（inject!.txt）或正文首行是 !! 则**立即打断**，不等间隙 ——
   * 人要打断的场景往往正是"它在死循环里反复跑同一个 Bash"，那时永远等不到干净间隙。
   */
  takeInject() {
    for (const [file, immediate] of [[this.injectPath, false], [this.injectNowPath, true]]) {
      if (!existsSync(file)) continue;
      let text = '';
      try { text = readFileSync(file, 'utf8').trim(); } catch { continue; }
      // **先删再用**：宁可丢一次投件，也不要重复注入
      try { unlinkSync(file); } catch {}
      if (!text) continue;
      let imm = immediate;
      if (text.startsWith('!!')) { text = text.slice(2).trimStart(); imm = true; }
      this.emit('inject.applied', { immediate: imm, chars: text.length });
      return [text, imm];
    }
    return null;
  }

  /**
   * 发一段输入给执行者，等它跑完。
   *
   * label 只用于日志与看板，**不影响发出去的内容** —— 提示词一律原文。
   *
   * 派发前查预算：这是唯一能保证"超支后不再花钱"的位置。暂停闸也放这里，
   * 理由相同 —— 开场那两发与交接段的收尾、维护都不走主循环，只有派发口能覆盖
   * 全部派发点。
   */
  async send(prompt, label, { resume, killAt = null } = {}) {
    await this.waitIfPaused(label);

    if (this.spentUsd >= this.totalBudgetUsd) {
      throw new BudgetExceeded(
        `已花 $${this.spentUsd.toFixed(2)}，达到上限 $${this.totalBudgetUsd.toFixed(2)}，`
        + `不再派发「${label}」`);
    }
    this.legs += 1;
    this._sentLabels.push(label);
    this.emit('send', { label, resume, leg: this.legs, chars: prompt.length });

    const sid = resume ? this.sessionId : randomUUID();
    const result = await this.makeRunner(killAt).run(prompt, sid, resume);
    this.sessionId = result.sessionId || sid;

    // 被 kill 的发次没有 result 事件，costUsd 是 0 —— 但钱确实花了
    // （sekiro 那次 hang_killed 白记了 240 秒算力）。退回估算值记账，
    // 否则 spentUsd 会持续偏低，预算上限也就跟着失真。
    const billed = result.costUsd || result.costEstimate || 0;
    this.spentUsd += billed;
    this._lastResult = result;

    this.emit('result', {
      label, leg: this.legs, exitReason: result.exitReason,
      contextPeak: result.contextPeak, durationS: result.durationS,
      costUsd: Math.round(billed * 1e4) / 1e4,
      costIsEstimate: !result.costUsd,
      text: String(result.finalText || '').slice(-8000),
      sessionId: result.sessionId,
      pendingTasks: result.pendingTasks || [],
    });
    return result;
  }

  /**
   * 一次完整的上下文交接。
   *
   * 顺序：`[每 N 次：维护1 → 维护2] → 收尾提示词 → 快照 commit → 会话归零`
   *
   * ⚠ **维护必须放在收尾之前**：整理记忆需要"当前会话还记得来龙去脉"；
   *   放收尾之后的话，新会话已经不知道刚才发生了什么。这个顺序不能改。
   */
  async handoff(reason) {
    this.handoffs += 1;
    this.log(`── 第 ${this.handoffs} 次上下文交接（${reason}）──`);
    this.emit('handoff.start', { count: this.handoffs, reason });

    if (this.maintenanceEvery && this.handoffs % this.maintenanceEvery === 0) {
      this.maintenances += 1;
      this.log(`第 ${this.handoffs} 次交接是 ${this.maintenanceEvery} 的倍数，先跑两轮记忆维护`);
      this.emit('maintenance.start', { count: this.maintenances });
      // 两个维护提示词依次发出，各自等完整输出。
      // **不设 killAt**：维护本身就是在高水位下做的事，中途 kill 等于白发。
      await this.send(this.prompts.maintain_1, '定期维护提示词1', { resume: true });
      await this.send(this.prompts.maintain_2, '定期维护提示词2', { resume: true });
      this.emit('maintenance.done', { count: this.maintenances });
    }

    const wrap = await this.send(this.prompts.wrapup, '旧对话收尾提示词', { resume: true });

    // 收尾发进了黑洞（CLI 回空 success，一个 turn 都没跑）。
    //
    // 实测只在续一个 **wall_timeout** 杀掉的会话时出现：墙钟到点是无条件
    // terminate，不看工具是否在飞，会话被留在工具执行中途的脏状态，恢复即空返回。
    // 水位 kill 不会 —— 它明确等工具间隙。
    //
    // ⚠ 兜底**不是重发同一段**：同一个脏会话再续一次仍是空返回。改为开**新会话**
    //   补一次收尾 —— 代价是它丢了"当前会话的来龙去脉"，只能靠读记忆和工作树复述，
    //   写出来的东西比正常收尾薄。但这好过完全没有：交接的全部价值就在这一步。
    if (wrap.exitReason === ExitReason.EMPTY_RESULT) {
      this.log('⚠ 收尾返回空（一个 turn 都没跑），会话已不可续');
      this.emit('wrapup.empty', { count: this.handoffs });
      this.sessionId = null;                 // 强制开新会话
      this.log('改为在新会话里补一次收尾');
      await this.send(this.prompts.resume, '新对话开始提示词',
        { resume: false, killAt: this.hardKill });
      const retry = await this.send(this.prompts.wrapup, '旧对话收尾提示词（补做）',
        { resume: true });
      if (retry.exitReason === ExitReason.EMPTY_RESULT) {
        // 新会话也空 —— 不是脏会话的问题，别再烧钱重试
        this.log('⚠ 补做的收尾同样返回空，本次交接没有记忆产出');
      }
    }

    const sha = this.snapshotCommit(`handoff #${this.handoffs}`);
    if (sha) this.log(`已打快照 commit ${sha}`);

    // 会话归零：下一发用「新对话开始提示词」开新进程
    this.sessionId = null;
    this.emit('handoff.done', { count: this.handoffs, commit: sha });
  }

  /** 问人。返回空字符串表示停机等人。 */
  async askHumanFor(result, judgement) {
    this.log(`需要人介入: ${judgement.needsFromHuman || judgement.reason}`);
    this.emit('need_human.waiting', {
      reason: judgement.reason, needsFromHuman: judgement.needsFromHuman,
    });
    const answer = await this.askHuman(result, judgement);
    this.emit('need_human.done', { answered: !!answer, chars: (answer || '').length });
    return answer || '';
  }

  /** 跑完整一轮长程编排。 */
  async run() {
    this.ensureRepo();
    const started = Date.now() / 1000;
    this.log(`沙箱: ${this.spec.root}`);
    this.log(`记忆: ${this.spec.memoryDir}`);
    this.log(`水位: 交接下限 ${this.handoffFloor.toLocaleString()} · `
      + `主动打断 ${this.handoffCeiling.toLocaleString()} · 硬上限 ${this.hardKill.toLocaleString()}`);
    if (this.spec.extraDirs?.length) {
      // ⚠ --add-dir 给的是读写权限，启动时要提示，以免这一点被忘掉
      this.log(`外部目录（对执行者可写）: ${this.spec.extraDirs.length} 个`);
    }

    let stop, needs = '';
    try {
      stop = await this.open();
      if (stop == null) [stop, needs] = await this.mainPhase();
    } catch (e) {
      if (e instanceof BudgetExceeded) {
        // 派发口拦下的。可能发生在开场、主循环或交接中途 —— 无论哪里，
        // 都不再花钱，如实记为预算停机。
        this.log(`预算耗尽: ${e.message}`);
        stop = Stop.BUDGET; needs = e.message;
      } else {
        this.log(`异常停机: ${e.message}`);
        stop = Stop.ERROR; needs = e.message;
      }
    }

    const report = {
      stop, legs: this.legs, handoffs: this.handoffs,
      maintenances: this.maintenances, decisions: this.decisions,
      elapsedS: Math.round((Date.now() / 1000 - started) * 10) / 10,
      costUsd: Math.round(this.spentUsd * 1e4) / 1e4,
      needsFromHuman: needs,
    };
    this.emit('finished', report);
    try {
      mkdirSync(this.spec.runDir, { recursive: true });
      writeFileSync(path.join(this.spec.runDir, 'report.json'),
        JSON.stringify(report, null, 2) + '\n', 'utf8');
    } catch {}
    return report;
  }

  /**
   * 开场：新项目发初始化 + 需求；续跑发新对话开始 + 需求。
   * 返回非 null 表示开场阶段就该停机。
   */
  async open() {
    if (this.skipInit) {
      // 断点续跑：不需要初始化，直接让它读记忆接上，再给新需求
      this.log('断点续跑模式：跳过初始化提示词');
      await this.send(this.prompts.resume, '新对话开始提示词',
        { resume: false, killAt: this.hardKill });
      await this.send(this.requirementText, '新需求文档',
        { resume: true, killAt: this.hardKill });
      return null;
    }

    const init = await this.send(this.prompts.init, '初始化提示词',
      { resume: false, killAt: this.hardKill });

    // 初始化提示词明确要求："如果没开启，或者你不确定，停下来告诉我怎么开启，
    // 不要往下执行。" 所以这一步只关心一件事：它是不是卡住了在等人。
    // 记忆库没开就往下跑，整个跨会话机制都是空的。
    //
    // 刻意只看 looksLikeQuestion，不消耗一次完整判定 —— "初始化成功了吗"
    // 和"项目做完了吗"是两个不同的问题，用同一套判定去问语义不匹配。
    if (this.supervisor && looksLikeQuestion(init)) {
      const j = await this.supervisor.judge(init,
        { phase: '初始化记忆库', requirement: this.requirementText });
      this.log(`监督者: ${j.render()}`);
      this.emit('supervisor.decided', {
        phase: 'init', verdict: j.verdict, confidence: j.confidence,
        reason: j.reason, needsFromHuman: j.needsFromHuman,
      });
      if (j.decided) {
        this.decisions += 1;
        await this.send(j.reply, '监督者代答', { resume: true, killAt: this.hardKill });
      } else if (j.needsHuman) {
        const answer = await this.askHumanFor(init, j);
        if (!answer) return Stop.NEEDS_HUMAN;
        await this.send(answer, '人类回复', { resume: true, killAt: this.hardKill });
      }
    }

    await this.send(this.requirementText, '需求文档',
      { resume: true, killAt: this.hardKill });
    return null;
  }

  /** 主循环。 */
  async mainPhase() {
    let consecutiveErrors = 0;
    for (;;) {
      if (this.maxLegs && this.legs >= this.maxLegs) return [Stop.MAX_LEGS, ''];

      const last = this._lastResult;
      if (!last) return [Stop.ERROR, '没有可判断的执行者输出'];

      // ── 不必问监督者就能决定的几种 ──

      // 被主动打断（水位触顶）→ 直接交接，不必问监督者：
      // 它没说完话，问了也只能得到 continue
      if (last.exitReason === ExitReason.BUDGET_KILLED) {
        await this.handoff(`运行中水位触顶 ${last.contextPeak.toLocaleString()}`);
        await this.send(this.prompts.resume, '新对话开始提示词',
          { resume: false, killAt: this.hardKill });
        continue;
      }

      // 钱花超了该停机等人，不是交接
      if (last.exitReason === ExitReason.COST_KILLED) {
        this.snapshotCommit('cost ceiling reached');
        return [Stop.BUDGET, last.error || '运行中费用触及刹车线'];
      }

      // 人主动打断：把注入的话原样发出去（和「人类回复」走同一条不加包装的路）
      if (last.exitReason === ExitReason.INTERRUPTED_BY_HUMAN) {
        if (!last.injectText) {
          return [Stop.NEEDS_HUMAN, '已打断执行者，但没有取到注入的提示词'];
        }
        await this.send(last.injectText, '人工注入', { resume: true, killAt: this.hardKill });
        continue;
      }

      // 会话已经不可续（见 handoff 里的分析），换新会话重来
      if (last.exitReason === ExitReason.EMPTY_RESULT) {
        this.sessionId = null;
        await this.send(this.prompts.resume, '新对话开始提示词',
          { resume: false, killAt: this.hardKill });
        continue;
      }

      // 进程异常：连累三次就停机，不无限重试烧钱
      if (last.exitReason === ExitReason.ERROR) {
        consecutiveErrors += 1;
        if (consecutiveErrors >= 3) {
          return [Stop.ERROR, `连续 ${consecutiveErrors} 次进程异常: ${last.error}`];
        }
        await this.handoff(last.exitReason);
        await this.send(this.prompts.resume, '新对话开始提示词',
          { resume: false, killAt: this.hardKill });
        continue;
      }
      consecutiveErrors = 0;

      // 被 hang/墙钟杀掉：直接交接，同样不必问监督者
      if (last.exitReason === ExitReason.HANG_KILLED
          || last.exitReason === ExitReason.WALL_TIMEOUT
          || last.exitReason === ExitReason.MAX_TURNS) {
        await this.handoff(last.exitReason);
        await this.send(this.prompts.resume, '新对话开始提示词',
          { resume: false, killAt: this.hardKill });
        continue;
      }

      // ── 正常结束：问监督者 ──
      if (!this.supervisor) {
        // 早先这里直接 return，于是没配监督者时终端上什么提示都不出现
        return [Stop.NEEDS_HUMAN, '未配置监督者，需人工判断执行者输出'];
      }
      const j = await this.supervisor.judge(last,
        { phase: '主循环', requirement: this.requirementText });
      this.log(`监督者: ${j.render()}`);
      this.emit('supervisor.decided', {
        verdict: j.verdict, confidence: j.confidence, reason: j.reason,
        needsFromHuman: j.needsFromHuman,
      });

      if (j.projectDone) return [Stop.PROJECT_DONE, ''];

      if (j.decided) {
        this.decisions += 1;
        // 代答原样发出，不加包装
        await this.send(j.reply, '监督者代答', { resume: true, killAt: this.hardKill });
        continue;
      }

      if (j.needsHuman) {
        const answer = await this.askHumanFor(last, j);
        if (!answer) return [Stop.NEEDS_HUMAN, j.needsFromHuman || j.reason];
        await this.send(answer, '人类回复', { resume: true, killAt: this.hardKill });
        continue;
      }

      // continue：水位过下限就先交接，否则直接催它继续
      if (last.contextPeak >= this.handoffFloor) {
        await this.handoff(
          `正常结束但水位 ${last.contextPeak.toLocaleString()} 已过 ${this.handoffFloor.toLocaleString()}`);
        await this.send(this.prompts.resume, '新对话开始提示词',
          { resume: false, killAt: this.hardKill });
      } else {
        await this.send(CONTINUE_PROMPT, '催继续',
          { resume: true, killAt: this.handoffCeiling });
      }
    }
  }
}

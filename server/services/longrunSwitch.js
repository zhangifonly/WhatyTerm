/**
 * 长程 ⇄ 普通会话 切换的预检（纯逻辑，无 IO —— 事实由调用方查好传进来）。
 *
 * 为什么单独一层：两个方向的前置条件高度相似（CLI 在不在跑、目录是否就绪、上下文水位、
 * 有没有未提交的草稿），而失败的代价不对称 ——
 *   · 转长程时 CLI 还在跑 → 两个驱动者同时对一个 tmux 按键，屏幕会被搅乱
 *   · 转终端时长程还在跑 → 执行者被打断，当前这发的成果丢掉
 * 统一成一处判定，才能给出一致的提示，也才能单测覆盖。
 *
 * 判定分三档，语义不同，界面按档区分显示：
 *   blockers  不能切，按钮禁用
 *   warnings  能切，但后果要先说清
 *   suggest   推荐哪种续接方式（只在转长程时有意义）
 */

/** 转长程的两种续接方式 */
export const SWITCH_MODES = {
  RESUME: 'resume_session',   // 续同一条 Claude 对话，上下文一字不丢
  HANDOFF: 'handoff',         // 先让 CLI 把进度写进记忆再退出，长程开干净窗口读记忆接上
};

/**
 * 预检。
 *
 * @param {object} f  事实（调用方查好）
 * @param {'longrun'|'terminal'} f.to        要切到哪个模式
 * @param {'longrun'|'terminal'} f.from      当前模式
 * @param {boolean} f.rootExists             项目目录是否存在
 * @param {boolean} f.cliRunning             这个 tmux 里有没有交互式 CLI 在跑
 * @param {boolean} [f.cliBusy]              CLI 在跑且不在输入框（正在干活或停在确认框上）
 * @param {string} [f.cliType]               会话的 CLI 类型（claude/codex/...）；长程只能接 Claude
 * @param {boolean} f.longRunRunning         这个条目的长程任务是否在跑
 * @param {boolean} [f.otherLongRunOnRoot]   同一目录上是否另有长程在跑（别的条目）
 * @param {number|null} [f.contextPeak]      最后一发/当前会话的水位
 * @param {number} [f.handoffFloor]          交接下限（与水位交接同一套阈值）
 * @param {boolean} [f.hasSessionId]         有没有可续接的 claude 会话 id
 * @param {boolean} [f.hasMemory]            有没有记忆文件可续
 * @param {string} [f.pendingDraft]          输入框里未提交的草稿
 * @param {object|null} [f.interrupted]      上一轮被中断的信息（interruptedRun 的输出）
 * @returns {{ok:boolean, blockers:string[], warnings:string[], suggest:object|null}}
 */
export function switchPlan(input = {}) {
  const f = input || {};   // 默认参数只挡 undefined，显式传 null 会穿过去
  const to = f.to === 'longrun' ? 'longrun' : 'terminal';
  const blockers = [];
  const warnings = [];

  if (!f.rootExists) blockers.push('找不到这个条目的项目目录');
  if (f.from === to) blockers.push(`已经是${to === 'longrun' ? '长程' : '终端'}模式了`);

  if (to === 'longrun') {
    // ⚠ CLI 在跑**不是**拦截理由 —— 两种续接方式本来就都会先让它退出：
    //   交接方式先写记忆再 /quit；续同一条对话方式直接 /quit（对话由长程 --resume 续上，不丢）。
    //   v1.4.42 把「CLI 在跑」写成了硬拦截，而普通会话里 CLI 几乎总在跑 ——
    //   实测 35 个会话 0 个能转长程，专门处理这种情况的交接向导被挡在后面永远走不到。
    //   真正该拦的只有「它正在干活」（不打断）和「输入框有草稿」（交接/退出时会拒绝，不如先说）。
    // 长程的执行者是 Claude Code。别的 CLI 的会话转不过去：对话续不过去，交接用的 Auto Memory
    // 也是 Claude 的机制。更危险的是「续同一条对话」会去目录里找 Claude 的对话记录 ——
    // 这个目录以前跑过 Claude 的话，会续上一条**不相干的旧对话**。所以直接说清楚，
    // 而不是用"在忙"这种错误理由拦（空闲判定按 Claude 输入框写，别的 CLI 永远判成在忙）。
    const nonClaude = f.cliType && f.cliType !== 'claude';
    if (nonClaude) {
      blockers.push(`长程的执行者是 Claude Code，这是 ${f.cliType} 会话：对话续不过去，交接用的 Auto Memory 也是 Claude 的机制。`
        + '可以在这个项目目录新开一个 Claude 会话后再转长程');
    } else if (f.cliBusy) {
      blockers.push('CLI 不在空闲的输入框（在干活、停在确认框上，或输入框里开着菜单），等它回到输入框再转（不打断它）');
    } else if (f.cliRunning && f.pendingDraft) {
      blockers.push(`输入框里有未提交的内容「${String(f.pendingDraft).slice(0, 24)}」，先发出去或清掉再转`);
    } else if (f.cliRunning) {
      warnings.push('切换时会先让这个会话里的 CLI 退出：交接方式先写记忆再退，续同一条对话方式直接退（对话由长程接着续）');
    }
    if (f.otherLongRunOnRoot) blockers.push('同一个项目目录上已经有别的长程在跑');
    // ⚠ 这里**不查需求**：需求在下一步的长程弹窗里填（续同一条对话时还可以留空）。
    //   v1.4.42 在这里用「有没有 .memory」当需求判据，而 35 个项目里只有 1 个有 .memory。
  } else {
    // 长程还在跑就切回终端，会打断执行者、丢掉当前这发的成果。要人先明确停下。
    if (f.longRunRunning) blockers.push('长程还在跑。先点「停下当前这发」，等它收尾后再转终端');
    if (f.pendingDraft) {
      warnings.push(`输入框里有未提交的内容「${String(f.pendingDraft).slice(0, 24)}」，切换后它不会被发送`);
    }
  }
  if (f.interrupted?.interrupted) {
    warnings.push(`上一轮没有正常收工（跑了 ${f.interrupted.legs} 发）。切换不影响记忆与快照，续跑能接上`);
  }

  const suggest = to === 'longrun' && !(f.cliType && f.cliType !== 'claude') ? suggestResume(f) : null;
  // 推荐续接但水位已高时，把代价说出来：续了马上又要交接，等于白续
  if (suggest?.mode === SWITCH_MODES.RESUME && overFloor(f)) {
    warnings.push('水位已接近交接线，续同一条对话后可能很快就要交接一次');
  }

  return { ok: blockers.length === 0, blockers, warnings, suggest };
}

const overFloor = (f) => typeof f.contextPeak === 'number' && typeof f.handoffFloor === 'number'
  && f.contextPeak >= f.handoffFloor;

/**
 * 转长程时推荐哪种续接方式。阈值沿用水位交接那一套（不另立标准）：
 * 水位还宽裕就续同一条对话（上下文一字不丢），已到交接线就先交接再开干净窗口
 * —— 续了也马上要交接，不如现在就换。
 */
export function suggestResume(input = {}) {
  const f = input || {};
  const options = [
    { mode: SWITCH_MODES.RESUME, label: '续同一条对话', detail: '上下文一字不丢，执行者记得你刚才说过的每句话' },
    { mode: SWITCH_MODES.HANDOFF, label: '交接后开新对话', detail: '先让它把进度写进记忆再退出，长程从干净窗口读记忆接上' },
  ];
  if (!f.hasSessionId) {
    return { mode: SWITCH_MODES.HANDOFF, reason: '找不到可接续的 claude 会话，只能交接后开新对话', options, forced: true };
  }
  if (typeof f.contextPeak !== 'number' || typeof f.handoffFloor !== 'number') {
    return { mode: SWITCH_MODES.HANDOFF, reason: '取不到当前水位，稳妥起见交接后开新对话', options };
  }
  const peak = f.contextPeak.toLocaleString('en-US');
  const floor = f.handoffFloor.toLocaleString('en-US');
  return overFloor(f)
    ? { mode: SWITCH_MODES.HANDOFF, reason: `水位 ${peak} 已到交接下限 ${floor}，先交接再开新对话`, options }
    : { mode: SWITCH_MODES.RESUME, reason: `水位 ${peak} 低于交接下限 ${floor}，续同一条对话不丢上下文`, options };
}

export default { switchPlan, suggestResume, SWITCH_MODES };

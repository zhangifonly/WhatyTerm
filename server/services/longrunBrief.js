/**
 * 长程的精简快照 —— 给手机用（纯函数，无 IO，可单测）。
 *
 * 为什么不直接发看板：看板是给电脑大屏的，带全部时间线、过程明细、编排日志。
 * 实测小项目 jsonfmt2 一份就 96 KB，ERP 那轮 4876 条事件的更大；手机上一变化就拉一次，
 * 流量和渲染都扛不住。手机要的只是：它在干嘛、在不在等我、等我什么、最近做了什么、收工结论。
 *
 * 最要紧的一条是**问题原文**：`longrun:task` 摘要是全局广播，里面有「在不在等你」，
 * 但问题本身只在看板的 need_human 里 —— 不给它，手机上就只能看到"在等你"却不知道等什么。
 */

/** 最近进展给几条。手机一屏放得下、又足够看出"最近在干什么" */
export const RECENT_N = 10;
/** 每条进展正文截到多长。完整内容在电脑上看；手机上只要能看出是哪一步 */
export const BODY_MAX = 240;
/** 问题原文的上限：要给足，这是手机上唯一的判断依据，但防止一个超长问题把快照撑大 */
export const QUESTION_MAX = 4000;

const cut = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * 压成手机用的精简快照。
 *
 * @param {object} task  LongRunTask.toJSON() 的结果（全局广播里那份）
 * @param {object|null} board  看板快照 LongRunBoard.snapshot()；服务重启后可能没有
 * @returns {object}
 */
export function longRunBrief(task, board) {
  const t = task || {};
  const b = board || {};
  const awaiting = !!t.awaitingHuman;
  const nh = b.need_human || null;

  // 只取主时间线（不含过程明细 trace），最近的在后，与电脑上阅读顺序一致
  const recent = (Array.isArray(b.timeline) ? b.timeline : [])
    .filter((e) => e && e.stream !== 'trace')
    .slice(-RECENT_N)
    .map((e) => ({ at: e.at, role: e.role, label: e.label, head: cut(e.head, 120), body: cut(e.body, BODY_MAX) }));

  const ctx = b.context || {};
  return {
    taskId: t.id || '',
    sessionId: t.sessionId || null,
    title: b.title || t.sandboxName || '',
    state: t.state || 'unknown',              // running | done | failed
    awaitingHuman: awaiting,
    // ⚠ 问题只在真的在等时给：need_human 在回答后会被清掉，但广播与看板之间有时序差，
    //   以 awaitingHuman 为准，免得手机上出现一个"已经答过的问题"让人再答一遍
    needHuman: awaiting && nh ? {
      needs: cut(nh.needs, 500),
      reason: cut(nh.reason, 1000),
      question: cut(nh.question, QUESTION_MAX),
    } : null,
    paused: !!(t.halted || b.paused),
    pauseArmed: !!t.pauseArmed,
    aborted: t.aborted || '',
    legs: b.legs ?? t.legs ?? 0,
    handoffs: b.handoffs ?? t.handoffs ?? 0,
    decisions: b.decisions ?? t.decisions ?? 0,   // 监督者代你作答的次数，手机上也要看得见
    spentUsd: Number(b.spent_usd ?? t.costUsd ?? 0),
    runningCost: Number(b.running_cost ?? 0),    // 进行中那一发的估算，与已结算分开显示
    context: { occupied: ctx.occupied || 0, peak: ctx.peak || 0, limit: ctx.limit || 0 },
    currentLabel: b.current_label || t.lastLabel || '',
    elapsedS: b.elapsed_s ?? 0,
    recent,
    // 收工结论：交给前端共享的 longrunAdvice.js 渲染，与电脑上同一套说法
    report: t.report || null,
    finished: b.finished || null,
    outcome: t.outcome || null,
  };
}

export default { longRunBrief, RECENT_N, BODY_MAX, QUESTION_MAX };

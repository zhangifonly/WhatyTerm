/**
 * 长程任务面板：事件 → 显示条目 / 运行态（纯逻辑，可单测）
 *
 * 事件类型两类：
 *   编排层（loop）：send / result / handoff.* / maintenance.* / supervisor.decided /
 *                  need_human.* / inject.applied / paused / resumed / wrapup.empty /
 *                  finished / log / state / error
 *   执行层（runner 发出、loop 加 exec. 前缀后落盘，与原版一致）：exec.context / exec.text /
 *                  exec.thinking / exec.tool / exec.tool_result / exec.tasks.waiting /
 *                  exec.tasks.timeout / exec.inject.waiting / exec.inject.sent
 *
 * ⚠ **不认识的类型不能静默丢弃**。原编排器看板有过 exec.text 一直在发却从未上屏，
 *   丢了 139 条执行者旁白才被发现 —— 表现为"执行者只有最终答案、没有过程"。
 *   所以这里对未知类型走兜底样式照样显示。
 */

/** 水位预设。README 原话：默认值按较小窗口定，跑 1M 窗口的模型偏保守 */
export const THRESHOLD_PRESETS = {
  standard: { label: '标准（按 400k 窗口）', handoffFloor: 200000, handoffCeiling: 350000, hardKill: 400000 },
  long: { label: '1M 窗口（少交接、更贵）', handoffFloor: 500000, handoffCeiling: 800000, hardKill: 900000 },
};

/** 停机原因的人话 */
export const STOP_TEXT = {
  project_done: '项目完成',
  needs_human: '需要人介入',
  budget: '预算耗尽',
  max_legs: '达到发次上限',
  error: '异常停机',
};

/** 退出原因的人话（runner 的 ExitReason） */
export const EXIT_TEXT = {
  completed: '正常结束',
  completed_high_context: '正常结束（水位高）',
  budget_killed: '水位触顶被打断',
  cost_killed: '费用刹车',
  interrupted_by_human: '人工打断',
  hang_killed: '静默超时被杀',
  wall_timeout: '墙钟超时',
  max_turns: '撞轮数上限',
  empty_result: '空返回（一个 turn 都没跑）',
  asked_human: '停下来提问',
  error: '进程异常',
};

/** 这些只驱动运行态（水位条等），不进时间线 —— 每条 assistant 消息都发一次，太密 */
const HIDDEN = new Set(['exec.context', 'state']);

/** 过程明细：默认折成单行，可整体隐藏 */
const TRACE = new Set(['exec.thinking', 'exec.tool', 'exec.tool_result', 'exec.text']);

const fmtTokens = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n || 0));
const clip = (s, n = 160) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n) + '…' : t; };

/**
 * @returns {{lane:'timeline'|'trace'|'hidden', icon:string, title:string, detail:string, tone:string, full:string}}
 *   detail 是折叠时的一行摘要；full 是展开后的完整内容（执行者原话等），缺省同 detail
 */
export function describeEvent(ev) {
  const k = ev?.kind || '';
  if (HIDDEN.has(k)) return { lane: 'hidden', icon: '', title: '', detail: '', tone: 'muted', full: '' };
  const lane = TRACE.has(k) ? 'trace' : 'timeline';
  const d = (icon, title, detail = '', tone = 'info', full = '') =>
    ({ lane, icon, title, detail, tone, full: full || detail });

  switch (k) {
    case 'send': return d('➤', `发送「${ev.label}」`, ev.resume ? '续同一会话' : '新会话');
    case 'result': return d(ev.exitReason === 'completed' ? '✓' : '⚠',
      `${ev.label}：${EXIT_TEXT[ev.exitReason] || ev.exitReason}`,
      `水位 ${fmtTokens(ev.contextPeak)} · ${Math.round(ev.durationS || 0)}s · $${Number(ev.costUsd || 0).toFixed(4)}`
        + (ev.costIsEstimate ? '（估算）' : ''),
      ev.exitReason === 'completed' ? 'ok' : 'warn',
      [ev.text ? `执行者说：\n${ev.text}` : '',
        ev.pendingTasks?.length ? `\n⚠ ${ev.pendingTasks.length} 个后台任务仍在飞` : '']
        .join('') || '');
    case 'handoff.start': return d('⇄', `第 ${ev.count} 次上下文交接`, ev.reason || '', 'warn');
    case 'handoff.done': return d('⇄', `交接完成`, ev.commit ? `快照 ${ev.commit}` : '未打快照', 'ok');
    case 'maintenance.start': return d('🧹', `记忆维护开始（第 ${ev.count} 轮）`);
    case 'maintenance.done': return d('🧹', '记忆维护完成', '', 'ok');
    case 'wrapup.empty': return d('⚠', '收尾返回空，改在新会话补做', '', 'warn');
    case 'supervisor.decided': return d('⚖', `监督者：${ev.verdict}（${Number(ev.confidence || 0).toFixed(2)}）`,
      clip(ev.reason || ev.needsFromHuman), ev.verdict === 'needs_human' ? 'warn' : 'info',
      [ev.reason, ev.needsFromHuman && `需要人：${ev.needsFromHuman}`].filter(Boolean).join('\n'));
    case 'need_human.waiting': return d('✋', '等你回答', clip(ev.needsFromHuman || ev.reason), 'err');
    case 'need_human.done': return d('✋', ev.answered ? '已收到回答' : '无人回答，停机', '', ev.answered ? 'ok' : 'warn');
    case 'inject.applied': return d('✎', ev.immediate ? '注入（立即打断）已读到' : '注入已读到', `${ev.chars} 字`);
    case 'paused': return d('⏸', '已暂停', `待发：${ev.label}`, 'warn');
    case 'resumed': return d('▶', '已继续', '', 'ok');
    case 'finished': return d('■', `收工：${STOP_TEXT[ev.stop] || ev.stop}`,
      `${ev.legs} 发 · 交接 ${ev.handoffs} · $${Number(ev.costUsd || 0).toFixed(2)}`
        + (ev.needsFromHuman ? ` · ${clip(ev.needsFromHuman)}` : ''),
      ev.stop === 'project_done' ? 'ok' : 'warn');
    case 'error': return d('✖', '服务异常', clip(ev.message), 'err');
    case 'log': return d('·', clip(ev.msg, 240), '', 'muted');
    default: return describeExec(ev, d);
  }
}

/** 执行层事件（exec.*）与兜底。 */
function describeExec(ev, d) {
  switch (ev.kind) {
    case 'exec.thinking': return d('💭', clip(ev.text, 120), '', 'muted', ev.text);
    case 'exec.text': return d('💬', clip(ev.text, 200), '', 'info', ev.text);
    case 'exec.tool': return d('🔧', (ev.names || []).join(', '), '', 'muted');
    case 'exec.tool_result': return d('↩', ev.name || '工具返回', clip(ev.text, 120), 'muted', ev.text);
    case 'exec.tasks.waiting': return d('⏳', `等 ${ev.count} 个后台 agent 收尾`, `上限 ${Math.round(ev.limit)}s`, 'warn');
    case 'exec.tasks.timeout': return d('⏳', `后台 agent 等待超时（${ev.count} 个没收尾）`, `已等 ${ev.waited}s`, 'warn');
    case 'exec.inject.waiting': return d('⏳', '注入已取到，等工具间隙再打断', clip(ev.text, 120), 'warn', ev.text);
    case 'exec.inject.sent': return d('✎', ev.immediate ? '已立即打断执行者' : '已在工具间隙打断执行者', '', 'warn');
    default:
      // 兜底：未知类型照样显示，绝不静默丢弃
      return d('•', ev.kind || '(无类型事件)', clip(JSON.stringify(stripMeta(ev)), 160), 'muted');
  }
}

function stripMeta(ev) {
  const { kind, seq, ts, taskId, ...rest } = ev || {};
  return rest;
}

/** 从服务端快照建运行态（订阅/刷新时用）。 */
export function liveFromTask(task) {
  if (!task) return null;
  return {
    state: task.state || 'running',
    occupied: task.occupied || 0,
    peak: task.contextPeak || 0,
    costUsd: task.costUsd || 0,
    legs: task.legs || 0,
    handoffs: task.handoffs || 0,
    lastLabel: task.lastLabel || '',
    // 两个状态要分开：pauseArmed = 闸已挂上（pause 文件在）；paused = 真停在派发口。
    // 闸挂上时当前这发照常跑完才停，这段时间只有 pauseArmed，没有 paused
    pauseArmed: !!(task.pauseArmed ?? task.paused),
    paused: !!task.halted,
    awaiting: task.awaitingHuman ? { reason: '', needs: '' } : null,
    stop: task.report?.stop || '',
    needsFromHuman: task.report?.needsFromHuman || '',
    hardKill: task.thresholds?.hardKill || 0,
  };
}

/**
 * 用一条事件推进运行态。纯函数，返回新对象。
 * 快照里的费用来自服务端 loop 实账；这里按 result 累加只是为了两次 status 之间也能动。
 */
export function reduceLive(live, ev) {
  if (!live || !ev) return live;
  const n = { ...live };
  switch (ev.kind) {
    case 'exec.context':
      n.occupied = ev.occupied || 0;
      n.peak = Math.max(n.peak, ev.peak || 0);
      break;
    // 每发由 loop 的 send 开始：新进程的水位从头算
    case 'send': n.lastLabel = ev.label || n.lastLabel; n.occupied = 0; break;
    case 'result':
      n.legs = ev.leg ?? n.legs;
      n.costUsd = Math.round((n.costUsd + Number(ev.costUsd || 0)) * 1e4) / 1e4;
      n.peak = Math.max(n.peak, ev.contextPeak || 0);
      break;
    case 'handoff.done': n.handoffs = ev.count ?? n.handoffs; break;
    case 'paused': n.paused = true; n.pauseArmed = true; break;
    case 'resumed': n.paused = false; n.pauseArmed = false; break;
    case 'need_human.waiting':
      n.awaiting = { reason: ev.reason || '', needs: ev.needsFromHuman || '' };
      break;
    case 'need_human.done': n.awaiting = null; break;
    case 'finished':
      n.stop = ev.stop || '';
      n.needsFromHuman = ev.needsFromHuman || '';
      n.state = ev.stop === 'project_done' ? 'done' : 'failed';
      n.awaiting = null;
      n.costUsd = ev.costUsd ?? n.costUsd;       // 收工报告是权威实账
      break;
    case 'state': n.state = ev.state || n.state; break;
    case 'error': n.state = 'failed'; break;
    default: break;
  }
  return n;
}

/** 水位条：占用 / 硬上限。分母用 hardKill（原编排器看板口径）。 */
export function waterlinePercent(live) {
  if (!live?.hardKill) return 0;
  return Math.max(0, Math.min(100, Math.round((live.occupied / live.hardKill) * 100)));
}

/** 三档水位是否有序（前端先挡一道，服务端 assertThresholds 还会再挡） */
export function thresholdError({ handoffFloor, handoffCeiling, hardKill }) {
  const f = Number(handoffFloor), c = Number(handoffCeiling), h = Number(hardKill);
  if (![f, c, h].every((x) => Number.isFinite(x) && x > 0)) return '三档水位都要填正整数';
  if (!(f < c && c < h)) return '必须 交接下限 < 主动打断 < 硬上限（写反会让每发刚开跑就被打断）';
  return '';
}

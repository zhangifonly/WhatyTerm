/**
 * 上下文水位交接（借鉴长程编排器 05 节「上下文交接」）
 *
 * 编排器：读被编排子进程的 message.usage，水位达阈值就 kill→写记忆→开新会话。
 * WebTmux 不同——监控的是别人已在跑的交互会话，不能 kill、不能替它开会话、
 * 不能替它写记忆。所以「交接」在这里被重定义为：**趁自动压缩前，让会话自己
 * 把进度/决定/下一步写进记忆再继续**，压缩后新上下文能靠 MEMORY.md 接上。
 *
 * 水位来源（双口径，见 readContextWaterline）：
 *   ① Claude Code 底栏 "Context left until auto-compact: N%" —— 真实、零估算。
 *      N 越小越危险，故内部统一转成 usedPercent = 100 - N（已用百分比）。
 *   ② 拿不到百分比的 CLI（Codex 等）：本模块不臆造水位，返回 null 交回上层，
 *      由粗略信号（时长/轮数）另行处理，绝不拿假数字触发交接。
 *
 * 阈值（百分比口径，对齐编排器 35万/40万≈上限87.5% 的比例关系）：
 *   WARN_USED_PCT   触及即右栏告警、建议手动收尾（不自动按键）
 *   HANDOFF_USED_PCT 触及且会话空闲时，自动发一次收尾指令（会话级只发一次）
 */

// 已用百分比阈值。Claude 默认 auto-compact 阈值本身就在剩余较低时触发，
// 我们要赶在它之前给出写记忆的窗口，所以 HANDOFF 定得比压缩点更早。
export const WARN_USED_PCT = 80;      // 剩余 ≤20% → 告警
export const HANDOFF_USED_PCT = 88;   // 剩余 ≤12% → 空闲时自动收尾（留窗口写记忆）

// 收尾指令：让会话把跨压缩仍有价值的东西写进记忆，再自己继续。
// 措辞刻意具体（对齐 提示词.txt 的「旧对话收尾」段），避免只写一句空话。
export const HANDOFF_PROMPT =
  '上下文快到自动压缩了。请先把跨压缩后仍需要的内容写进项目记忆（Auto Memory）：' +
  '当前任务进度、已确认的结论与关键决定、尚未解决的问题、下一步最具体的行动；' +
  '写完后继续原任务。';

/**
 * 从终端文本解析「已用上下文百分比」。
 * @returns {number|null} 0~100 的已用百分比；解析不到返回 null（不臆造）。
 */
export function readContextWaterline(terminalContent) {
  if (!terminalContent) return null;
  // Claude Code 底栏："Context left until auto-compact: 23%"
  // 允许大小写/空白差异；只取最后一次出现（底栏是最新帧）。
  const re = /Context left until auto-compact:\s*(\d{1,3})\s*%/gi;
  let m, last = null;
  while ((m = re.exec(terminalContent)) !== null) last = m[1];
  if (last === null) return null;
  const left = Math.max(0, Math.min(100, parseInt(last, 10)));
  return 100 - left; // 转成已用
}

// 用户开关的三态（session.waterlineMode）：
//   'off'  完全不管，连告警都不出
//   'warn' 到线只右栏告警，永不自动按键（即便空闲）
//   'auto' 默认——空闲且到交接线就自动发收尾指令
export const WATERLINE_MODES = ['off', 'warn', 'auto'];
export const DEFAULT_WATERLINE_MODE = 'auto';

/**
 * 水位决策（纯函数，无 IO）。
 * @param {object} p
 * @param {number|null} p.usedPercent  已用百分比（readContextWaterline 的输出）
 * @param {boolean} p.isIdle           会话是否空闲（运行中/确认框中一律不打断）
 * @param {boolean} p.alreadyHandedOff 本会话是否已发过收尾指令（会话级只发一次）
 * @param {string}  [p.mode]           用户开关：off/warn/auto（封顶，默认 auto）
 * @returns {{level:'none'|'warn'|'handoff', usedPercent:number|null, reason:string}}
 */
export function decideWaterlineAction({ usedPercent, isIdle, alreadyHandedOff, mode = DEFAULT_WATERLINE_MODE }) {
  // 开关关闭：水位完全不参与决策。
  if (mode === 'off') {
    return { level: 'none', usedPercent: typeof usedPercent === 'number' ? usedPercent : null, reason: '水位交接已关闭' };
  }
  if (typeof usedPercent !== 'number') {
    return { level: 'none', usedPercent: null, reason: '无水位读数' };
  }
  if (usedPercent < WARN_USED_PCT) {
    return { level: 'none', usedPercent, reason: `水位 ${usedPercent}% 充足` };
  }
  // 达到交接线、且会话空闲、且还没发过、且开关为 auto —— 才自动收尾。
  // 'warn' 模式给用户封顶：到线也只告警不按键。运行中/确认框中（!isIdle）同样不打断。
  if (mode === 'auto' && usedPercent >= HANDOFF_USED_PCT && isIdle && !alreadyHandedOff) {
    return { level: 'handoff', usedPercent, reason: `水位 ${usedPercent}% ≥ ${HANDOFF_USED_PCT}%，空闲，自动发收尾` };
  }
  // 其余（80~88，或已交接过，或不空闲，或 warn 模式）：只告警、不按键。
  const why = mode === 'warn' ? '（仅告警模式）' : (alreadyHandedOff ? '（已交接过，仅告警）' : '');
  return { level: 'warn', usedPercent, reason: `水位 ${usedPercent}% 偏高${why}` };
}

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

// ① 收尾指令：让会话把跨压缩仍有价值的东西写进记忆。
// 措辞对齐 Auto Memory 手册「旧对话收尾」段的七项，避免只写一句空话。
// ⚠️ 刻意不带「写完后继续原任务」——写完要走 /compact，不是接着干，
//    避免它写完记忆又埋头干活、把刚腾出的窗口重新填满。
export const HANDOFF_PROMPT =
  '上下文快到自动压缩了，先收尾。请把跨压缩后仍有价值的内容写进项目记忆（Auto Memory）：' +
  '当前任务进度、已确认的结论、做了哪些关键决定及其原因或证据、' +
  '尝试过但失败的方案及原因、修改了哪些关键文件、当前测试结果、' +
  '尚未解决的风险、下一步最具体的行动。写完后告诉我更新了哪些记忆文件即可，先不要继续原任务。';

/**
 * ①b 转长程前的交接指令（用户 2026-09-18 给的文案）。
 *
 * 与上面那条的区别：水位版是"快到自动压缩了，先保命"，收尾后同一个会话继续干；
 * 这条是"这一段到此为止，接下来换长程无人值守接手"，所以多要两样回执：
 * 每个文件改了什么（人要能核）、下一会话从哪一项开始（直接预填进长程的新增需求）。
 */
export const LONGRUN_HANDOFF_PROMPT =
  '这个阶段先收尾。请检查本段会话，把跨会话后仍然有价值的内容同步进 Auto Memory，包括：\n' +
  '- 当前任务进行到哪里\n' +
  '- 已经确认的结论\n' +
  '- 做了哪些重要决定\n' +
  '- 每项决定背后的原因或证据\n' +
  '- 尝试过但失败的方案，以及失败原因\n' +
  '- 修改了哪些关键文件\n' +
  '- 当前测试结果\n' +
  '- 尚未解决的风险或问题\n' +
  '- 下一步最具体的行动\n' +
  '完成后告诉我：更新了哪些记忆文件；每个文件新增或修改了什么；下一会话应该从哪一项开始。';

// ② 带目标的压缩命令（对齐手册「通用带目标 compact」段）。斜杠命令，
//    发送方式与 /quit 相同（send-keys 整行 + 延迟 Enter），不走文本两阶段路径。
export const COMPACT_COMMAND =
  '/compact 只保留：当前目标；已完成和未完成事项；已修改文件；关键设计决定及原因；' +
  '失败方案及其证据；测试结果；未解决风险；下一步验证计划。删除闲聊、重复输出、过时计划。';

// ③ 恢复指令（对齐手册「新对话开始」段）：压缩后新上下文先读记忆再续。
export const RESUME_PROMPT =
  '继续之前的任务。先从 MEMORY.md 定位相关主题，再读取与当前任务直接相关的记忆子文件；' +
  '用两三句话说明当前进度、已确认的关键决定、下一步行动。' +
  '如果记忆里没有某项内容，明确说「没有记录」，不要凭印象猜测。确认后直接继续下一步。';

// 剥离 ANSI 转义序列。**必读**：抓屏走 `tmux capture-pane -p -e`，-e 保留颜色码，
// 而 Claude Code 在多 shell / 多 agent 的重会话里会把底栏**逐 token 分色**，
// 转义码直接插进 `100%` 和 `context` 之间：
//   "\x1b[38;5;246m100%\x1b[39m \x1b[38;5;246mcontext\x1b[39m ..."
// 此时 \s* / \s+ 吃不下 ESC 序列 → 必然失配。实测 whatyterm-34c8e150 底栏 43 个
// 转义序列，不剥码命中 0/4 次、剥码后 4/4。与 index.js:5605 那段 v1.2.46 复盘同一个坑
// （hook 门内探确认界面 854k 行日志零命中，根因也是没剥码）。
function stripAnsi(text) {
  return String(text)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')  // OSC
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')          // CSI
    .replace(/\x1b[@-Z\\-_]/g, '');                      // 其他单字符转义
}

// Claude Code 底栏的四种文案。**每条必须显式声明这个数是「剩余」还是「已用」** ——
// 口径搞反的代价：`100% context used` 若按剩余处理会转成 0，判成"水位充足"，
// 恰好在最该交接时最理直气壮地不动。文案清单来自 CLI 2.1.270 二进制反解：
//   lfo = autocompactEnabled ? `${100-n}% context used` : `${n}% until auto-compact`
//   关掉 autocompact 时改渲染 `Context low (${n}% remaining)`
// 第四条尤其要紧：它是唯一「CLI 不会自救」的分支——关掉 autocompact 的用户往往
// 正是想把压缩交给 WebTmux 管，此时读不到水位就一路撞到 blocked，进度全丢。
// 尾部允许截断（底栏 wrap:"truncate"，窄屏截在词中）：`100% context us` 也能认。
const WATERLINE_PATTERNS = [
  { re: /Context low\s*\(\s*(\d{1,3})\s*%\s*remaining/gi,      kind: 'left' },  // 关闭 autocompact
  { re: /Context left until auto-compact:\s*(\d{1,3})\s*%/gi,  kind: 'left' },  // 历史版本
  { re: /(\d{1,3})\s*%\s*until\s+auto-comp/gi,                 kind: 'left' },  // 当前（剩余口径）
  { re: /(\d{1,3})\s*%\s*context\s+us/gi,                      kind: 'used' },  // 当前（已用口径）
];

// 只在屏幕末尾这么多个**非空行**里找底栏。实测底栏不在末 3 行：
//   倒数1 `⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt`
//   倒数2/4 分隔线、倒数3 空 `❯`、**倒数5 才是右对齐的水位行**
// 所以窗口取 8 行（留余量），不能按审计初稿的 3 行否则必漏。
const TAIL_LINES = 8;

// 底栏行形态闸：排除「屏上正文里出现同样字面量」被当成真读数。
// 本模块和它的单测里就写着 `100% context used` 字面量，WebTmux 自己开发时
// 天天在屏上出现——实测把本文件全文当屏幕喂进去会读出 100，把单测文件喂进去
// 读出 88（恰好等于 HANDOFF_USED_PCT，直接踩线发收尾指令）。
function looksLikeStatusBar(line) {
  if (line.length > 200) return false;                    // 底栏是单行，正文长行不是
  if (/["'`]/.test(line)) return false;                   // 带引号 → 源码/字符串
  if (/\/\/|\/\*|^\s*\*|=>|\bconst\b|\bre:\b|\bkind:\b/.test(line)) return false;  // 代码/注释特征
  if (/^\s*[⎿│]|^\s*\d+[:：]/.test(line)) return false;   // 工具输出行（`⎿ 53: ...`）
  return true;
}

/**
 * 从终端文本解析「已用上下文百分比」。
 * @returns {number|null} 0~100 的已用百分比；解析不到返回 null（不臆造）。
 */
export function readContextWaterline(terminalContent) {
  if (!terminalContent) return null;
  // 先剥码再切窗口——顺序不能反：色码会把行内容切碎，也会让长度判据失真。
  const lines = stripAnsi(terminalContent).split(/\r?\n/)
    .map(l => l.trimEnd()).filter(l => l.trim());
  const tail = lines.slice(-TAIL_LINES).filter(looksLikeStatusBar);
  if (tail.length === 0) return null;

  // 逐行**从后往前**扫（底栏在最下），行内逐条口径试。
  // 按行优先而非按 pattern 优先：否则正文里的旧文案会赢过底栏的新文案。
  for (let i = tail.length - 1; i >= 0; i--) {
    for (const { re, kind } of WATERLINE_PATTERNS) {
      re.lastIndex = 0;  // 复用 /g 正则前必须复位，否则跨调用残留 lastIndex 会漏匹配
      let last = null, m;
      while ((m = re.exec(tail[i])) !== null) last = m[1];
      if (last === null) continue;
      const n = Math.max(0, Math.min(100, parseInt(last, 10)));
      return kind === 'used' ? n : 100 - n;
    }
  }
  return null;
}

// 用户开关的三态（session.waterlineMode）：
//   'off'  完全不管，连告警都不出
//   'warn' 到线只右栏告警，永不自动按键（即便空闲）
//   'auto' 默认——空闲且到交接线就自动发收尾指令
export const WATERLINE_MODES = ['off', 'warn', 'auto'];
export const DEFAULT_WATERLINE_MODE = 'auto';

// 三步闭环阶段（session._waterlinePhase）：
//   idle         未介入
//   handoff_sent 已发收尾指令，等它把记忆写完
//   compact_sent 已发 /compact，等压缩结束
//   resumed      已发恢复指令（读 MEMORY.md 再续），等水位回落重置
export const WATERLINE_PHASES = ['idle', 'handoff_sent', 'compact_sent', 'resumed'];

// "记忆写完"信号：必须是**完成式**。曾经只做关键词匹配，实测把这几类全判成写完：
//   「接下来我会把结论写入记忆文件 MEMORY.md」← 未来句，一个字没写
//   「要我把这些写进 MEMORY.md 吗？」        ← 反问
//   「读取 MEMORY.md 后发现主题列表已过期」  ← 只是读了
// 根因是裸 `MEMORY\.md` 这一支：文件名出现即算写完。已删除，改为要求完成式动词。
// 「已」与完成式动词之间可能插入宾语（"已把进度写入记忆"），故 已.{0,10}动词.{0,10}记忆。
const MEMORY_WRITTEN_RE = /已.{0,10}(更新|写入|保存|记录|同步|写好|存入).{0,10}(记忆|MEMORY|memory)|记忆(文件|库)(已|:|：|已经)|(更新|写入|保存|新增)了.{0,8}(记忆|MEMORY|memory)|(写入|更新|保存)到\s*memory\/\S+\.md|\b(have|has)\s+(updated|written|saved|recorded)\b[^.]{0,30}\bmemor|\b(wrote|saved|recorded)\s+(to|in)\b[^.]{0,30}\bmemor/i;

// 否决词：同一段文本里出现这些，说明是未来式/疑问/否定/失败，不算写完。
// 与上面的完成式正则是「且非」关系——完成式命中也要过这一关。
const MEMORY_NOT_YET_RE = /(准备|打算|将要|接下来|稍后|马上|我会|需要我|要不要|是否需要)|[？?]\s*$|[？?]/;

// 收尾指令/恢复指令自身含「更新了哪些记忆文件」，而抓屏读到的"回复"里常混着**用户输入回显**
// （Claude Code 回显格式是 `❯ <文本>`，行首有内容，getLastClaudeReply 的
//  `^[❯>]\s*$` 停止条件拦不住），于是收尾指令一发出、回显还在可视区，
// 下一轮就把自己的指令读成"会话说它写完了"→ 立刻 /compact，
// 而 CLI 可能一个字都还没写。这是本功能最该防的事故，必须自指防护。
// ⚠️ 新增交接指令时必须同步往这里加一条它独有的措辞。LONGRUN_HANDOFF_PROMPT 上线时实测：
//    它的末行「完成后告诉我：更新了哪些记忆文件…」命中完成式正则，而本表当时只认水位版的词，
//    于是回显没被剔除 → 指令刚发出就判成写完 → 立刻 /quit，CLI 一个字都还没写。
const SELF_ECHO_RE = /先不要继续原任务|跨压缩后仍有价值|明确说「没有记录」|从\s*MEMORY\.md\s*定位相关主题|这个阶段先收尾|跨会话后仍然有价值的内容/;

// 收尾指令发出后，最多再等这么多轮"空闲"就兜底放行去 compact，
// 防止 CLI 用了没匹配上的措辞导致永久卡在 handoff_sent。
// ⚠️ 只在**空闲轮**计数（调用方保证），否则爆发模式 3 秒一轮、9 秒就放行，
//    /compact 会直接撞在会话正写记忆的过程里。
export const HANDOFF_WAIT_ROUNDS = 3;

/**
 * 判断收尾后记忆是否已写完（供状态机从 handoff_sent → compact_sent）。
 * 双口径：① 回复正文命中**完成式**写记忆措辞且无否决词；② 兜底——已等够空闲轮数。
 */
export function isMemoryWritten(lastReply, roundsSinceHandoff) {
  if (lastReply) {
    // 自指防护：先剔除收尾/恢复指令自身的回显，剩下的才算会话的真实回复。
    const body = SELF_ECHO_RE.test(lastReply)
      ? lastReply.split(/\r?\n/).filter(l => !SELF_ECHO_RE.test(l) && !/更新了哪些记忆文件/.test(l)).join('\n')
      : lastReply;
    if (MEMORY_WRITTEN_RE.test(body) && !MEMORY_NOT_YET_RE.test(body)) return true;
  }
  if (typeof roundsSinceHandoff === 'number' && roundsSinceHandoff >= HANDOFF_WAIT_ROUNDS) return true;
  return false;
}

/**
 * 三步闭环状态机决策（纯函数，无 IO）。对齐 Auto Memory 手册：
 * 收尾写记忆 → 带目标 /compact → 恢复时先读 MEMORY.md 再续。
 * @param {object} p
 * @param {number|null} p.usedPercent      已用百分比（readContextWaterline 的输出）
 * @param {boolean} p.isIdle               会话是否空闲（运行中/确认框中一律不打断）
 * @param {string}  p.phase                当前阶段（WATERLINE_PHASES 之一）
 * @param {boolean} [p.memoryWritten]      收尾后记忆是否已写完（isMemoryWritten 的输出）
 * @param {boolean} [p.isCompacting]       是否正在压缩中（AIEngine 判据）
 * @param {string}  [p.mode]               用户开关：off/warn/auto（封顶，默认 auto）
 * @returns {{level:'none'|'warn'|'handoff'|'compact'|'resume', nextPhase:string, usedPercent:number|null, reason:string}}
 */
export function decideWaterlinePhase({ usedPercent, isIdle, phase = 'idle', memoryWritten = false, isCompacting = false, mode = DEFAULT_WATERLINE_MODE }) {
  const pct = typeof usedPercent === 'number' ? usedPercent : null;
  const keep = (level, reason, nextPhase = phase) => ({ level, nextPhase, usedPercent: pct, reason });

  if (mode === 'off') return keep('none', '水位交接已关闭', 'idle');
  if (pct === null) return keep('none', '无水位读数', phase);

  // compact_sent 阶段先于水位检查处理：/compact 一旦成功，水位必然回落到安全区，
  // 但闭环还差最后一步「先读 MEMORY.md 再续」的恢复指令。若被下面的回落复位拦截，
  // resume 永远发不出去——所以这一步单独前置（warn 模式除外，见 mode 判定在其后仍会拦）。
  if (mode === 'auto' && phase === 'compact_sent') {
    if (isCompacting) return keep('warn', '压缩进行中，等待结束', 'compact_sent');
    if (isIdle) return keep('resume', '压缩已结束，发恢复指令（先读 MEMORY.md 再续）', 'resumed');
    return keep('warn', '压缩已结束，等空闲发恢复指令', 'compact_sent');
  }

  // 水位回落到安全区（多半刚发生过压缩）：无条件复位，闭环可重新开始。
  if (pct < WARN_USED_PCT) return keep('none', `水位 ${pct}% 充足`, 'idle');

  // warn 模式：全程只告警、绝不按键（用户封顶，等价于禁用自动 compact）。
  if (mode === 'warn') return keep('warn', `水位 ${pct}% 偏高（仅告警模式）`, phase);

  // 以下为 auto 模式的阶段推进。运行中/确认框中（!isIdle）一律只告警不打断。
  switch (phase) {
    case 'idle':
      if (pct >= HANDOFF_USED_PCT && isIdle) return keep('handoff', `水位 ${pct}% ≥ ${HANDOFF_USED_PCT}%，空闲，发收尾指令`, 'handoff_sent');
      return keep('warn', `水位 ${pct}% 偏高，等空闲再收尾`, 'idle');
    case 'handoff_sent':
      // 记忆写完 + 空闲 → 发 /compact；否则继续等（告警但不重复发收尾）。
      if (memoryWritten && isIdle) return keep('compact', '记忆已写完，发 /compact 压缩上下文', 'compact_sent');
      return keep('warn', '已发收尾，等记忆写完再压缩', 'handoff_sent');
    // compact_sent 已在水位检查前处理（见上），此处不再出现。
    case 'resumed':
      // 恢复指令已发，等水位回落（上面 pct<WARN 分支会复位）。此处只告警。
      return keep('warn', `已恢复，等水位回落复位（当前 ${pct}%）`, 'resumed');
    default:
      return keep('warn', `未知阶段 ${phase}，按告警处理`, 'idle');
  }
}

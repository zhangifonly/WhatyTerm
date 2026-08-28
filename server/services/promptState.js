/**
 * 输入提示符状态判定。
 *
 * 背景：原来各处判"空闲"都要求提示符行**是空的**（`/^[❯>]\s*$/`）。
 * 但输入框里常常留着一段没提交的文本 —— 最典型的是自动操作把「继续」打了进去、
 * 回车却没落地（Claude Code 用 Ink 的 TextInput，文本与回车必须分两次发）。
 * 此时屏幕长这样：
 *
 *     ✳ Cooked for 6m 8s
 *     ❯ 继续 format 组
 *       ▶▶ auto mode on (shift+tab to cycle) · ← 5 agents
 *
 * 所有"空提示符"判据全部落空，状态被判成「不明确」，监控就此停摆 ——
 * 而实际上 CLI 正闲着等一个回车。
 *
 * 关键点：这种情况下**不能再发一次「继续」**，那会把输入框变成
 * 「继续 format 组继续」。正确动作是回车，把已有内容提交掉。
 */

// 分隔线、边框这类装饰行，找提示符时要跳过
const DECORATION = /^[\s─━—\-=_│┃╭╮╰╯╌┄┈]+$/;

/**
 * 取输入提示符行上尚未提交的文本。
 *
 * @param {string} cleanText 已剥离 ANSI 的终端内容
 * @returns {string|null} null = 没找到提示符行；'' = 提示符为空（真空闲）；
 *   非空字符串 = 输入框里留着这段没提交的文本
 */
export function promptPendingText(cleanText) {
  const lines = String(cleanText || '')
    .split('\n')
    .map(l => l.replace(/\s+$/, ''))
    .filter(l => l.trim() && !DECORATION.test(l));

  // 只看末尾若干行：提示符总在屏幕最下方，历史输出里的 `>` 引用行不算
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 6); i--) {
    const m = lines[i].match(/^\s*[❯>]\s?(.*)$/);
    if (m) return m[1].trim();
  }
  return null;
}

/** 提示符存在且为空 —— 真正的空闲，可以发文本指令 */
export function isEmptyPrompt(cleanText) {
  return promptPendingText(cleanText) === '';
}

/** 提示符存在且留着未提交的文本 —— 该发回车，而不是再打字 */
export function hasUnsentInput(cleanText) {
  const t = promptPendingText(cleanText);
  return typeof t === 'string' && t.length > 0;
}

/**
 * 这段未提交的文本是不是**我们自己**打进去的。
 *
 * 为什么必须区分：用户可能正打到一半在思考。替他按回车会把半截话提交出去，
 * 比原来的"不操作"更糟。而 userInputPauseState 只挡 5 秒，靠不住。
 *
 * 判据分两层：
 *   1. lastSentText —— 我们上一次真正发出去的文本。这是**事实**，最可靠。
 *      监控 AI 回答 CLI 提问时会生成任意内容（如「检查 Clash 里的分流规则」），
 *      光看内容根本认不出是自己打的，必须靠这个。
 *   2. 认不到 lastSentText 时（重启后、测试里）退回启发式：以自动指令开头。
 *      宁可漏判成"用户的"而不操作，也不能误判成"自己的"去提交用户的半截话。
 *
 * @param {string} pending 未提交的文本
 * @param {string[]} autoActions 该阶段配置的自动指令（如 ['继续', ...]）
 * @param {string} [lastSentText] 我们上一次发给该会话的文本
 */
export function isOwnPendingInput(pending, autoActions = ['继续'], lastSentText = null) {
  if (!pending) return false;
  if (lastSentText && typeof lastSentText === 'string') {
    const sent = lastSentText.trim();
    if (sent && (pending === sent || pending.startsWith(sent))) return true;
  }
  const list = (autoActions || []).filter(a => typeof a === 'string' && a.trim());
  const known = list.length ? list : ['继续'];
  return known.some(a => pending === a || pending.startsWith(a));
}

export default { promptPendingText, isEmptyPrompt, hasUnsentInput, isOwnPendingInput };

/**
 * 该不该因为「会话污染类 API 错误」自动退出、改对话记录、重启 Claude Code（纯函数）。
 *
 * 由来（2026-09-26 phyviz）：原判据在**整屏回滚内容**里去掉换行后找 `unexpected.*content.*type`。
 * 助手正文「…Unexpected token '<'…」和一千多字之后的「content-type」拼起来就命中 —— 会话好好地在跑，
 * 被当成 API 错误，连续 4 次发 /quit 退出、改写对话记录、重启；/quit 常常没落地 → 2 分钟超时、屏上一串修复提示。
 * 近一个月这些会话的对话记录里，没有一次真实的这类错误。
 *
 * 规则（三条都满足才算）：
 * 1. 错误出自 CLI 自己打的 `API Error: <状态码> …` 这一行（正文里出现这些词不算）
 * 2. 这一行在屏幕**末尾**：它之后只能是输入框、分隔线、状态栏，不能还有别的输出
 * 3. 错误内容属于「对话记录被污染、删掉 thinking 块能救」的那几类（签名无效、tool_use_id 对不上、空内容）
 *    —— 连接中断、限流、上下文过长这些改对话记录没用，不在此列
 */

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g;

/** 删 thinking / 空块能修好的错误（均来自真实报错原文） */
export const FIXABLE_ERRORS = [
  /Invalid `?signature`? in `?thinking`? block/i,
  /thinking\.signature:?\s*Field required/i,
  /unexpected `?tool_use_id`? found in `?tool_result`?/i,
  /`?tool_result`? block(s)? must have a corresponding `?tool_use`?/i,
  /text content blocks must be non-empty/i,
  /content blocks must be non-empty/i,
  /thinking.{0,40}(is not supported|not allowed)/i,
];

/** 屏幕末尾允许跟在错误后面的行：空行、输入框、分隔线、状态栏、CLI 的操作提示 */
const TRAILER = /^\s*$|^\s*[❯>]\s?|^[\s─━—\-=_│┃╭╮╰╯]+$|⏵|shift\+tab|\? for shortcuts|context used|until auto-compact|Context (left|low)|esc to|accept edits|auto mode|bypass permissions|plan mode|agents?\b|\/model|\/effort|claude doctor|Auto-update/i;

/**
 * @param {string} screen 抓屏内容（可带颜色码）
 * @returns {{fixable: boolean, line?: string, reason: string}}
 */
export function classifyApiErrorScreen(screen) {
  const lines = String(screen || '').replace(ANSI, '').split('\n').map((l) => l.replace(/\s+$/, ''));
  // 从末尾往上：跳过允许的尾巴，第一条「内容」必须是 API Error 那条（可能被折成两三行）
  let i = lines.length - 1;
  while (i >= 0 && TRAILER.test(lines[i])) i--;
  if (i < 0) return { fixable: false, reason: '屏幕没有内容' };
  // 错误行可能折行：往上最多 4 行找以 API Error 开头的那一行。它下面到 i 为止的行只能是折行的续写
  //（缩进、不以 ⏺/● 起头 —— 那是一条新输出，说明 CLI 报完错又接着干了，已经恢复）
  let start = -1;
  for (let k = i; k >= Math.max(0, i - 4); k--) {
    const seg = lines[k].trim();
    if (/(^|[:\s⏺●⎿])API Error:\s*\d{3}\b/.test(seg)) { start = k; break; }
    if (/^[⏺●✻✶✳]/.test(seg)) return { fixable: false, reason: 'API 错误之后还有新输出，CLI 已经接着在干' };
  }
  if (start < 0) return { fixable: false, reason: '屏幕末尾不是 CLI 报的 API 错误' };
  const text = lines.slice(start, i + 1).map((l) => l.trim().replace(/^[⏺●]\s*/, '').replace(/^⎿\s*/, '')).join(' ');
  const line = text.replace(/\s+/g, ' ');
  if (!FIXABLE_ERRORS.some((re) => re.test(line))) {
    return { fixable: false, line, reason: '是 API 错误，但不是删 thinking 块能修好的那类（连接、限流、上下文过长等）' };
  }
  return { fixable: true, line, reason: '' };
}

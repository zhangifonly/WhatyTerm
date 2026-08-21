/**
 * 「CLI 正在向用户提一个需要判断的问题」检测。
 *
 * 背景：自动模式此前只会机械发「继续」。但 CLI 常常把球踢回来，例如
 *   剩下两件事我没做 …
 *   1. 另外 50 个被遮蔽的存根 —— 机械性工作
 *   2. svx/sdrhittesthelper.ts 的链路是断的 —— 真正的补全工作
 *   第 1 项收益明确、风险低；第 2 项是真正的翻译补全工作。你想让我接着做哪个？
 * 这时回「继续」等于没回答，CLI 只能再问一遍或自行乱选。
 * 命中本检测后，预判断会让位给 AI，由 AI 读完屏幕给出有内容的答复
 * （如「按顺序完成，先做第 1 项，完成后再做第 2 项」）。
 *
 * 注意：带编号选项的**权限确认菜单**（1. Yes / 2. Yes, allow…）不归这里管，
 * 那类有专门的 select 分支，且必须优先于本检测。
 */

// 明确的疑问句式（CLI 在征询用户意见）
const ASK_PATTERNS = [
  /你想(让我)?(先)?(做|处理|选|从|继续)[^。\n]{0,30}[?？]/,
  /(你|您)(希望|想要|打算|倾向)[^。\n]{0,40}[?？]/,
  /要(不要|我)[^。\n]{0,40}[?？]/,
  /是否(需要|要|继续|应该)[^。\n]{0,40}[?？]/,
  /(先|接着|下一步)(做|处理|执行)?[^。\n]{0,20}(哪|那)(个|一个|些)[^。\n]{0,20}[?？]/,
  /(请(问|你)?(确认|决定|选择)|需要你(决定|确认|选择))[^。\n]{0,40}[?？]?/,
  /怎么(办|处理|选)[?？]/,
  /(哪|那)(个|一个|些)(方案|选项|优先|先做)[^。\n]{0,20}[?？]/,
  /\bwh(ich|at)\s+(one|option|approach|would|should)[^.\n]{0,50}\?/i,
  /\bwould you like me to\b[^.\n]{0,60}\?/i,
  /\b(do|should|shall)\s+(you\s+want\s+me|i)\b[^.\n]{0,60}\?/i,
  /\blet me know (which|what|if|whether)\b/i,
  /\byour call\b|\bup to you\b/i
];

// 编号确认菜单特征 —— 命中则不算「开放式提问」，交给 select 分支处理
const CONFIRM_MENU = /[❯›>]?\s*1\.\s*(Yes|Allow|是)/i;

/**
 * 判断终端尾部是否存在等待用户决策的开放式提问。
 * @param {string} text 已剥离 ANSI 的终端内容
 * @returns {boolean}
 */
// 提示符行、状态栏、计时器、分隔线 —— 提问之后出现这些不代表问题被回答了
const NOISE_LINE = /^\s*(?:[›❯>*·✱✳]\s*)?(?:$|继续$|[─━—\-=_]{3,}\s*$)/
  ;
const NOISE_CONTENT = /esc to interrupt|auto mode|shift\+tab|accept edits|Churned for|Worked for|tokens\)|\(\d+[hms]|Update installed|Restart to update|ctrl\+[a-z]|to expand\)|to cycle\)/i;

/** 去掉提示符/状态栏/计时器这类噪音行，只留 CLI 真正说的话 */
function stripNoise(tail) {
  return tail.split('\n')
    .filter(l => !NOISE_LINE.test(l) && !NOISE_CONTENT.test(l))
    .join('\n');
}

/**
 * 判断终端尾部是否存在等待用户决策的开放式提问。
 * @param {string} text 已剥离 ANSI 的终端内容
 * @returns {boolean}
 */
export function hasPendingQuestion(text) {
  if (!text) return false;
  // 只看尾部：更早的历史提问可能早已被回答过
  const tail = text.slice(-1200);
  if (CONFIRM_MENU.test(tail)) return false;
  if (!ASK_PATTERNS.some(re => re.test(tail))) return false;

  // 提问必须**落在结尾**：若问号之后 CLI 自己又说了成句的话，
  // 说明是自问自答（「是否需要重启？不需要，热更新已生效。」），并非在等用户。
  const clean = stripNoise(tail);
  const lastQ = Math.max(clean.lastIndexOf('？'), clean.lastIndexOf('?'));
  if (lastQ < 0) return true; // 无问号的问法（your call / let me know）视为在等
  const after = clean.slice(lastQ + 1).replace(/\s/g, '');
  return after.length < 8;
}

export default { hasPendingQuestion };

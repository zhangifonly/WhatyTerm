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

// CLI 自己印出来的「我问了，但没得到回答」。这是它的原话，比任何句式推断都硬：
// 出现即说明球在人这边，机械「继续」只会让它再问一遍。
// （Claude Code 在 AskUserQuestion 被拒答时打印 "User declined to answer questions"。）
const DECLINED_MARK = /User declined to answer question/i;

/**
 * 判断终端尾部是否存在等待用户决策的开放式提问。
 * @param {string} text 已剥离 ANSI 的终端内容
 * @returns {boolean}
 */
// 提示符行、状态栏、计时器、分隔线 —— 提问之后出现这些不代表问题被回答了
const NOISE_LINE = /^\s*(?:[›❯>*·✱✳]\s*)?(?:$|继续$|[─━—\-=_]{3,}\s*$)/
  ;
// ⚠️ 计时行的动词是**随机轮换**的（Churned/Worked/Cooked/Cogitated/Baked/Brewed/Simmered…），
//    枚举两个必然漏。实测（tableCard 2026-09-18）同一屏就出现了 Cooked/Brewed/Baked/Cogitated 四种，
//    漏掉后紧跟提问的计时行留在 clean 里，把「问号右侧是选项清单」这条判据算歪。
//    改判形态：`<动词> for <数字><单位>`，动词不限。
const TIMER_LINE = /\b[A-Z][a-z]+(?:ed|ing)?\s+for\s+\d+(?:\.\d+)?\s*[a-z]{1,2}\b/;
const NOISE_CONTENT = /esc to interrupt|auto mode|shift\+tab|accept edits|tokens\)|\(\d+[hms]|Update installed|Restart to update|ctrl\+[a-z]|to expand\)|to cycle\)/i;

/** 去掉提示符/状态栏/计时器这类噪音行，只留 CLI 真正说的话 */
function stripNoise(tail) {
  return tail.split('\n')
    .filter(l => !NOISE_LINE.test(l) && !NOISE_CONTENT.test(l) && !TIMER_LINE.test(l))
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
  if (DECLINED_MARK.test(tail)) return true;     // 先于句式判断：它已经明说没人答它
  if (!ASK_PATTERNS.some(re => re.test(tail))) return false;

  // 提问必须**落在结尾**：若问号之后 CLI 自己又说了成句的话，
  // 说明是自问自答（「是否需要重启？不需要，热更新已生效。」），并非在等用户。
  const clean = stripNoise(tail);
  const lastQ = Math.max(clean.lastIndexOf('？'), clean.lastIndexOf('?'));
  if (lastQ < 0) return true; // 无问号的问法（your call / let me know）视为在等
  const after = clean.slice(lastQ + 1).replace(/\s/g, '');
  if (after.length < 8) return true;
  // 问号之后是**选项清单**时，那恰恰是在等人选，不是自答。
  // 实测（tableCard，2026-09-18）：CLI 写「你想要哪个？（你自己挑一件做 / 撤回广联达旧包 /
  // 我已经发布了 / 别做了，就此停下）」，选项全在问号右侧共 32 字，被上一行判成自问自答，
  // 于是机械「继续」一路发到 15 万余次、烧掉 $1519 —— 最该停手的形态反而最理直气壮地不停。
  return looksLikeOptionList(after);
}

/**
 * 问号之后的残留文本是否是「供人选的清单」而非 CLI 的自答。
 * 判据取形态而非语义：分隔符（/ ｜ 、 或 "或"）把它切成两段以上，
 * 且每段都短（选项是词组，自答是成句）。括号包裹是常见写法，不作必需。
 */
function looksLikeOptionList(after) {
  const body = after.replace(/^[（(]|[）)]$/g, '');
  const parts = body.split(/[/｜|、]|\bor\b|或/).map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return false;
  return parts.every(p => p.length <= 30);
}

export default { hasPendingQuestion };

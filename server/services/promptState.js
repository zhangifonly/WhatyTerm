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

/** 屏上截断的前缀至少这么长才认作「我们所发长文本的前一截」；太短的前缀（如「继」）更可能是用户正在打字 */
const MIN_TRUNCATED_PREFIX = 10;

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
 *   2. 认不到 lastSentText 时（重启后、测试里）退回启发式：完全等于自动指令。
 *      宁可漏判成"用户的"而不操作，也不能误判成"自己的"去提交用户的半截话。
 *
 * @param {string} pending 未提交的文本
 * @param {string[]} autoActions 该阶段配置的自动指令（如 ['继续', ...]）
 * @param {string} [lastSentText] 我们上一次发给该会话的文本
 */
export function isOwnPendingInput(pending, autoActions = ['继续'], lastSentText = null) {
  const text = typeof pending === 'string' ? pending.trim() : '';
  if (!text) return false;
  if (lastSentText && typeof lastSentText === 'string') {
    const sent = lastSentText.trim();
    // 相等，或屏上只截到了我们所发长文本的前一截（输入框折行/截断）。
    // ⚠ 方向不能反：原来写成 text.startsWith(sent)，发过「继续」后用户接着敲「继续做上级端的写能力」
    //   也被认成自己的，监控就替用户按回车提交半截话（2026-09-18 Hitech 会话实测）
    if (sent && (text === sent || (text.length >= MIN_TRUNCATED_PREFIX && sent.startsWith(text)))) return true;
  }
  // 认不到发送记录时只认「完全等于」自动指令。原来按前缀认（以「继续」开头就算），
  // 中文里「继续做…」「继续修…」是最常见的用户草稿开头，等于把用户的话当成自己的
  const list = (autoActions || []).filter(a => typeof a === 'string' && a.trim());
  const known = list.length ? list : ['继续'];
  return known.some(a => text === a.trim());
}

// 转义序列：SGR 单独捕获参数，其余 CSI / OSC / 单字符转义原样保留
const ESCAPE = /\x1b\[([0-9;:]*)m|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/y;
const ANSI_ALL = /\x1b\[[0-9;?:]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const PROMPT_LINE = /^\s*[│|]?\s*[❯>](?:\s|$)/;

/** 按 SGR 参数更新“暗淡”状态。38/48/58 后面跟的是颜色值（如 38;5;2 里的 2 不是暗淡），要整段跳过 */
function applySgr(params, dim) {
  const p = params === '' ? ['0'] : params.split(/[;:]/);
  for (let i = 0; i < p.length; i++) {
    const n = p[i] === '' ? 0 : Number(p[i]);
    if (n === 38 || n === 48 || n === 58) {
      i += Number(p[i + 1]) === 5 ? 2 : Number(p[i + 1]) === 2 ? 4 : 1;
    } else if (n === 0 || n === 22) dim = false;
    else if (n === 2) dim = true;
  }
  return dim;
}

/** 删掉一行里暗淡样式（SGR 2）的可见文字，转义序列原样保留；返回处理后的行与被删掉的文字 */
function dropDimText(line) {
  let out = '';
  let dropped = '';
  let dim = false;
  for (let i = 0; i < line.length;) {
    ESCAPE.lastIndex = i;
    const m = ESCAPE.exec(line);
    if (m) {
      if (m[1] !== undefined) dim = applySgr(m[1], dim);
      out += m[0];
      i += m[0].length;
      continue;
    }
    const ch = String.fromCodePoint(line.codePointAt(i));
    if (!dim || ch < ' ') out += ch; // 控制字符（如 capturePane 补的 \r）照留
    else dropped += ch;
    i += ch.length;
  }
  return { out, dropped };
}

// 新会话欢迎屏的占位提示：没有任何对话历史，自动发「继续」毫无意义，保留它让后续判断交给 AI
const WELCOME_PLACEHOLDER = /^\s*Try\s*"/; // 逐词分段着色时词间空格不是暗淡样式，拼出来是 Try"…

/**
 * 去掉输入框里 Claude Code 显示的灰色建议文字（带颜色码的原始屏幕进，同样格式出）。
 *
 * 背景：CLI 干完活后会在空输入框里用暗淡样式（SGR 2）预填一句下一步建议，
 * 如「❯ 继续做家长端」（按 Tab/→ 才采纳）。
 * 一旦剥掉颜色码，它和真正打进去的字无法区分：promptPendingText 会认成“用户未提交的草稿”，
 * 监控就停手不动（2026-09-18 Hitech 会话实测）。真正打进去的字不会是暗淡样式。
 *
 * 只处理屏幕末尾那一行输入框（与 promptPendingText 同一范围），历史里的 `>` 引用行不动。
 * 新会话欢迎屏的占位提示 `Try "…"` 同样是暗淡样式，但**有意保留**：那时没有任何对话，
 * 不该自动发「继续」，原行为是交给 AI 判断（fixture whatyterm-4258a341）。
 * 前端 xterm 显示不走这里，画面不受影响。
 *
 * @param {string} raw capture-pane -e 抓到的屏幕（含颜色码）
 * @returns {string}
 */
export function stripPromptSuggestion(raw) {
  if (!raw || typeof raw !== 'string' || !raw.includes('\x1b[')) return raw;
  const lines = raw.split('\n');
  let seen = 0;
  for (let i = lines.length - 1; i >= 0 && seen < 6; i--) {
    const plain = lines[i].replace(ANSI_ALL, '').replace(/\s+$/, '');
    if (!plain.trim() || DECORATION.test(plain)) continue;
    seen++;
    if (PROMPT_LINE.test(plain)) {
      const { out, dropped } = dropDimText(lines[i]);
      if (dropped.trim() && !WELCOME_PLACEHOLDER.test(dropped)) lines[i] = out;
      break;
    }
  }
  return lines.join('\n');
}

export default { promptPendingText, isEmptyPrompt, hasUnsentInput, isOwnPendingInput, stripPromptSuggestion };

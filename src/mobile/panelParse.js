/**
 * 识别终端上的「选项面板」，在手机上渲染成可点按钮（纯逻辑，可单测）。
 *
 * 手机上没有方向键，而这类面板要靠 ↑↓ 移光标、空格勾选、Tab 切分栏 —— 现有的
 * 1/2/3 按钮只对**编号菜单**有用，对勾选框完全无效。所以要么加一排方向键，
 * 要么把选项解析出来直接点。这里做后者（点一下自动发出该走的按键序列）。
 *
 * ⚠️ **本模块自己剥 ANSI**，不要求调用方先处理。原因：服务端抓屏用的是
 *   `tmux capture-pane -p -e`（保留颜色码，见 SessionManager.js），所以移动版拿到的
 *   屏幕**一定带 ANSI**。实测同一面板：不带 -e 能匹配到 "to navigate"，带 -e 匹配 **0** 处
 *   —— 色码会插进文字中间。这是本仓库踩过三次的坑（确认探针 / 水位 / 压缩判据），
 *   见记忆 screen-parsing-must-strip-ansi。把剥离放在模块内部，调用方就不可能忘。
 */

/** 剥 ANSI：颜色/光标/擦除序列全去掉，只留可见字符 */
export function stripAnsi(text) {
  return String(text || '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')   // OSC（窗口标题等）
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')                // CSI（颜色、光标、擦除）
    .replace(/\x1b[()][A-B0-2]/g, '')                    // 字符集切换
    .replace(/\x1b[78=>]/g, '')                          // 存/取光标、键盘模式
    .replace(/\r(?!\n)/g, '');                           // 裸 CR（覆写行）
}

/** 面板底部的操作提示 —— 判定"这是个面板"最可靠的信号，它由 CLI 自己打印 */
const HINT_RE = /(Enter to select|to navigate|to cancel|Tab\/Arrow)/i;

/** 单选：`❯ 1. 文本` / `  2. 文本`（❯ 表示光标当前位置） */
const NUMBERED_RE = /^(\s*)([❯>]?)\s*(\d{1,2})\.\s+(.*)$/;

/** 多选：`❯ 1. [ ] 文本` / `  2. [x] 文本` —— 勾选框可能在编号后 */
const CHECKBOX_RE = /^(\s*)([❯>]?)\s*(\d{1,2})\.\s*\[([ xX*])\]\s*(.*)$/;

/** 顶部分栏：`← ☒ 存量现状  □ 目的  ✔ Submit →`（Tab 在分栏间切换） */
const TABBAR_RE = /^\s*[←<]?\s*[☒☑□✔✓⊠]\s*\S/;

/** 只有一两个字的行多是残留 UI，不当选项 */
const MIN_LABEL = 1;

/**
 * 解析。
 * @param {string} plain 屏幕文本（带不带 ANSI 都行，内部会剥）
 * @returns {{isPanel:boolean, kind:'single'|'multi'|null, question:string,
 *            options:Array<{index:number,label:string,detail:string,checked:boolean,cursor:boolean}>,
 *            hasTabBar:boolean, hint:string}}
 */
export function parsePanel(plain) {
  const empty = { isPanel: false, kind: null, question: '', options: [], hasTabBar: false, hint: '' };
  const text = stripAnsi(plain);
  if (!text.trim()) return empty;

  // 只看尾部：更早的历史里可能有已经答过的面板，拿它当当前面板会点错
  const lines = text.split(/\r?\n/).slice(-40);
  const hintIdx = lines.findIndex((l) => HINT_RE.test(l));
  if (hintIdx < 0) return empty;

  const body = lines.slice(0, hintIdx);
  const options = [];
  let kind = null;

  for (let i = 0; i < body.length; i += 1) {
    const line = body[i];
    const mc = CHECKBOX_RE.exec(line);
    const mn = mc ? null : NUMBERED_RE.exec(line);
    const m = mc || mn;
    if (!m) continue;

    const cursor = !!(mc ? mc[2] : mn[2]);
    const index = Number(mc ? mc[3] : mn[3]);
    const label = String((mc ? mc[5] : mn[4]) || '').trim();
    if (!index || label.length < MIN_LABEL) continue;
    if (mc) kind = 'multi';
    else if (!kind) kind = 'single';

    // 紧跟其后、缩进更深且不是新选项的行 = 这一项的说明文字
    const indent = (mc ? mc[1] : mn[1]).length;
    const detail = [];
    for (let j = i + 1; j < body.length; j += 1) {
      const nxt = body[j];
      if (!nxt.trim()) break;
      if (CHECKBOX_RE.test(nxt) || NUMBERED_RE.test(nxt)) break;
      if (nxt.search(/\S/) <= indent) break;
      detail.push(nxt.trim());
    }
    // hasBox：这一项**本身**有没有勾选框。多选面板里也会混入无框的普通项
    //（如末尾的「Chat about this」），把它们画成 [ ] 会让人以为能勾
    options.push({
      index, label, detail: detail.join(' '), cursor,
      hasBox: !!mc,
      checked: mc ? /[xX*]/.test(mc[4]) : false,
    });
  }

  if (!options.length) return empty;

  // 问题行：选项之上最后一行像句子的文本（不是分隔线、不是分栏、不是选项）
  let question = '';
  const firstOptLine = body.findIndex((l) => CHECKBOX_RE.test(l) || NUMBERED_RE.test(l));
  for (let i = firstOptLine - 1; i >= 0; i -= 1) {
    const t = body[i].trim();
    if (!t || /^[─━—\-=_]{3,}$/.test(t) || TABBAR_RE.test(t)) continue;
    question = t;
    break;
  }

  return {
    isPanel: true,
    kind: kind || 'single',
    question,
    options,
    hasTabBar: body.some((l) => TABBAR_RE.test(l)),
    hint: (lines[hintIdx] || '').trim(),
  };
}

/**
 * 点某一项时该发的按键序列。
 *
 * 单选：直接发数字（CLI 支持按编号选中并提交），这是最稳的一条路 ——
 *   用 ↑↓ 移动要依赖"当前光标在第几项"，而那一帧可能已经变了。
 * 多选：数字只能移动光标/切换勾选（各 CLI 不一），所以用 ↓ 走到目标再按空格：
 *   目标与当前光标的差值决定按几次 ↓。序列由调用方依次发出。
 *
 * @returns {Array<{input:string, label:string}>} 依次要发的按键
 */
export function keysForOption(panel, index) {
  if (!panel?.isPanel) return [];
  const target = panel.options.find((o) => o.index === index);
  if (!target) return [];

  if (panel.kind === 'single') {
    return [{ input: String(index), label: `选 ${index}` }];
  }

  // 多选面板里的无框项（Chat about this 之类）不是勾选目标，按编号直接选
  if (!target.hasBox) return [{ input: String(index), label: `选 ${index}` }];

  const curIdx = panel.options.findIndex((o) => o.cursor);
  const tgtIdx = panel.options.findIndex((o) => o.index === index);
  // 取不到光标位置就不猜：宁可让人用方向键，也不要盲发一串 ↓ 勾错项
  if (curIdx < 0 || tgtIdx < 0) return [];
  const steps = tgtIdx - curIdx;
  const keys = [];
  for (let i = 0; i < Math.abs(steps); i += 1) {
    keys.push(steps > 0 ? { input: '\x1b[B', label: '↓' } : { input: '\x1b[A', label: '↑' });
  }
  keys.push({ input: ' ', label: target.checked ? '取消勾选' : '勾选' });
  return keys;
}

export default { parsePanel, keysForOption, stripAnsi };

/**
 * 终端尺寸计算：替代 FitAddon 的列数推算。
 *
 * 为什么不能直接用 FitAddon：
 * 它算可用宽度时会无条件减掉 xterm 内部的 `scrollBarWidth`（固定 15px），
 * 但 macOS 的悬浮滚动条**不占布局宽度**——实测 `.xterm-viewport` 的
 * offsetWidth 与 clientWidth 相等，探针元素测出的滚动条宽度是 0。
 * 于是这 15px 是凭空扣的，按 cell 宽 8.4px 算白丢 2 列；视口越宽、字号越小，
 * 丢的列数越多（1728px 宽的窗口实测丢 4 列）。
 *
 * 症状是「最右侧文字被截掉」：tmux pane 按 163 列排版并写满整行，
 * 前端 xterm 网格也报 163 列，但 xterm-screen 的像素宽只够画 159 列，
 * 行尾的宽字符（中文占 2 列）就整个消失了——不是被遮住，是没渲染。
 *
 * 这里改成按**平台实测**的滚动条占位宽度扣减：占位就扣，不占位就不扣。
 */

/**
 * 由可用像素与单元格尺寸推算网格列行数。纯函数，便于单测。
 * @param {{width:number,height:number}} avail 去掉边框/内边距/滚动条后的可用像素
 * @param {{width:number,height:number}} cell  单个字符单元格的 CSS 像素尺寸
 */
export function computeGrid(avail, cell) {
  if (!avail || !cell) return null;
  const { width: aw, height: ah } = avail;
  const { width: cw, height: ch } = cell;
  // cell 尺寸为 0 说明字体还没测量完（DOM 未完成布局），此时算出来是 Infinity，必须放弃本次
  if (!(cw > 0) || !(ch > 0) || !(aw > 0) || !(ah > 0)) return null;
  return {
    cols: Math.max(2, Math.floor(aw / cw)),
    rows: Math.max(1, Math.floor(ah / ch))
  };
}

/** 探测当前平台竖向滚动条实际占用的布局宽度（macOS 悬浮滚动条为 0，Windows 约 15~17px）。 */
export function measureScrollbarWidth(doc = document) {
  try {
    const probe = doc.createElement('div');
    probe.style.cssText =
      'position:absolute;top:-9999px;left:-9999px;width:100px;height:100px;overflow-y:scroll';
    doc.body.appendChild(probe);
    const width = probe.offsetWidth - probe.clientWidth;
    probe.remove();
    return Number.isFinite(width) && width > 0 ? width : 0;
  } catch {
    return 0;
  }
}

/** 取 xterm 内部的单元格 CSS 尺寸。私有字段随版本可能变动，取不到就返回 null 让调用方回退。 */
export function readCellSize(term) {
  const css = term?._core?._renderService?.dimensions?.css;
  const cell = css?.cell;
  if (!cell || !(cell.width > 0) || !(cell.height > 0)) return null;
  return { width: cell.width, height: cell.height };
}

/**
 * 按容器实际可用像素调整终端网格，返回调整后的 {cols, rows}（未变动也返回当前值）。
 * 与 FitAddon 的差别只有一处：滚动条宽度取平台实测值，而非固定 15px。
 *
 * @param {object}   term         xterm Terminal 实例
 * @param {number}   scrollbarWidth 平台滚动条占位宽度（由 measureScrollbarWidth 缓存后传入）
 * @param {Function} fallbackFit  取不到内部尺寸时的兜底（一般传 FitAddon.fit）
 */
export function fitTerminal(term, scrollbarWidth = 0, fallbackFit = null) {
  const el = term?.element;
  const parent = el?.parentElement;
  if (!el || !parent) return null;

  const cell = readCellSize(term);
  if (!cell) {
    // xterm 私有结构取不到（版本升级等），退回 FitAddon，宁可少两列也不要不 fit
    try { fallbackFit?.(); } catch {}
    return term.cols && term.rows ? { cols: term.cols, rows: term.rows } : null;
  }

  // 与 FitAddon 一致：外框尺寸读父容器（含 border-box 已扣边框的 clientWidth 语义），
  // 内边距读 .xterm 自身
  const ps = window.getComputedStyle(parent);
  const es = window.getComputedStyle(el);
  const px = v => parseFloat(v) || 0;
  const availWidth =
    Math.max(0, px(ps.getPropertyValue('width'))) -
    (px(es.getPropertyValue('padding-left')) + px(es.getPropertyValue('padding-right'))) -
    (scrollbarWidth > 0 ? scrollbarWidth : 0);
  const availHeight =
    px(ps.getPropertyValue('height')) -
    (px(es.getPropertyValue('padding-top')) + px(es.getPropertyValue('padding-bottom')));

  const grid = computeGrid({ width: availWidth, height: availHeight }, cell);
  if (!grid) return term.cols && term.rows ? { cols: term.cols, rows: term.rows } : null;

  if (grid.cols !== term.cols || grid.rows !== term.rows) {
    try {
      term._core?._renderService?.clear();
    } catch {}
    term.resize(grid.cols, grid.rows);
  }
  return grid;
}

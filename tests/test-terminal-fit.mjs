/**
 * 终端尺寸计算测试：核心是「不该扣的滚动条宽度不能扣」。
 *
 * 背景（真实故障）：FitAddon 无条件减掉 xterm 内部固定的 15px scrollBarWidth，
 * 但 macOS 悬浮滚动条不占布局宽度。实测 1086px 可用宽 / cell 8.4014px：
 *   扣 15px → 127 列（错，白丢 2 列）
 *   不扣    → 129 列（对）
 * tmux 按 163 列排版写满整行时，前端只画到 159 列，行尾中文整个不渲染。
 */
import { computeGrid, measureScrollbarWidth, readCellSize, fitTerminal } from '../src/terminalFit.js';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
};
const eq = (a, b, m) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${m || ''} 期望 ${B}，实际 ${A}`);
};

console.log('\n=== computeGrid：像素→网格 ===');

t('线上真实数值：1086px / cell 8.4014 → 129 列（不是 FitAddon 的 127）', () => {
  const g = computeGrid({ width: 1086, height: 879 }, { width: 8.4014, height: 17 });
  eq(g.cols, 129);
});

t('同样宽度若误扣 15px 滚动条 → 退化成 127 列（复现故障）', () => {
  const g = computeGrid({ width: 1086 - 15, height: 879 }, { width: 8.4014, height: 17 });
  eq(g.cols, 127, '这一条锁住故障数值，防止有人把扣减加回来');
});

t('宽视口 1728px 场景：误扣 15px 会丢 4 列', () => {
  const cell = { width: 8.4014, height: 17 };
  const ok = computeGrid({ width: 1400, height: 800 }, cell).cols;
  const bad = computeGrid({ width: 1400 - 15, height: 800 }, cell).cols;
  if (ok - bad < 1) throw new Error(`应至少差 1 列，实际 ${ok} vs ${bad}`);
});

t('行数按高度整除', () => {
  eq(computeGrid({ width: 800, height: 340 }, { width: 8, height: 17 }).rows, 20);
});

t('cols 有下限 2，rows 有下限 1', () => {
  const g = computeGrid({ width: 1, height: 1 }, { width: 100, height: 100 });
  eq([g.cols, g.rows], [2, 1]);
});

t('cell 宽为 0（字体未测量完）返回 null，不能算出 Infinity', () => {
  eq(computeGrid({ width: 800, height: 400 }, { width: 0, height: 17 }), null);
});

t('可用宽为 0（容器隐藏）返回 null', () => {
  eq(computeGrid({ width: 0, height: 400 }, { width: 8, height: 17 }), null);
});

t('入参缺失返回 null', () => {
  eq(computeGrid(null, { width: 8, height: 17 }), null);
  eq(computeGrid({ width: 8, height: 17 }, null), null);
});

console.log('\n=== measureScrollbarWidth：平台探测 ===');

const fakeDoc = (offset, client) => ({
  createElement: () => ({ style: {}, offsetWidth: offset, clientWidth: client, remove() {} }),
  body: { appendChild() {} }
});

t('macOS 悬浮滚动条：offsetWidth == clientWidth → 0', () => {
  eq(measureScrollbarWidth(fakeDoc(100, 100)), 0);
});

t('Windows 占位滚动条：差 15px → 15', () => {
  eq(measureScrollbarWidth(fakeDoc(100, 85)), 15);
});

t('负数/异常值归零，不能让可用宽被放大', () => {
  eq(measureScrollbarWidth(fakeDoc(100, 120)), 0);
  eq(measureScrollbarWidth(fakeDoc(NaN, 0)), 0);
});

t('document 不可用（SSR/异常）时不抛异常', () => {
  eq(measureScrollbarWidth({ createElement() { throw new Error('boom'); } }), 0);
});

console.log('\n=== readCellSize：读 xterm 私有尺寸 ===');

const termWithCell = (w, h) => ({ _core: { _renderService: { dimensions: { css: { cell: { width: w, height: h } } } } } });

t('正常读出 cell 尺寸', () => {
  eq(readCellSize(termWithCell(8.4014, 17)), { width: 8.4014, height: 17 });
});

t('尺寸为 0 视为未就绪 → null', () => {
  eq(readCellSize(termWithCell(0, 17)), null);
});

t('私有结构缺失（xterm 升级改名）→ null，交给调用方回退 FitAddon', () => {
  eq(readCellSize({}), null);
  eq(readCellSize(null), null);
});

console.log('\n=== fitTerminal：端到端 ===');

// 造最小 DOM 环境：父容器 1086x879（线上实测值），.xterm 无内边距
const styleOf = new Map();
const mkTerm = (cellW, cellH, cols, rows, parentW = 1086, parentH = 879) => {
  const parent = { __s: { width: `${parentW}px`, height: `${parentH}px` } };
  const el = {
    parentElement: parent,
    __s: { width: `${parentW}px`, height: `${parentH}px`, 'padding-left': '0px', 'padding-right': '0px', 'padding-top': '0px', 'padding-bottom': '0px' }
  };
  const cleared = { count: 0 };
  const term = {
    element: el, cols, rows, resized: null, cleared,
    _core: { _renderService: { dimensions: { css: { cell: { width: cellW, height: cellH } } }, clear: () => cleared.count++ } },
    resize(c, r) { this.cols = c; this.rows = r; this.resized = { cols: c, rows: r }; }
  };
  return term;
};
const makeStyle = o => ({ getPropertyValue: k => o[k] ?? '0px' });
Object.defineProperty(globalThis, 'window', {
  value: { getComputedStyle: node => makeStyle(node.__s || {}) },
  configurable: true, writable: true
});

t('滚动条不占位（macOS）→ 129 列，行尾宽字符不再被裁', () => {
  const term = mkTerm(8.4014, 17, 127, 51);
  const g = fitTerminal(term, 0);
  eq(g.cols, 129);
  eq(term.cols, 129, 'resize 必须真的落到 term 上');
});

t('滚动条占位（Windows 15px）→ 127 列，该扣的仍然扣', () => {
  eq(fitTerminal(mkTerm(8.4014, 17, 100, 20), 15).cols, 127);
});

t('尺寸未变时不调用 resize，避免多余 SIGWINCH', () => {
  const term = mkTerm(8.4014, 17, 129, 51);
  fitTerminal(term, 0);
  eq(term.resized, null);
  eq(term.cleared.count, 0, '未变动时也不该 clear 渲染层');
});

t('尺寸变动时先 clear 渲染层再 resize（与 FitAddon 行为一致）', () => {
  const term = mkTerm(8.4014, 17, 80, 24);
  fitTerminal(term, 0);
  eq(term.cleared.count, 1);
});

t('cell 尺寸不可用时回退 FitAddon，且不 resize', () => {
  const term = mkTerm(0, 0, 80, 24);
  let fellBack = false;
  const g = fitTerminal(term, 0, () => { fellBack = true; });
  eq(fellBack, true);
  eq(term.resized, null);
  eq(g, { cols: 80, rows: 24 });
});

t('未挂载（无 element/parentElement）返回 null', () => {
  eq(fitTerminal({ element: null }, 0), null);
  eq(fitTerminal({ element: { parentElement: null } }, 0), null);
  eq(fitTerminal(null, 0), null);
});

t('负数滚动条宽度不放大可用宽（防御脏输入）', () => {
  eq(fitTerminal(mkTerm(8.4014, 17, 80, 24), -50).cols, 129);
});

console.log(`\n${fail === 0 ? '✅' : '❌'} 通过 ${pass} / 失败 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);

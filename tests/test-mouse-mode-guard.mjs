/**
 * 鼠标上报模式切换去抖（src/terminalMouseModes.js）。序列取自 tmux 3.6 实录（见文件头注释）。
 *   ① 应用开 1003 时 tmux 进选择模式那一串：最终只给 xterm 一条 ?1002h（不经过 NONE、不经过 1000）
 *   ② 退出选择模式那一串：最终一条 ?1003h
 *   ③ 真的全关：给 xterm 一条 ?1000l（xterm 关任一个即 NONE）
 *   ④ 状态没变的一串（全关再全开回原样）：什么都不给 xterm
 *   ⑤ 混着非鼠标模式的整条照常交给 xterm，并如实记账
 *   ⑥ 只关 1003、还剩 1002：降到 1002
 */
import { createMouseModeState } from '../src/terminalMouseModes.js';

let pass = 0, fail = 0;
const test = (n, fn) => { try { fn(); pass++; console.log(`✅ ${n}`); } catch (e) { fail++; console.log(`❌ ${n}\n    ${e.message}`); } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); };

/** 把一串 "1006l 1000l …" 喂进去，返回：交给 xterm 的（没被拦下的）+ 批次结束补写的 */
function run(st, seq) {
  const passed = [];
  for (const tok of seq.split(/\s+/).filter(Boolean)) {
    const n = Number(tok.slice(0, -1)), on = tok.endsWith('h');
    const swallowed = on ? st.set([n]) : st.reset([n]);
    if (!swallowed) passed.push(tok);
  }
  const fix = st.settle();
  if (fix) passed.push(fix.replace('\x1b[?', ''));
  return passed;
}
const ATTACH = '1006h 1000h 1002h 1003h';
const ENTER_COPY = '1006l 1000l 1002l 1003l 1006h 1000h 1002h';
const LEAVE_COPY = '1006l 1000l 1002l 1003l 1006h 1000h 1002h 1003h';

test('① 进选择模式：xterm 只收到编码切换 + 一条 ?1002h（拖动监听不被拆）', () => {
  const st = createMouseModeState();
  run(st, ATTACH);
  eq(run(st, ENTER_COPY), ['1006l', '1006h', '1002h'], '进选择模式');
});

test('② 退出选择模式：一条 ?1003h', () => {
  const st = createMouseModeState();
  run(st, ATTACH); run(st, ENTER_COPY);
  eq(run(st, LEAVE_COPY), ['1006l', '1006h', '1003h'], '退出');
});

test('③ 应用真的关掉鼠标：一条 ?1000l', () => {
  const st = createMouseModeState();
  run(st, ATTACH);
  eq(run(st, '1000l 1002l 1003l 1006l'), ['1006l', '1000l'], '全关');
});

test('④ 全关再全开回原样：协议什么都不动', () => {
  const st = createMouseModeState();
  run(st, ATTACH);
  eq(run(st, '1000l 1002l 1003l 1000h 1002h 1003h'), [], '原样');
});

test('⑤ 混着非鼠标模式的整条交给 xterm，并记账', () => {
  const st = createMouseModeState();
  eq(st.set([1000, 2004]), false, '混合的不拦');
  eq(st.snapshot(), { want: [1000], applied: 1000 }, '记账');
  eq(st.settle(), '', '不用补');
});

test('⑥ 只关 1003、还剩 1002：降到 1002', () => {
  const st = createMouseModeState();
  run(st, ATTACH);
  eq(run(st, '1003l'), ['1002h'], '降档');
});

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);

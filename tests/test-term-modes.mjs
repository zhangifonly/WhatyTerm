/**
 * 终端模式跟踪（termModes.js）—— 失效模式：
 *   ① tmux 真实的接入序列里的鼠标上报认不出 → 新页面拖动不经 tmux、松手不复制（v1.4.76 的根因）
 *   ② 序列被 pty 分块切在中间 → 丢一次开关
 *   ③ 应用后来关掉了鼠标上报（退出全屏 TUI）→ 仍补发「开」，单击被当鼠标事件吃掉
 *   ④ 切到没开鼠标的会话 → 上一个会话的模式残留在复用的 xterm 里
 * ① 用真 tmux 客户端（node-pty）录下 tmux 实际发的字节，而不是手写一串“应该是这样”的序列。
 */
import { execFileSync } from 'child_process';
import pty from 'node-pty';
import { createModeTracker, RESET_PRELUDE } from '../server/services/termModes.js';

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n    ${e.message}`); }
};
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || ''} 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await test('① 真 tmux 接入时发的字节里能认出鼠标上报（mouse on）', async () => {
  const name = `whatyterm-modetest-${process.pid}`;
  execFileSync('tmux', ['new-session', '-d', '-s', name, '-x', '80', '-y', '24', 'sleep 20']);
  execFileSync('tmux', ['set-option', '-t', name, 'mouse', 'on']);
  const t = createModeTracker();
  const c = pty.spawn('tmux', ['attach', '-t', name], { name: 'xterm-256color', cols: 80, rows: 24, env: process.env });
  c.onData((d) => t.feed(d));
  await wait(1000);
  c.kill(); execFileSync('tmux', ['kill-session', '-t', name]);
  const s = t.snapshot();
  eq(s[1006], true, `SGR 编码（1006）没认出，快照 ${JSON.stringify(s)}`);
  eq(s[1000] || s[1002] || s[1003], true, '任何一种鼠标上报都没认出');
  eq(/\x1b\[\?100[023]h/.test(t.prelude()), true, '补发序列里没有开鼠标上报');
});

await test('② 序列被切在任意位置都能拼回来', () => {
  const seq = 'abc\x1b[?1002;1006hdef';
  for (let i = 1; i < seq.length; i++) {
    const t = createModeTracker();
    t.feed(seq.slice(0, i)); t.feed(seq.slice(i));
    eq(t.snapshot()[1002] && t.snapshot()[1006], true, `切在第 ${i} 字节丢了`);
  }
});

await test('③ 后来关掉的模式补发「关」，不是「开」', () => {
  const t = createModeTracker();
  t.feed('\x1b[?1000h\x1b[?1006h'); t.feed('输出\x1b[?1000l');
  eq(t.prelude().includes('\x1b[?1000l'), true);
  eq(t.prelude().includes('\x1b[?1000h'), false);
});

await test('④ 切会话先全关：上一个会话的鼠标上报不残留', () => {
  for (const n of [1000, 1002, 1003, 1006, 2004]) eq(RESET_PRELUDE.includes(`\x1b[?${n}l`), true, `没关 ${n}`);
  eq(createModeTracker().prelude(), '', '没见过任何模式时不该补发东西');
});

await test('⑤ 补发顺序：所有「关」在所有「开」之前（xterm.js 关任一鼠标模式即整体关闭）', () => {
  const t = createModeTracker();
  t.feed('\x1b[?1000h\x1b[?1002h\x1b[?1003l\x1b[?1006h');   // tmux 接入时的真实组合
  const p = RESET_PRELUDE + t.prelude();
  const lastOff = Math.max(...[...p.matchAll(/\x1b\[\?\d+l/g)].map((m) => m.index));
  const firstOn = Math.min(...[...p.matchAll(/\x1b\[\?\d+h/g)].map((m) => m.index));
  eq(lastOff < firstOn, true, `有「关」排在「开」后面：${JSON.stringify(p)}`);
});

await test('不跟踪的模式（光标显隐 25、备用屏 1049）不补发', () => {
  const t = createModeTracker();
  t.feed('\x1b[?25l\x1b[?1049h');
  eq(t.prelude(), '');
});

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);

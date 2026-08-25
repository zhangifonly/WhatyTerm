/**
 * 终端复制链路 —— 回归测试
 *
 * 背景：会话开着 tmux `mouse on`，滚轮和拖拽都被 tmux 接管，xterm 自己的 scrollback
 * 是空的（只持有当前可见屏）。所以「按住 Option 往上滚着选」在浏览器侧选不到滚走的内容，
 * 那些内容在 tmux 历史缓冲里。正解是让 tmux 做跨屏选择，复制结果经 OSC 52 交给前端
 * 写入系统剪贴板 —— 这条链路此前完全没接，选中的文字只进了 tmux 自己的粘贴缓冲区。
 *
 * 本测试锁住：base64 解码正确、OSC 52 只写不读、tmux 侧配置齐全且不会累积垃圾。
 *
 * 运行：node tests/test-terminal-clipboard.mjs
 */

import fs from 'fs';
import path from 'path';

const results = { passed: 0, failed: 0, errors: [] };

function test(name, fn) {
  try {
    fn();
    results.passed++;
    console.log(`✅ ${name}`);
  } catch (err) {
    results.failed++;
    results.errors.push({ name, error: err.message });
    console.log(`❌ ${name}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || '不相等'}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}

// 浏览器 API 垫片：这个模块跑在渲染进程，测试里给它最小环境
globalThis.atob = (b64) => Buffer.from(b64, 'base64').toString('binary');
globalThis.window = { electronAPI: null };
const written = [];
// Node 24 自带只读的 navigator，必须用 defineProperty 覆盖
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async (t) => { written.push(t); } } },
  configurable: true, writable: true
});
globalThis.document = {};

const { decodeBase64Utf8, registerOsc52 } = await import('../src/terminalClipboard.js');

// ============ base64 解码 ============

test('中文经 base64 往返不乱码（atob 只认 latin1，必须再解 UTF-8）', () => {
  const text = 'WhatyTerm 剪贴板验证 ✓';
  eq(decodeBase64Utf8(Buffer.from(text, 'utf8').toString('base64')), text);
});

test('多行内容保持换行', () => {
  const text = 'line1\nline2\n  缩进行';
  eq(decodeBase64Utf8(Buffer.from(text, 'utf8').toString('base64')), text);
});

// ============ OSC 52 处理 ============

/** 造一个最小 xterm 替身，只暴露 parser.registerOscHandler */
function fakeTerm() {
  let handler = null;
  return {
    parser: { registerOscHandler: (_code, fn) => { handler = fn; return { dispose() {} }; } },
    fire: (payload) => handler(payload)
  };
}

test('收到 OSC 52 写入剪贴板', async () => {
  written.length = 0;
  const term = fakeTerm();
  registerOsc52(term);
  const ok = term.fire('c;' + Buffer.from('复制的内容', 'utf8').toString('base64'));
  eq(ok, true, '必须返回 true 把序列吞掉，否则会漏到屏幕上');
});

test('查询形式（载荷为 ?）不响应 —— 否则终端里任何程序都能读走用户剪贴板', () => {
  written.length = 0;
  const term = fakeTerm();
  registerOsc52(term);
  eq(term.fire('c;?'), true);
  eq(written.length, 0, '响应了剪贴板查询，等于把剪贴板内容交给了终端里的程序');
});

test('载荷损坏不抛异常（复制失败不该打断终端）', () => {
  const term = fakeTerm();
  registerOsc52(term);
  eq(term.fire('c;!!!非法base64!!!'), true);
  eq(term.fire(''), true);
});

test('超大载荷被拒绝，不阻塞渲染', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/terminalClipboard.js'), 'utf8');
  assert(/MAX_CLIPBOARD_BYTES/.test(src), '缺少载荷上限');
  const term = fakeTerm();
  registerOsc52(term);
  eq(term.fire('c;' + 'A'.repeat(3 * 1024 * 1024)), true);
});

// ============ tmux 侧配置 ============

const SM = fs.readFileSync(path.join(process.cwd(), 'server/services/SessionManager.js'), 'utf8');

test('tmux 开启 set-clipboard，否则复制只进 tmux 自己的粘贴缓冲区', () => {
  assert(/set-option -t "\$\{this\.tmuxSessionName\}" set-clipboard on/.test(SM),
    '未开启 set-clipboard，OSC 52 根本不会发出来');
});

test('不再用 -a 追加 terminal-features（-a 不去重，每建一个会话累积一条）', () => {
  assert(!/-a terminal-features/.test(SM),
    '`set-option -a terminal-features` 会无限累积重复值；tmux 3.2+ 默认已含 xterm*:clipboard');
});

test('mouse on 仍然保留（跨屏选择靠 tmux copy-mode 自动滚动）', () => {
  assert(/set-option -t "\$\{this\.tmuxSessionName\}" mouse on/.test(SM), 'mouse on 被去掉了');
});

// ============ Electron 通道 ============

test('Electron 主进程提供 write-clipboard（浏览器 API 在非用户手势时会被拒）', () => {
  const main = fs.readFileSync(path.join(process.cwd(), 'electron/main.cjs'), 'utf8');
  const preload = fs.readFileSync(path.join(process.cwd(), 'electron/preload.cjs'), 'utf8');
  assert(/ipcMain\.handle\('write-clipboard'/.test(main), '主进程缺少 write-clipboard');
  assert(/clipboard/.test(main), '主进程未引入 clipboard 模块');
  assert(/writeClipboard: \(text\) => ipcRenderer\.invoke\('write-clipboard'/.test(preload),
    'preload 未暴露 writeClipboard');
});

test('前端接了 OSC 52 与复制快捷键', () => {
  const app = fs.readFileSync(path.join(process.cwd(), 'src/App.jsx'), 'utf8');
  assert(/registerOsc52\(term/.test(app), '终端未注册 OSC 52 处理');
  assert(/attachCustomKeyEventHandler/.test(app), '未接管复制快捷键');
  assert(/term\.getSelection\(\)/.test(app),
    'xterm 是 canvas 渲染，选中区不是 DOM 选区，浏览器原生 Cmd+C 取不到');
});

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exit(results.failed ? 1 : 0);

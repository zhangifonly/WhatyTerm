/**
 * 移动版输入：Tab 真键 + 按会话的输入历史。
 *
 * 由来：手机上没有物理 Tab 键，而补全是 CLI/shell 自己的能力，必须能把 '\t' 发进终端；
 * 另外手机打字费劲而指令高度重复（「继续」「跟上测试」），每次重敲是纯浪费。
 *
 * 运行: node tests/test-mobile-input.mjs
 */

import fs from 'fs';

// localStorage 垫片（Node 里没有）。必须在 import 被测模块之前装好
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const { loadHistory, pushHistory, clearHistory, suggest, MAX_ITEMS, MAX_LEN } =
  await import('../src/mobile/inputHistory.js');

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function test(name, fn) {
  try { fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}
const reset = () => store.clear();

test('按会话分开存：A 会话的指令不该出现在 B 会话的候选里', () => {
  reset();
  pushHistory('sA', 'git status');
  pushHistory('sB', 'npm test');
  assert(loadHistory('sA').join() === 'git status', JSON.stringify(loadHistory('sA')));
  assert(loadHistory('sB').join() === 'npm test', '串了会话 —— 候选里全是别的项目的东西');
});

test('重复的指令提到最前，不产生重复项', () => {
  reset();
  pushHistory('s', 'a1');
  pushHistory('s', 'b2');
  pushHistory('s', 'a1');            // 再用一次
  assert(loadHistory('s').join() === 'a1,b2', `刚用过的应在最前且不重复：${loadHistory('s')}`);
});

test('单字符不记 —— 1/2/3/Esc 有专门按钮，进历史只会挤掉有用的', () => {
  reset();
  pushHistory('s', '1');
  pushHistory('s', 'y');
  assert(loadHistory('s').length === 0, `记了单字符：${JSON.stringify(loadHistory('s'))}`);
  pushHistory('s', '继续');            // 两个字符起才记
  assert(loadHistory('s').join() === '继续', JSON.stringify(loadHistory('s')));
});

test('空白与超长不记；条数有上限，旧的被挤掉', () => {
  reset();
  pushHistory('s', '   ');
  pushHistory('s', 'x'.repeat(MAX_LEN + 1));
  assert(loadHistory('s').length === 0, JSON.stringify(loadHistory('s')));
  for (let i = 0; i < MAX_ITEMS + 5; i += 1) pushHistory('s', `cmd-${i}`);
  const h = loadHistory('s');
  assert(h.length === MAX_ITEMS, `条数应封顶在 ${MAX_ITEMS}，实际 ${h.length}`);
  assert(h[0] === `cmd-${MAX_ITEMS + 4}`, '最新的应在最前');
  assert(!h.includes('cmd-0'), '最旧的应被挤掉');
});

test('前缀筛选：不分大小写，且不给与前缀完全相同的那条（选它等于没变化）', () => {
  const hist = ['git status', 'git commit -m x', 'npm test', 'GIT push'];
  assert(suggest(hist, 'git').join('|') === 'git status|git commit -m x|GIT push', JSON.stringify(suggest(hist, 'git')));
  assert(suggest(hist, 'npm test').length === 0, '完全相同的不该再给');
  assert(suggest(hist, '').length === 4, '空前缀给全部（刚点进输入框就能看到最近的）');
  assert(suggest(hist, 'zzz').length === 0, '没匹配就给空');
});

test('候选条数有上限，不会长到要翻页', () => {
  const many = Array.from({ length: 20 }, (_, i) => `cmd-${i}`);
  assert(suggest(many, '', 6).length === 6, '未按 limit 截断');
  assert(suggest(many, 'cmd', 3).length === 3);
});

test('清空只影响指定会话', () => {
  reset();
  pushHistory('sA', 'aa');
  pushHistory('sB', 'bb');
  clearHistory('sA');
  assert(loadHistory('sA').length === 0 && loadHistory('sB').join() === 'bb', '清错了会话');
});

test('localStorage 抛异常时不炸（隐私模式）—— 历史读不出来不该让输入框不能用', () => {
  const saved = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('denied'); },
    removeItem: () => { throw new Error('denied'); },
  };
  assert(loadHistory('s').length === 0, 'load 应吞掉异常');
  assert(Array.isArray(pushHistory('s', '继续')), 'push 应吞掉异常并返回数组');
  globalThis.localStorage = saved;
});

test('脏数据不炸：非数组、混入非字符串', () => {
  reset();
  globalThis.localStorage.setItem('wt_m_hist_s', '{"not":"array"}');
  assert(loadHistory('s').length === 0, '非数组要当空');
  globalThis.localStorage.setItem('wt_m_hist_s', '["ok",null,123,""]');
  assert(loadHistory('s').join() === 'ok', `应只留有效字符串：${JSON.stringify(loadHistory('s'))}`);
  assert(loadHistory(null).length === 0 && suggest(null, 'x').length === 0, '空参数不炸');
});

// ── 界面守卫 ──────────────────────────────────────────────────────
const QA = fs.readFileSync(new URL('../src/mobile/QuickActions.jsx', import.meta.url), 'utf8');

test('守卫：Tab 是发真键 \\t 给终端，不是本地联想', () => {
  assert(/sendRaw\('\\t', 'Tab'\)/.test(QA), '没有 Tab 按钮，或没发 \\t —— 手机上没有物理 Tab 键，补全就用不了');
  // 必须走 sendRaw（单键直发，不带回车）；走 sendText 会多发一个 \r 把补全提交掉
  const at = QA.indexOf("'Tab'");
  assert(QA.slice(Math.max(0, at - 60), at).includes('sendRaw'),
    'Tab 走了文本两段式路径 —— 会多发回车，把还没选定的补全直接提交');
});

test('守卫：候选渲染在输入框**上方**（软键盘从下方弹起，放下面会被挡住）', () => {
  const hist = QA.indexOf('m-hist');
  const input = QA.indexOf('m-actions-input');
  assert(hist > 0 && input > 0 && hist < input, '候选放到输入框下面了，手机上会被键盘挡住');
});

test('守卫：点候选只填入不直接发（手机误触代价大）', () => {
  const at = QA.indexOf('const pick =');
  assert(at > 0, '没有 pick');
  const seg = QA.slice(at, at + 220);
  assert(/setText\(t\)/.test(seg), 'pick 没把内容填进输入框');
  assert(!/sendText|terminal:input/.test(seg), 'pick 直接发出去了 —— 手机上点错就发错指令');
});

test('守卫：切会话要重读历史（否则带着上一个项目的指令）', () => {
  assert(/loadHistory\(sessionId\)\); setShowHist\(false\); \}, \[sessionId\]\)/.test(QA)
    || /useEffect\([^)]*loadHistory[\s\S]{0,120}\[sessionId\]\)/.test(QA),
    '没有按 sessionId 重读历史');
});

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

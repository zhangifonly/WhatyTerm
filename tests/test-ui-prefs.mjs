/**
 * 界面偏好（置顶 / 列表排序模式）存服务端。
 *
 * 为什么不能留在 localStorage：**手机是另一台设备读不到** —— 电脑上置顶的会话
 * 在手机上不置顶、排序模式也各是各的，同一批会话两端顺序对不上号
 * （2026-09-21 检查移动版时发现）。
 *
 * 运行: node tests/test-ui-prefs.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

// 指到临时 HOME，绝不碰真实的 ~/.webtmux/ui-prefs.json
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'uiprefs_'));
os.homedir = () => TMP_HOME;
const { readPrefs, writePrefs, togglePinned, prunePinned, normalizePrefs, PREFS_FILE } =
  await import('../server/services/uiPrefs.js');

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function test(name, fn) {
  try { fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}
const reset = () => { try { fs.unlinkSync(PREFS_FILE); } catch { /* 本来就没有 */ } };

test('落盘在用户目录而不是项目里（这是个人偏好，不该随代码走）', () => {
  assert(PREFS_FILE.startsWith(TMP_HOME), `写到了别处：${PREFS_FILE}`);
  assert(!PREFS_FILE.includes('WebTmux/server'), '不能落在项目目录');
});

test('没有文件时返回默认值，不炸', () => {
  reset();
  const p = readPrefs();
  assert(Array.isArray(p.pinnedSessions) && p.pinnedSessions.length === 0, JSON.stringify(p));
  assert(p.sessionSort === 'fixed', p.sessionSort);
});

test('写入后能读回，且合并写只覆盖传进来的字段', () => {
  reset();
  writePrefs({ pinnedSessions: ['a', 'b'] });
  writePrefs({ sessionSort: 'pending' });
  const p = readPrefs();
  assert(p.pinnedSessions.join() === 'a,b', '第二次写把置顶冲掉了：' + JSON.stringify(p));
  assert(p.sessionSort === 'pending', p.sessionSort);
});

test('置顶是**有序数组**：顺序决定快捷键位，先置顶的先拿小号', () => {
  reset();
  togglePinned('x');
  togglePinned('y');
  assert(readPrefs().pinnedSessions.join() === 'x,y', '追加顺序错，⌘1/⌘2 会对错会话');
  togglePinned('x');                       // 取消再加，应排到末尾
  togglePinned('x');
  assert(readPrefs().pinnedSessions.join() === 'y,x', JSON.stringify(readPrefs()));
});

test('切换置顶：有就去掉，没有就加上', () => {
  reset();
  togglePinned('s1');
  assert(readPrefs().pinnedSessions.includes('s1'));
  togglePinned('s1');
  assert(!readPrefs().pinnedSessions.includes('s1'), '再点一次应取消');
});

test('脏数据一律按白名单规整：去重、去空、非法排序模式回落', () => {
  const p = normalizePrefs({ pinnedSessions: ['a', 'a', '', null, ' b '], sessionSort: '乱写' });
  assert(p.pinnedSessions.join() === 'a,b', JSON.stringify(p.pinnedSessions));
  assert(p.sessionSort === 'fixed', '非法模式要回落到默认，否则两端渲染不出东西');
  assert(normalizePrefs(null).sessionSort === 'fixed' && normalizePrefs('x').pinnedSessions.length === 0, '非对象输入');
});

test('文件损坏时返回默认值 —— 偏好读不出来不该让界面打不开', () => {
  reset();
  fs.mkdirSync(path.dirname(PREFS_FILE), { recursive: true });
  fs.writeFileSync(PREFS_FILE, '{坏JSON', 'utf8');
  const p = readPrefs();
  assert(p.sessionSort === 'fixed' && p.pinnedSessions.length === 0, JSON.stringify(p));
});

test('清理已删除会话的置顶：不清的话 ⌘1 会按在一条不存在的会话上', () => {
  reset();
  writePrefs({ pinnedSessions: ['alive1', 'gone', 'alive2'] });
  const r = prunePinned(['alive1', 'alive2', 'other']);
  assert(r.changed === true && readPrefs().pinnedSessions.join() === 'alive1,alive2', JSON.stringify(readPrefs()));
  // 没有变化时不写盘（避免无谓 IO 与广播）
  assert(prunePinned(['alive1', 'alive2']).changed === false, '无变化不该报 changed');
});

// ── 接线守卫 ──────────────────────────────────────────────────────
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

test('守卫：三个 socket 接口都在，写入后要广播（否则另一端不会跟着变）', () => {
  const idx = read('../server/index.js');
  for (const ev of ['ui:prefs', 'ui:prefs:set', 'ui:prefs:togglePin']) {
    assert(idx.includes(`socket.on('${ev}'`), `缺接口 ${ev}`);
  }
  const at = idx.indexOf("socket.on('ui:prefs:set'");
  const seg = idx.slice(at, at + 400);
  assert(/io\.emit\('ui:prefs'/.test(seg), '写入后没广播 —— 手机改了电脑不会变');
});

test('守卫：两端都不再把置顶/排序写进 localStorage（那正是对不上号的根源）', () => {
  const app = read('../src/App.jsx');
  assert(!/setItem\('webtmux_pinned_sessions'/.test(app), '桌面仍在写 localStorage 置顶');
  assert(!/setItem\('webtmux_session_sort'/.test(app), '桌面仍在写 localStorage 排序模式');
  // 迁移逻辑要保留：老用户本机的旧值得带上去，且迁完要删
  assert(/removeItem\('webtmux_pinned_sessions'\)/.test(app), '没清掉旧键，两个来源会打架');
});

fs.rmSync(TMP_HOME, { recursive: true, force: true });
console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

/**
 * Cursor CLI 接入（server/services/cursorCli.js）。屏幕样本是 cursor-agent 2026.10.01 实抓（tests/fixtures/screens/cursor-*）。
 *   ① 信任目录 / 空闲（新对话、对话中）/ 运行中 / 确认框 判对；带色码也判对；读出上下文占用
 *   ② 输入框有没发出的字标 pending；信任框留在屏上方、下面已出输入行时不再算信任框
 *   ③ 别的 CLI 的屏（Claude、Kiro、OpenCode）不认成 Cursor
 *   ④ 启动命令：本目录有对话才 --continue（没有对话时 --continue 会直接退出）
 *   ⑤ 对话记录：按 md5(cwd) 找目录，没说过话的不算；历史项目同目录取最近
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { detectCursorState, looksLikeCursor, cursorStartCommand, hasCursorChat, listCursorChats, listCursorProjectDirs, chatsDirFor }
  from '../server/services/cursorCli.js';

let pass = 0, fail = 0;
const test = (n, fn) => { try { fn(); pass++; console.log(`✅ ${n}`); } catch (e) { fail++; console.log(`❌ ${n}\n    ${e.message}`); } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); };
const fx = (n) => fs.readFileSync(new URL(`./fixtures/screens/${n}`, import.meta.url), 'utf-8');

test('① 实抓屏幕判对（含色码）', () => {
  eq(detectCursorState(fx('cursor-trust.txt')), { state: 'trust' }, '信任目录');
  eq(detectCursorState(fx('cursor-idle.txt')), { state: 'idle', fresh: true, pending: false }, '新对话');
  eq(detectCursorState(fx('cursor-idle.ansi.txt')), { state: 'idle', fresh: true, pending: false }, '新对话（带色码）');
  eq(detectCursorState(fx('cursor-running.txt')).state, 'running', '运行中');
  eq(detectCursorState(fx('cursor-confirm.txt')), { state: 'confirm' }, '确认框');
  eq(detectCursorState(fx('cursor-confirm.ansi.txt')), { state: 'confirm' }, '确认框（带色码）');
  eq(detectCursorState(fx('cursor-done.txt')), { state: 'idle', fresh: false, pending: false, contextPct: 6.8 }, '一轮结束');
  eq(detectCursorState(fx('cursor-done.ansi.txt')).contextPct, 6.9, '带色码读上下文占用');
});

test('② 没发出的字标 pending；屏上方残留信任框不算', () => {
  eq(detectCursorState(fx('cursor-pending.txt')).pending, true, 'pending');
  // cursor-idle.txt 上方就残留着信任框（「⏳ Trusting workspace...」），不能判成 trust
  eq(/Workspace Trust Required/.test(fx('cursor-idle.txt')), true, '样本里确有残留');
  // 即使没有「Trusting workspace...」那行（例如信任框被别的方式关掉），下面出了输入行就不是信任框
  eq(detectCursorState(fx('cursor-idle.txt').replace(/⏳ Trusting workspace\.\.\./, '')).state, 'idle', '残留信任框 + 输入行');
});

test('③ 所有 Cursor 样本都认得出；别的 CLI 的屏不认成 Cursor', () => {
  for (const f of fs.readdirSync(new URL('./fixtures/screens/', import.meta.url))) {
    const s = fx(f);
    if (f.startsWith('cursor-')) eq(looksLikeCursor(s), true, f);
    else { eq(looksLikeCursor(s), false, f); eq(detectCursorState(s), null, `${f} 状态`); }
  }
});

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-test-'));
const chat = (cwd, id, meta) => {
  const d = path.join(chatsDirFor(cwd, HOME), id);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ cwd, ...meta }));
};
chat('/w/a', 'c1', { hasConversation: true, updatedAtMs: 1000 });
chat('/w/a', 'c2', { hasConversation: true, updatedAtMs: 3000 });
chat('/w/b', 'c3', { hasConversation: true, updatedAtMs: 2000 });
chat('/w/empty', 'c4', { hasConversation: false, updatedAtMs: 9000 });

test('④ 启动命令：有对话才 --continue', () => {
  const has = (cwd) => hasCursorChat(cwd, HOME);
  eq(cursorStartCommand('/w/a', { has }), 'cursor-agent --continue', '有对话');
  eq(cursorStartCommand('/w/empty', { has }), 'cursor-agent', '只开过没说话');
  eq(cursorStartCommand('/w/none', { has }), 'cursor-agent', '没开过');
  eq(cursorStartCommand('', { has }), 'cursor-agent', '没有目录');
});

test('⑤ 对话目录是 md5(cwd)；历史项目同目录取最近、没说过话的不算', () => {
  eq(path.basename(chatsDirFor('/Users/x/proj', HOME)), crypto.createHash('md5').update('/Users/x/proj').digest('hex'), '目录哈希');
  eq(listCursorChats(HOME).map((c) => c.id), ['c2', 'c3', 'c1'], '对话按时间排');
  eq(listCursorProjectDirs(HOME), [{ path: '/w/a', lastUsed: 3000 }, { path: '/w/b', lastUsed: 2000 }], '项目');
});

fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);

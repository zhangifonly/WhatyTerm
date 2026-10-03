/**
 * 打开历史项目的共用规则（桌面版与移动版都走 src/utils/projectOpen.js）
 *   ① 同目录不同 CLI 是两个会话：点 Codex 项目不能切到同目录的 Claude 会话（历史上真出过）
 *   ② 路径末尾斜杠不影响匹配
 *   ③ 「正在创建」的键带 CLI 类型，会话列表回来后能按同一格式清掉（旧版键格式对不上，标记永不清除）
 *   ④ WebTmux 后台调 CLI 的临时目录不进历史项目
 */
import os from 'os';
import fs from 'fs';
import { findExistingSession, creatingKeyOf, resumePayload, timeAgo } from '../src/utils/projectOpen.js';
import { isTempPath } from '../server/services/RecentProjectsService.js';

let pass = 0, fail = 0;
const test = (n, fn) => { try { fn(); pass++; console.log(`✅ ${n}`); } catch (e) { fail++; console.log(`❌ ${n}\n    ${e.message}`); } };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); };

const sessions = [
  { id: 'c1', aiType: 'claude', workingDir: '/work/app' },
  { id: 'x1', aiType: 'codex', workingDir: '/work/other/' },
];

test('① 同目录只有 Claude 会话时，点 Codex 项目不会切过去', () => {
  eq(findExistingSession(sessions, { path: '/work/app', aiType: 'codex' }), null, 'codex');
  eq(findExistingSession(sessions, { path: '/work/app', aiType: 'claude' })?.id, 'c1', 'claude');
  eq(findExistingSession(sessions, { path: '/work/app' })?.id, 'c1', '不写类型按 claude');
});

test('② 路径末尾斜杠不影响匹配', () => {
  eq(findExistingSession(sessions, { path: '/work/other', aiType: 'codex' })?.id, 'x1', '会话侧带斜杠');
  eq(findExistingSession(sessions, { path: '/work/app/', aiType: 'claude' })?.id, 'c1', '项目侧带斜杠');
});

test('③ 防重复点击的键：同目录不同 CLI 不冲突；会话回来后用同一函数算出的键能对上', () => {
  const a = creatingKeyOf({ path: '/work/app/', aiType: 'codex' });
  const b = creatingKeyOf({ path: '/work/app', aiType: 'claude' });
  eq(a === b, false, '不同 CLI 的键不能相同');
  eq(creatingKeyOf({ aiType: 'codex', path: '/work/app' }), a, '会话列表侧算出的键');
  const pl = resumePayload({ name: 'app', path: '/work/app', aiType: 'codex', resumeCommand: 'codex resume --last' });
  eq(pl.workingDir + '|' + pl.aiType + '|' + pl.resumeCommand, '/work/app|codex|codex resume --last', '续接载荷');
});

test('④ 临时目录不算项目（含 macOS /private/var/folders 真实路径），正常目录不受影响', () => {
  eq(isTempPath(os.tmpdir() + '/webtmux-claude-text'), true, 'os.tmpdir 下');
  eq(isTempPath(fs.realpathSync(os.tmpdir()) + '/webtmux-claude-text'), true, '真实路径');
  eq(isTempPath('/private/var/folders/j2/abc/T'), true, '实测出现的那条');
  eq(isTempPath('/Users/me/Documents/tmpfoo'), false, '名字里带 tmp 的正常目录');
  eq(isTempPath('/tmpx/app'), false, '前缀相同但不是同一目录');
});

test('timeAgo 文案', () => {
  const now = 10 * 86400e3;
  eq(timeAgo(now - 30e3, now), '刚刚', '秒级');
  eq(timeAgo(now - 5 * 60e3, now), '5 分钟前', '分钟');
  eq(timeAgo(now - 3 * 3600e3, now), '3 小时前', '小时');
  eq(timeAgo(now - 2 * 86400e3, now), '2 天前', '天');
});

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);

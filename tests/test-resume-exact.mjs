/**
 * 重启 / 出错后续接到**原来那段对话**，以及不再误删还活着的会话。
 *
 * 由来（2026-09-26 Hitech）：
 * ① 重启后用 `claude -c`，它跳过 `claude -p` 开出来的对话 → 长程转终端后接着用的对话被跳过，接回 9-18 的旧对话；
 * ② 附着客户端断开时 `tmux has-session` 查询一出错就当会话退出 → 会话记录被删、tmux 其实还活着 → 重启后没重建。
 *
 * 运行: node tests/test-resume-exact.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { claudeStartCommand, claudeTranscriptPath } from '../server/services/sessionMode.js';
import { classifyHasSession, confirmTmuxGone, probeTmuxSession } from '../server/services/tmuxGone.js';

let pass = 0, fail = 0;
const queue = [];
const test = (name, fn) => queue.push([name, fn]);
const assert = (c, m) => { if (!c) throw new Error(m || '断言失败'); };

const ID = '58215909-4156-48e6-91de-baa87326328f';
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-home-'));
const WD = '/Users/demo/Documents/ClaudeCode/Hitech';
const file = claudeTranscriptPath(WD, ID, HOME);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, '{}\n');

test('Hitech 的情形：普通会话、没有「来自长程」标记、记录文件在 → 按 id 精确接回，不再用 claude -c', () => {
  const cmd = claudeStartCommand({ claudeSessionId: ID, workingDir: WD, origin: null }, 'claude -c', { home: HOME });
  assert(cmd === `claude --resume ${ID}`, cmd);
});

test('记录文件不在（被清理 / id 过期）→ 退回 claude -c，不会 --resume 一个不存在的对话', () => {
  const other = '00000000-0000-0000-0000-000000000000';
  assert(claudeStartCommand({ claudeSessionId: other, workingDir: WD }, 'claude -c', { home: HOME }) === 'claude -c');
});

test('非法 id 不拼进命令；非 claude 的 CLI 照用自己的续接命令', () => {
  assert(claudeStartCommand({ claudeSessionId: 'x; rm -rf /', workingDir: WD }, 'claude -c', { home: HOME }) === 'claude -c');
  assert(claudeStartCommand({ claudeSessionId: ID, workingDir: WD }, 'grok -c', { home: HOME }) === 'grok -c');
});

test('记录目录编码与 Claude 一致：非字母数字（含下划线、点）一律换成 -', () => {
  const p = claudeTranscriptPath('/Users/a/GigaPlace_Engine/x.y', ID, '/h');
  assert(p === `/h/.claude/projects/-Users-a-GigaPlace-Engine-x-y/${ID}.jsonl`, p);
});

test('tmux 判定：只有明确「找不到会话 / 没有 tmux 服务」才算没了；查询出错一律说不准', () => {
  assert(classifyHasSession({ status: 0 }) === 'alive');
  assert(classifyHasSession({ status: 1, stderr: "can't find session: whatyterm-x" }) === 'gone');
  assert(classifyHasSession({ status: 1, stderr: 'no server running on /tmp/tmux-501/default' }) === 'gone');
  assert(classifyHasSession({ status: null, signal: 'SIGTERM' }) === 'unknown', '被信号打断当成了会话没了');
  assert(classifyHasSession({ status: null, error: new Error('spawn ENOENT') }) === 'unknown', '命令没跑起来当成了会话没了');
  assert(classifyHasSession({ status: 1, stderr: 'server exited unexpectedly' }) === 'unknown');
});

test('说不准就再查；查满仍说不准返回 unknown（调用方不得当成退出）', async () => {
  const seq = (arr) => { let i = 0; return () => arr[Math.min(i++, arr.length - 1)]; };
  const nosleep = { sleep: async () => {} };
  assert(await confirmTmuxGone(seq(['unknown', 'unknown', 'gone']), nosleep) === 'gone');
  assert(await confirmTmuxGone(seq(['unknown', 'alive']), nosleep) === 'alive');
  assert(await confirmTmuxGone(seq(['unknown']), nosleep) === 'unknown');
});

test('真实 tmux：存在的会话 → alive，不存在的 → gone', () => {
  const name = `resume-probe-${process.pid}`;
  spawnSync('tmux', ['new-session', '-d', '-s', name, 'sleep 30']);
  try {
    assert(probeTmuxSession(['tmux'], name) === 'alive');
    assert(probeTmuxSession(['tmux'], `${name}-nope`) === 'gone');
  } finally { spawnSync('tmux', ['kill-session', '-t', name]); }
});

const SM = fs.readFileSync(new URL('../server/services/SessionManager.js', import.meta.url), 'utf8');
test('接线：附着断开后只在确认 gone 时触发退出回调；重建续接带上工作目录', () => {
  const at = SM.indexOf("confirmTmuxGone(() => probeTmuxSession(tmuxCmd, this.tmuxSessionName))");
  assert(at > 0, '附着断开没走确认');
  const block = SM.slice(at, SM.indexOf('.catch((err)', at));
  const gone = block.indexOf("verdict === 'gone'"), cb = block.indexOf('this.exitCallbacks.forEach');
  assert(gone > 0 && cb > gone && cb < block.indexOf("verdict === 'alive'"), '退出回调不只在确认 gone 的分支里');
  assert(!/has-session -t "\$\{this\.tmuxSessionName\}"`, \{ stdio: 'pipe' \}\);\s*\/\/ tmux 会话还存在/.test(SM), '旧的一出错就删的写法还在');
  assert(/claudeSessionId: row\.claude_session_id \|\| null,\s*workingDir: row\.working_dir/.test(SM), '重建续接没带工作目录，按 id 接回找不到记录文件');
});

for (const [name, fn] of queue) {
  try { await fn(); pass++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n    ${e.message}`); }
}
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);

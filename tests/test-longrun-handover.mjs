/**
 * 长程 → 终端交接 —— 回归测试
 *
 * 锁住：会话 id 取值链四级兜底（交接后内存与 state 会是 null）、按水位自动选接续方式、启动命令的转义、
 * 残留投件清理、输入框就绪判断（不能被刚打的 claude 命令骗到）、服务层计划、重启路径改用 --resume、
 * 重建 tmux 时长程条目不起 CLI、socket 执行顺序。
 *
 * 运行: node tests/test-longrun-handover.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lr_handover_')));
process.env.LONGRUN_CLAUDE_PROJECTS = path.join(TMP, 'claude_projects');
process.env.LONGRUN_PROJECTS_ROOT = path.join(TMP, 'projects');
process.env.LONGRUN_SANDBOX_BASE = path.join(TMP, 'legacy');
const H = await import('../server/services/LongRunHandover.js');
const { claudeStartCommand } = await import('../server/services/sessionMode.js');
const { LongRunService } = await import('../server/services/LongRunService.js');

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
async function test(name, fn) {
  try { await fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}
const U = (n) => `${String(n).repeat(8)}-1111-2222-3333-444444444444`;
function project(name) {
  const root = path.join(process.env.LONGRUN_PROJECTS_ROOT, name);
  fs.mkdirSync(path.join(root, '.run'), { recursive: true });
  fs.mkdirSync(H.transcriptDir(root), { recursive: true });
  return root;
}
const transcript = (root, id, mtime) => {
  const f = path.join(H.transcriptDir(root), `${id}.jsonl`);
  fs.writeFileSync(f, '{}');
  if (mtime) fs.utimesSync(f, mtime, mtime);
};
const events = (root, list) => fs.writeFileSync(path.join(root, '.run', 'orchestrator.jsonl'), list.map((e) => JSON.stringify(e)).join('\n') + '\n');

await test('会话 id 取值链：内存 → session_state → 事件文件最后一发 → 会话记录最新文件；每级都要求记录文件真的存在', () => {
  const root = project('chain');
  transcript(root, U(1)); transcript(root, U(2)); transcript(root, U(3), new Date('2020-01-01'));
  fs.writeFileSync(path.join(root, '.run', 'session_state.json'), JSON.stringify({ session_id: U(2) }));
  events(root, [{ kind: 'result', session_id: U(3), context_peak: 10 }, { kind: 'log' }, 'bad-line']);
  assert(H.resolveClaudeSessionId({ root, liveSessionId: U(1) }).source === '运行中的任务');
  assert(H.resolveClaudeSessionId({ root, liveSessionId: U(9) }).id === U(2), '内存 id 没有记录文件时要往下兜底');
  fs.writeFileSync(path.join(root, '.run', 'session_state.json'), JSON.stringify({ session_id: null }));   // 交接后被置 null
  assert(H.resolveClaudeSessionId({ root }).id === U(3), '事件文件最后一发');
  fs.rmSync(path.join(root, '.run', 'orchestrator.jsonl'));
  const r = H.resolveClaudeSessionId({ root });
  assert(r.id === U(1) || r.id === U(2), `应取记录目录里最新的: ${JSON.stringify(r)}`);
  assert(H.resolveClaudeSessionId({ root: project('none') }) === null);
  assert(H.resolveClaudeSessionId({ root, liveSessionId: '../../etc/passwd' }).id !== '../../etc/passwd', '非 UUID 不能进命令');
});

await test('按水位自动选：低于交接下限续同一对话；到了下限、取不到水位、找不到会话 id 都开新对话；可强制', () => {
  const d = (mode, peak, has = true) => H.decideHandover(mode, { peak, handoffFloor: 200000, hasSessionId: has }).mode;
  assert(d('auto', 50000) === 'resume' && d('auto', 200000) === 'fresh' && d('auto', 350000) === 'fresh');
  assert(d('auto', null) === 'fresh' && d('auto', 1000, false) === 'fresh' && d('resume', 999999) === 'resume');
  assert(d('resume', 10, false) === 'fresh', '没有会话 id 时指定 resume 也只能开新对话');
  assert(d('fresh', 10) === 'fresh');
  assert(/低于交接下限/.test(H.decideHandover('auto', { peak: 5, handoffFloor: 200000, hasSessionId: true }).reason));
});

await test('启动命令：resume 带会话 id；外部参考与模型单引号转义', () => {
  assert(H.buildLaunchCommand({ mode: 'resume', claudeSessionId: U(1) }) === `claude --resume ${U(1)}`);
  assert(H.buildLaunchCommand({ mode: 'fresh', claudeSessionId: U(1) }) === 'claude', 'fresh 不带会话 id');
  const c = H.buildLaunchCommand({ mode: 'resume', claudeSessionId: U(1), extraDirs: ["/a/it's $HOME"], model: 'claude-opus-5' });
  assert(c === `claude --resume ${U(1)} --add-dir '/a/it'\\''s $HOME' --model 'claude-opus-5'`, c);
  assert(H.buildShellLine("/p/it's $x", 'claude') === `cd '/p/it'\\''s $x' && claude`, '目录也要单引号转义');
});

await test('清掉残留的暂停与投件文件（否则下次长程第一发突然生效）', () => {
  const root = project('leftover');
  for (const f of ['pause', 'inject.txt', 'inject!.txt', 'session_state.json']) fs.writeFileSync(path.join(root, '.run', f), 'x');
  assert(JSON.stringify(H.clearLeftoverInjections(root)) === '["pause","inject.txt","inject!.txt"]');
  assert(fs.existsSync(path.join(root, '.run', 'session_state.json')), '别的文件不能删');
});

await test('输入框就绪：认 claude 底栏与 ❯ 输入行（剥 ANSI 后）；刚在 shell 里打的 claude 命令不算', () => {
  const shell = 'zhangzhen@mac jsonfmt2 % cd /x && claude --resume 11111111-1111\nWelcome to Claude Code';
  assert(!H.isClaudeInputReady(shell), '命令回显与启动横幅不能当就绪');
  const ui = '╭────╮\n│ \x1b[1m❯\x1b[0m \x1b[2mTry "fix lint errors"\x1b[0m │\n╰────╯\n  \x1b[38;5;246m? for\x1b[0m\x1b[38;5;246m shortcuts\x1b[0m';
  assert(H.isClaudeInputReady(ui), '带色码的底栏要认出来');
  assert(H.isClaudeInputReady('...\n❯ \n  ⏵⏵ accept edits on (shift+tab to cycle)'));
  assert(H.bracketedPaste('a\nb') === '\x1b[200~a\nb\x1b[201~');
});

await test('重启命令：来自长程且有合法会话 id 用 --resume，其余维持 claude -c', () => {
  assert(claudeStartCommand({ origin: 'longrun', claudeSessionId: U(4) }) === `claude --resume ${U(4)}`);
  assert(claudeStartCommand({ origin: null, claudeSessionId: U(4) }) === 'claude -c', '普通会话不变');
  assert(claudeStartCommand({ origin: 'longrun', claudeSessionId: 'x; rm -rf /' }) === 'claude -c', '非法 id 不拼进命令');
  assert(claudeStartCommand({ origin: 'longrun' }, 'grok -c') === 'grok -c');
});

await test('服务层交接计划：在跑拒绝；按最后一发水位选方式；fresh 带新对话开始提示词；带回长程期间移走的会话级供应商', async () => {
  const root = project('plan');
  transcript(root, U(5));
  events(root, [{ kind: 'result', session_id: U(5), context_peak: 120000 }]);
  fs.writeFileSync(path.join(root, '.run', 'provider-env.backup.json'), JSON.stringify({ _localProviderId: 'p9', env: {} }));
  const binder = { get: (id) => (id === 's1' ? { workingDir: root } : null) };
  const svc = new LongRunService({ sessionBinder: binder });
  const low = svc.handoverPlan('s1');
  assert(low.ok && low.mode === 'resume' && low.command === `claude --resume ${U(5)}` && low.claudeSessionId === U(5) && low.providerId === 'p9', JSON.stringify(low));
  assert(!low.resumePrompt, 'resume 不发开场提示词');
  assert(low.shellLine === `cd '${root}' && claude --resume ${U(5)}`, `界面展示与实际发送是同一行：${low.shellLine}`);
  events(root, [{ kind: 'result', session_id: U(5), context_peak: 260000 }]);
  const high = svc.handoverPlan('s1');
  assert(high.mode === 'fresh' && high.command === 'claude' && high.claudeSessionId === null && high.resumePrompt.length > 50, JSON.stringify({ ...high, resumePrompt: high.resumePrompt.slice(0, 20) }));
  assert(svc.handoverPlan('nope').ok === false);
  svc.tasks.set('t', { sessionId: 's1', state: 'running', startedAt: 1, sandbox: { root } });
  assert(/还在跑/.test(svc.handoverPlan('s1').error), '长程在跑时不能转');
});

const idx = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
const between = (text, from, len = 5000) => { const i = text.indexOf(from); assert(i >= 0, `找不到: ${from}`); return text.slice(i, i + len); };

await test('longrun:toTerminal 执行顺序：CLI 在跑拒绝 → 清残留 → 恢复供应商 → 切模式落库 → 打命令 → fresh 等就绪再粘贴', () => {
  const h = between(idx, "socket.on('longrun:toTerminal'", 4000);
  const order = ['isLongRunMode(session)', 'isCliRunning(tmux)', 'clearLeftoverInjections(plan.root)', 'applySessionProvider(session',
    "session.runMode = 'terminal'", 'sessionManager.updateSession(session)', 'tmuxSendLiteral(tmux, plan.shellLine)', 'isClaudeInputReady(', 'bracketedPaste(plan.resumePrompt)'];
  let last = -1;
  for (const k of order) { const i = h.indexOf(k); assert(i > last, `顺序不对或缺失: ${k}`); last = i; }
  assert(h.includes("session.waterlineMode = 'warn'") && h.includes('session.autoActionEnabled = false') && h.includes("session.origin = 'longrun'"));
  const paste = h.indexOf('bracketedPaste(plan.resumePrompt)');
  assert(h.slice(paste, paste + 200).includes('setTimeout(r, 50)'), '文本与回车要分两次发');
});

await test('重启路径：切供应商重启、出错自动修复、重建会话续接都按来历选命令；重建时长程条目不起 CLI；hook 持久化会话 id', () => {
  assert(idx.includes('const restartCmd = `${envCmds} && ${claudeStartCommand(session)}`;'), '切供应商重启');
  const fix = between(idx, '步骤3 - 发送', 400);
  assert(idx.includes('const startCmd = claudeStartCommand(session);') && fix.includes('startCmd'), '出错自动修复');
  assert(!/send-keys -t "\$\{ctx\.tmuxSession\}" "claude -c"/.test(idx), '仍有写死的 claude -c');
  const sm = fs.readFileSync(new URL('../server/services/SessionManager.js', import.meta.url), 'utf8');
  assert(sm.includes("if (row.run_mode !== 'longrun') {") && sm.includes('startCmd = claudeStartCommand(item, startCmd)'), '重建会话');
  const hook = between(idx, '持久化当前 claude 会话 id', 400);
  assert(hook.includes('session.claudeSessionId !== claudeId') && hook.includes('!isLongRunMode(session)') && hook.includes('updateSession'), 'hook 持久化');
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exit(results.failed ? 1 : 0);

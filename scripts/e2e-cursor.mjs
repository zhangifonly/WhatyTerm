/**
 * Cursor CLI 接入 E2E：真服务 + 真 cursor-agent（Cursor 账号，按订阅计费，跑一两轮 Auto 模型）。
 * 场景：从「历史项目」入口在新目录开 Cursor 会话 → 新目录没有对话，命令不能带 --continue（带了会直接退出）→
 *      出现信任目录框，打开自动操作也不替人点 → 测试自己按 a（是测试建的目录）→ 面板是 Cursor 官方账号 →
 *      发一个要跑命令的任务 → 确认框出现后监控按 y 放行一次 → allowlist 没多东西 → 用量如实说拿不到 →
 *      删掉会话再从历史项目开一次 → 这回带 --continue，接回刚才的对话 → 清理（会话、目录、Cursor 记录）。
 * 运行：node scripts/e2e-cursor.mjs
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { chatsDirFor } from '../server/services/cursorCli.js';

const { io } = await import(path.resolve('node_modules/socket.io-client/build/esm-debug/index.js'));
const DIR = path.join(os.homedir(), 'wtcursore2e');
fs.mkdirSync(DIR, { recursive: true });
const CFG = path.join(os.homedir(), '.cursor', 'cli-config.json');
const allowOf = () => JSON.stringify(JSON.parse(fs.readFileSync(CFG, 'utf8')).permissions || {});
const allowBefore = allowOf();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const screen = (t) => execFileSync('tmux', ['capture-pane', '-p', '-t', t], { encoding: 'utf-8' });
const waitFor = async (t, re, ms) => { for (let i = 0; i < ms / 1000; i++) { if (re.test(screen(t))) return true; await sleep(1000); } return false; };
let fail = 0;
const ok = (n, c, d = '') => { console.log(`${c ? '✅' : '❌'} ${n} ${c ? '' : d}`); if (!c) fail++; };
const s = io('http://127.0.0.1:3928', { transports: ['websocket'] });
await new Promise((r) => s.on('connect', r));
const usage = {};
s.on('sessions:usage', (u) => Object.assign(usage, u));
const ids = [];
const open = async () => {
  const created = new Promise((r) => s.once('session:created', r));
  s.emit('session:createAndResume', { name: 'wtcursore2e', aiType: 'cursor', workingDir: DIR, projectName: 'wtcursore2e', resumeCommand: 'cursor-agent --continue' });
  const sess = await created;
  // 断言目标是测试自己建的（e2e-never-touch-user-sessions）
  if (sess.workingDir !== DIR || sess.name !== 'wtcursore2e') throw new Error(`建出来的不是测试会话：${sess.name}`);
  ids.push(sess.id);
  return { sess, t: `whatyterm-${sess.id.slice(0, 8)}` };
};
const auto = (id, on) => s.emit('session:updateSettings', { sessionId: id, settings: { autoActionEnabled: on } });
try {
  const { sess, t } = await open();
  ok('新目录：命令没带 --continue，出现信任目录框', await waitFor(t, /Workspace Trust Required/, 30000) && !/--continue/.test(screen(t)), screen(t).slice(-500));
  auto(sess.id, true);
  await sleep(12000);
  ok('打开自动操作后也不替人点信任', /\[a\] Trust this workspace/.test(screen(t)) && !/Trusting workspace/.test(screen(t)), screen(t).slice(-300));
  auto(sess.id, false);
  execFileSync('tmux', ['send-keys', '-t', t, '-l', 'a']);
  ok('信任后出现新对话输入行', await waitFor(t, /→ Plan, search, build anything/, 30000), screen(t).slice(-300));
  ok('面板是 Cursor 官方账号且已登录', sess.cursorProvider?.id === 'cursor' && sess.cursorProvider?.exists === true && !!sess.cursorProvider?.oauthEmail,
    JSON.stringify(sess.cursorProvider));

  s.emit('terminal:input', { sessionId: sess.id, input: 'Run the shell command: echo WTCUR_E2E_OK and tell me the output.' });
  await sleep(300);
  s.emit('terminal:input', { sessionId: sess.id, input: '\r' });
  ok('确认框出现', await waitFor(t, /Run this command\?/, 90000), screen(t).slice(-500));
  auto(sess.id, true);
  const done = await waitFor(t, /WTCUR_E2E_OK[\s\S]*→ Add a follow-up/, 90000);
  auto(sess.id, false);
  ok('监控按 y 放行，命令跑完', done && !/Run this command\?/.test(screen(t)), screen(t).slice(-600));
  ok('只放行这一次：allowlist 没变', allowOf() === allowBefore, `${allowBefore} → ${allowOf()}`);
  for (let i = 0; i < 75 && !usage[sess.id]; i++) await sleep(1000);
  ok('用量如实说明拿不到', usage[sess.id]?.kind === 'unsupported' && /订阅/.test(usage[sess.id]?.reason || ''), JSON.stringify(usage[sess.id]));

  s.emit('session:delete', sess.id);
  await sleep(3000);
  const again = await open();
  ok('再开一次：本目录有对话了，带 --continue 接回原对话', await waitFor(again.t, /WTCUR_E2E_OK[\s\S]*→ Add a follow-up/, 40000)
    // 启动命令那行在 TUI 上方，已滚出可见区：连回滚区一起查
    && /cursor-agent --continue/.test(execFileSync('tmux', ['capture-pane', '-p', '-S', '-500', '-t', again.t], { encoding: 'utf-8' })), screen(again.t).slice(-500));
} catch (e) {
  fail++; console.log(`❌ ${e.message}`);
} finally {
  for (const id of ids) { auto(id, false); s.emit('session:delete', id); }
  await sleep(3000);
  s.close();
  fs.rmSync(chatsDirFor(DIR), { recursive: true, force: true });
  fs.rmSync(path.join(os.homedir(), '.cursor', 'projects', DIR.replace(/^\//, '').replace(/[^A-Za-z0-9]/g, '-')), { recursive: true, force: true });
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(`\n=== ${fail ? `${fail} 项失败` : '全部通过'} ===`);
  process.exit(fail ? 1 : 0);
}

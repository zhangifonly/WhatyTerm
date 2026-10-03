/**
 * OpenCode 接入 E2E：真服务 + 真 opencode + CC Switch 当前的 Claude 供应商（会发几次真实请求，花一点钱）。
 * 场景：从「历史项目」入口开一个 OpenCode 会话 → 会话配置按 CC Switch 当前供应商自动写好、面板显示它 →
 *      opencode 起来，底栏显示的就是这家供应商 → 在面板里切一次供应商（同一家，走一遍写配置 + 测试请求）→
 *      发一个要跑命令的任务（项目配置里把 bash 设成 ask，逼出确认框）→ 打开自动操作 → 监控在高亮「Allow once」时回车 →
 *      命令跑完、立刻关自动操作 → 用量卡片有 token → 清理（会话、目录、OpenCode 记录）。
 * 运行：node scripts/e2e-opencode.mjs
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import Database from 'better-sqlite3';

const { io } = await import(path.resolve('node_modules/socket.io-client/build/esm-debug/index.js'));
const DIR = path.join(os.homedir(), 'wtopencodee2e');
fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(path.join(DIR, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', permission: { bash: 'ask' } }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const screen = (t) => execFileSync('tmux', ['capture-pane', '-p', '-t', t], { encoding: 'utf-8' });
const waitFor = async (t, re, ms) => { for (let i = 0; i < ms / 1000; i++) { if (re.test(screen(t))) return true; await sleep(1000); } return false; };
let fail = 0;
const ok = (n, c, d = '') => { console.log(`${c ? '✅' : '❌'} ${n} ${c ? '' : d}`); if (!c) fail++; };
// 当前供应商以 CC Switch 的 settings.json 为准（与服务端 queryCcSwitchCurrentRow 同口径），库里 is_current 只作兜底
let curId = '';
try { curId = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.cc-switch', 'settings.json'), 'utf8')).currentProviderClaude || ''; } catch { /* 老版本 */ }
const ccdb = new Database(path.join(os.homedir(), '.cc-switch', 'cc-switch.db'), { readonly: true });
const current = (curId && ccdb.prepare("SELECT id, name FROM providers WHERE id = ? AND app_type = 'claude'").get(curId))
  || ccdb.prepare("SELECT id, name FROM providers WHERE app_type = 'claude' AND is_current = 1").get();
const s = io('http://127.0.0.1:3928', { transports: ['websocket'] });
await new Promise((r) => s.on('connect', r));
const permRows = () => new Database(path.join(os.homedir(), '.local/share/opencode/opencode.db'), { readonly: true }).prepare('SELECT COUNT(*) n FROM permission').get().n;
const permBefore = permRows();
let usageView = null, id = null;
s.on('sessions:usage', (u) => { if (id && u[id]) usageView = u[id]; });
try {
  const created = new Promise((r) => s.once('session:created', r));
  s.emit('session:createAndResume', { name: 'wtopencodee2e', aiType: 'opencode', workingDir: DIR, projectName: 'wtopencodee2e', resumeCommand: 'opencode -c' });
  const sess = await created; id = sess.id;
  const t = `whatyterm-${id.slice(0, 8)}`;
  // 断言目标是测试自己建的（e2e-never-touch-user-sessions）
  if (sess.workingDir !== DIR || sess.name !== 'wtopencodee2e') throw new Error(`建出来的不是测试会话：${sess.name}`);
  const cfgFile = path.join(os.homedir(), '.webtmux', 'sessions', id, 'opencode', 'opencode.json');
  ok('opencode 起来了，底栏显示 CC Switch 当前供应商', await waitFor(t, new RegExp(`Build · \\S+ ${current.name}`), 40000), screen(t).slice(-600));
  ok('会话配置已写好且权限是 0600（里面有密钥）', fs.existsSync(cfgFile) && (fs.statSync(cfgFile).mode & 0o777) === 0o600);
  const pids = execFileSync('pgrep', ['-f', 'opencode'], { encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
  ok('opencode 进程带着本会话的 OPENCODE_CONFIG', pids.some((p) => { try { return execFileSync('ps', ['eww', '-o', 'command=', '-p', p], { encoding: 'utf-8' }).includes(`OPENCODE_CONFIG=${cfgFile}`); } catch { return false; } }));

  const done = new Promise((r) => { s.once('provider:switchComplete', (d) => r({ ok: true, d })); s.once('provider:switchError', (d) => r({ ok: false, d })); });
  s.emit('provider:switch', { sessionId: id, appType: 'opencode', providerId: current.id });
  const sw = await done;
  ok('面板切换供应商：写配置 + 测试请求通过', sw.ok, JSON.stringify(sw.d));

  s.emit('terminal:input', { sessionId: id, input: 'Run the shell command: echo WTOC_E2E_OK and tell me the output.' });
  await sleep(300);
  s.emit('terminal:input', { sessionId: id, input: '\r' });
  ok('确认框出现', await waitFor(t, /Permission required/, 90000), screen(t).slice(-500));
  s.emit('session:updateSettings', { sessionId: id, settings: { autoActionEnabled: true } });
  const approved = await waitFor(t, /WTOC_E2E_OK[\s\S]*▣\s+Build · \S+ · \d/, 90000);
  s.emit('session:updateSettings', { sessionId: id, settings: { autoActionEnabled: false } });
  ok('监控回车放行，命令跑完', approved, screen(t).slice(-600));
  ok('选的是「Allow once」，没有选「Allow always」（永久放行会在 permission 表里多一行）', permRows() === permBefore, `${permBefore} → ${permRows()}`);
  for (let i = 0; i < 75 && !(usageView?.byModel?.[0]?.input > 0); i++) await sleep(1000);
  ok('用量卡片有本会话的 token', usageView?.byModel?.[0]?.input > 0, JSON.stringify(usageView));
} catch (e) {
  fail++; console.log(`❌ ${e.message}`);
} finally {
  if (id) { s.emit('session:updateSettings', { sessionId: id, settings: { autoActionEnabled: false } }); s.emit('session:delete', id); }
  await sleep(3000);
  s.close();
  // OpenCode 里这个目录的对话一并删掉（用它自己的命令，不直接改它的库）
  const real = fs.realpathSync(DIR);
  try {
    for (const x of JSON.parse(execFileSync('opencode', ['session', 'list', '--format', 'json'], { cwd: DIR, encoding: 'utf-8' })))
      if (x.directory === real) execFileSync('opencode', ['session', 'delete', x.id], { cwd: DIR });
  } catch { /* 格式变了就留着 */ }
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(`\n=== ${fail ? `${fail} 项失败` : '全部通过'} ===`);
  process.exit(fail ? 1 : 0);
}

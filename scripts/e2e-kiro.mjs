/**
 * Kiro CLI 接入 E2E：真服务 + 真 kiro-cli（会消耗约 0.1~0.2 credits）。
 * 场景：从「历史项目」入口开一个 Kiro 会话 → 识别成 kiro、面板供应商是 Kiro 官方账号 → 发一个要跑命令的任务 →
 *      确认框出现后打开自动操作 → 监控在光标停在「Yes」时回车放行（不选「本会话总是允许」）→ 命令跑完 →
 *      立刻关掉自动操作（不然它会一直发「继续」花 credits）→ 用量卡片按 credits 显示 → 清理（会话、目录、Kiro 记录）。
 * 运行：node scripts/e2e-kiro.mjs
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const { io } = await import(path.resolve('node_modules/socket.io-client/build/esm-debug/index.js'));
const DIR = path.join(os.homedir(), 'wtkiroe2e');
fs.mkdirSync(DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const screen = (t) => execFileSync('tmux', ['capture-pane', '-p', '-t', t], { encoding: 'utf-8' });
const waitFor = async (t, re, ms) => { for (let i = 0; i < ms / 1000; i++) { if (re.test(screen(t))) return true; await sleep(1000); } return false; };
let fail = 0;
const ok = (n, c, d = '') => { console.log(`${c ? '✅' : '❌'} ${n} ${c ? '' : d}`); if (!c) fail++; };
const s = io('http://127.0.0.1:3928', { transports: ['websocket'] });
await new Promise((r) => s.on('connect', r));
let usageView = null;
s.on('sessions:usage', (u) => { if (id && u[id]) usageView = u[id]; });
let id = null;
try {
  const created = new Promise((r) => s.once('session:created', r));
  s.emit('session:createAndResume', { name: 'wtkiroe2e', aiType: 'kiro', workingDir: DIR, projectName: 'wtkiroe2e', resumeCommand: 'kiro-cli chat --resume' });
  const sess = await created; id = sess.id;
  const t = `whatyterm-${id.slice(0, 8)}`;
  ok('kiro-cli 起来了，空闲输入框出现', await waitFor(t, /ask a question,? or describe a task/i, 30000), screen(t).slice(-300));
  ok('会话类型是 kiro，面板供应商是 Kiro 官方账号', sess.aiType === 'kiro' && sess.kiroProvider?.id === 'kiro' && sess.kiroProvider?.exists === true,
    JSON.stringify({ aiType: sess.aiType, p: sess.kiroProvider }));

  // 像用户在网页里打字那样发：文本，再回车
  s.emit('terminal:input', { sessionId: id, input: 'Run the shell command: echo WTKIRO_E2E_OK and tell me the output.' });
  await sleep(300);
  s.emit('terminal:input', { sessionId: id, input: '\r' });
  ok('确认框出现', await waitFor(t, /requires approval/, 60000), screen(t).slice(-400));
  s.emit('session:updateSettings', { sessionId: id, settings: { autoActionEnabled: true } });
  const approved = await waitFor(t, /Credits: turn/, 60000);
  s.emit('session:updateSettings', { sessionId: id, settings: { autoActionEnabled: false } });
  ok('监控回车放行，命令跑完（屏上有输出与本轮 credits）', approved && /WTKIRO_E2E_OK/.test(screen(t)), screen(t).slice(-500));
  ok('选的是「放行这一次」，没有选「本会话总是允许」', !/trusted_tools":\s*\[[^\]]*shell/i.test(
    fs.readdirSync(path.join(os.homedir(), '.kiro/sessions/cli')).filter((f) => f.endsWith('.json'))
      .map((f) => fs.readFileSync(path.join(os.homedir(), '.kiro/sessions/cli', f), 'utf-8')).filter((x) => x.includes(DIR)).join('')));
  for (let i = 0; i < 75 && !(usageView?.kind === 'credits' && usageView.credits > 0); i++) await sleep(1000);
  ok('用量按 credits 显示且大于 0', usageView?.kind === 'credits' && usageView.credits > 0, JSON.stringify(usageView));
} catch (e) {
  fail++; console.log(`❌ ${e.message}`);
} finally {
  if (id) { s.emit('session:updateSettings', { sessionId: id, settings: { autoActionEnabled: false } }); s.emit('session:delete', id); }
  await sleep(3000);
  s.close();
  const cli = path.join(os.homedir(), '.kiro/sessions/cli');
  for (const f of fs.existsSync(cli) ? fs.readdirSync(cli) : []) {
    if (!f.endsWith('.json')) continue;
    try { if (JSON.parse(fs.readFileSync(path.join(cli, f), 'utf-8')).cwd === DIR) for (const ext of ['.json', '.jsonl', '.history']) fs.rmSync(path.join(cli, f.replace('.json', ext)), { force: true }); } catch { /* 跳过 */ }
  }
  fs.rmSync(DIR, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);

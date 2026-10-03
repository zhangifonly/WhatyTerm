/**
 * 普通会话换 CLI 的真机 E2E：真服务 + 真 claude / codex，在测试自己建的目录与会话里跑（会花钱）。
 *   准备：目录里只有一份 CLAUDE.md，写着规矩「每个 .js 第一行是 // 规则版本 R7」
 *   ① Claude 做第一步（sum.js），计划里写明第二步 mean.js、第三步 README.md
 *   ② 换成 Codex：Claude 先写交接 → 退出 → 起 Codex → 交接摘要发给它；看 Codex 接着做了第二步、守了 CLAUDE.md 里的规矩
 *   ③ 换回 Claude：Codex 写交接 → 退出 → 起 Claude；看 Claude 接着做第三步
 * 测试是这个目录与会话的「人」：遇到信任目录、确认框就替自己按回车（只在测试自己的会话里）。
 * 运行：node scripts/e2e-cli-switch.mjs
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { isClaudeInputReady } from '../server/services/LongRunHandover.js';
import { isCodexInputReady, isTrustPrompt } from '../server/services/cliSwitch.js';

const { io } = await import(path.resolve('node_modules/socket.io-client/build/esm-debug/index.js'));
const NAME = 'wtcliswe2e';
const DIR = path.join(os.homedir(), NAME);
if (fs.existsSync(DIR)) throw new Error(`测试目录已存在，先确认里面不是你的东西再删：${DIR}`);
fs.mkdirSync(DIR);
execFileSync('git', ['init', '-q'], { cwd: DIR });
fs.writeFileSync(path.join(DIR, 'CLAUDE.md'), '# 项目规则\n\n- 每个 .js 文件的第一行必须是注释 `// 规则版本 R7`。\n- 不引入任何依赖，测试用 Node 自带的 node:test。\n');
const PLAN = ['这个项目分三步做：',
  '① `sum.js`：导出 `sum(numbers)`，返回各项之和，空数组返回 0，遇到非数字抛 TypeError；配 `sum.test.js`。',
  '② `mean.js`：导出 `mean(numbers)`，复用 `sum.js` 的 `sum`，空数组抛 RangeError；配 `mean.test.js`。',
  '③ `README.md`：用中文简单说明这两个函数。',
  'NaN 当作非数字处理（抛 TypeError）。',
  '这次只做第 ① 步，做完先停下（我要换工具）。之后接手的人直接按计划做 ②③，不需要再问我确认。只写文件，不要运行任何命令。'].join('\n');

let fail = 0;
const ok = (n, c, d = '') => { console.log(`${c ? '✅' : '❌'} ${n} ${c ? '' : d}`); if (!c) fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const s = io('http://127.0.0.1:3928', { transports: ['websocket'] });
await new Promise((r) => s.on('connect', r));
s.on('session:switchCliProgress', (p) => console.log(`   · ${p.text}${p.seconds ? `（${p.seconds}s）` : ''}`));
let id = null, tmux = '';
const screen = () => execFileSync('tmux', ['capture-pane', '-p', '-e', '-t', tmux], { encoding: 'utf8' });
const plain = () => execFileSync('tmux', ['capture-pane', '-p', '-S', '-200', '-t', tmux], { encoding: 'utf8' });
const keys = (...k) => execFileSync('tmux', ['send-keys', '-t', tmux, ...k]);
/**
 * 当「人」：信任目录、确认框。两家信任对话框的默认项相反（实抓 tests/fixtures/screens/*-trust.txt）：
 * Codex 光标默认在「Trust and continue」，回车即可；Claude 默认在「No, exit」，要先 ↓ 到「Yes, I trust this folder」
 */
const actAsUser = () => {
  const t = screen().replace(/\x1b\[[0-9;]*m/g, '');
  if (/Yes, I trust this folder/.test(t) && /❯ No, exit/.test(t)) { keys('Down'); keys('Enter'); return true; }
  if (isTrustPrompt(t) || /Do you want to (make this edit|create|proceed|run)|Would you like to run|Allow command\?/i.test(t)) { keys('Enter'); return true; }
  return false;
};
const claudeReady = () => { const t = screen(); return !isTrustPrompt(t) && isClaudeInputReady(t); };
const waitFor = async (cond, ms, label) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(2000)) { actAsUser(); if (cond()) return true; }
  console.log(`   （等「${label}」超时）`);
  return false;
};
const exists = (f) => fs.existsSync(path.join(DIR, f));
const first = (f) => (exists(f) ? fs.readFileSync(path.join(DIR, f), 'utf8').split('\n')[0] : '');
const switchTo = (to) => new Promise((r) => {
  const pump = setInterval(actAsUser, 2000);       // 交接期间新 CLI 问信任目录，测试替自己点
  s.emit('session:switchCli', { sessionId: id, to }, (d) => { clearInterval(pump); r(d); });
});
try {
  const created = new Promise((r) => s.once('session:created', r));
  s.emit('session:createAndResume', { name: NAME, aiType: 'claude', workingDir: DIR, projectName: NAME, resumeCommand: 'claude --permission-mode acceptEdits' });
  const sess = await created;
  if (sess.workingDir !== DIR || sess.name !== NAME) throw new Error(`建出来的不是测试会话：${sess.name}`);   // 绝不碰用户会话
  id = sess.id; tmux = `whatyterm-${id.slice(0, 8)}`;

  console.log('== ① Claude 做第一步');
  ok('Claude 起来了', await waitFor(claudeReady, 90000, 'Claude 就绪'));
  s.emit('terminal:input', { sessionId: id, input: `\x1b[200~${PLAN}\x1b[201~` });
  await sleep(500);
  s.emit('terminal:input', { sessionId: id, input: '\r' });
  await waitFor(() => exists('sum.js') && exists('sum.test.js'), 300000, 'sum.js');
  await waitFor(() => claudeReady() && !/esc to interrupt/.test(plain().slice(-1500)), 120000, 'Claude 停下');
  ok('第一步完成且守规矩', /规则版本 R7/.test(first('sum.js')) && !exists('mean.js'), first('sum.js'));

  console.log('== ② 换成 Codex');
  const r1 = await switchTo('codex');
  ok('换成 Codex 成功', r1.ok, r1.error || '');
  ok('Claude 的交接摘要写到了第二步', /mean/i.test(r1.receipt || ''), (r1.receipt || '').slice(0, 300));
  await waitFor(() => exists('mean.js') && exists('mean.test.js') && isCodexInputReady(screen()), 480000, 'Codex 做完第二步');
  const mean = exists('mean.js') ? fs.readFileSync(path.join(DIR, 'mean.js'), 'utf8') : '';
  ok('Codex 接着做了第二步，复用 sum', /\.\/sum/.test(mean), mean.slice(0, 200));
  ok('Codex 守了只写在 CLAUDE.md 里的规矩', /规则版本 R7/.test(first('mean.js')) && /规则版本 R7/.test(first('mean.test.js')), `${first('mean.js')} | ${first('mean.test.js')}`);

  console.log('== ③ 换回 Claude');
  const r2 = await switchTo('claude');
  ok('换回 Claude 成功', r2.ok, r2.error || '');
  ok('Codex 的交接摘要提到了进度', /mean/i.test(r2.receipt || ''), (r2.receipt || '').slice(0, 300));
  await waitFor(() => exists('README.md') && claudeReady() && !/esc to interrupt/.test(plain().slice(-1500)), 480000, 'Claude 做完第三步');
  ok('Claude 接着做了第三步（README 讲到两个函数）', exists('README.md') && /mean/.test(fs.readFileSync(path.join(DIR, 'README.md'), 'utf8')), '');
  let out = '';
  try { out = execFileSync('node', ['--test'], { cwd: DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { out = `失败：${e.stdout || e.message}`; }
  ok('node --test 全过', /[#ℹ] fail 0/.test(out) && /[#ℹ] pass ([4-9]|[1-9]\d+)\b/.test(out), out.slice(-300));
  ok('规则文件还是只有 CLAUDE.md', exists('CLAUDE.md') && !exists('AGENTS.md'), '');
} catch (e) {
  fail++; console.log(`❌ ${e.message}`);
} finally {
  if (id) s.emit('session:delete', id);
  await sleep(3000);
  s.close();
  console.log(`\n测试目录 ${DIR} 留着供查看；清理：删目录、Codex/Claude 里这个目录的对话、~/.webtmux/sessions/${id || '<id>'}`);
  console.log(`=== ${fail ? `${fail} 项失败` : '全部通过'} ===`);
  process.exit(fail ? 1 : 0);
}

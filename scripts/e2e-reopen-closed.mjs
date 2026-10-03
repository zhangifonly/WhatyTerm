/**
 * 「恢复刚关闭的会话」E2E（像浏览器 ⌘⇧T）：真服务 + 真 tmux + Playwright 真键盘。
 * 场景：建测试会话 → 在终端里打 exit 关掉 → ⌘K 不输入，「最近关闭」里有它 →
 *      按 ⌥⇧T → 同一个会话 id 回来了、tmux 在原目录重建、目标与自动操作开关照旧、界面切过去、它从「最近关闭」里消失 → 清理。
 * 测试目录 ~/wtreopene2e（不能放临时目录、不能带点号），结束后删除；目录没了它也不会再出现在「最近关闭」里。
 * 运行：node scripts/e2e-reopen-closed.mjs <playwright-core/index.mjs>
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const [pwPath] = process.argv.slice(2);
const { chromium } = await import(pwPath);
const { io } = await import(path.resolve('node_modules/socket.io-client/build/esm-debug/index.js'));
const DIR = path.join(os.homedir(), 'wtreopene2e');
fs.mkdirSync(DIR, { recursive: true });
const db = path.join(os.homedir(), '.webtmux', 'db', 'webtmux.db');
const sql = (q) => execFileSync('sqlite3', [db, q], { encoding: 'utf-8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmuxAlive = (t) => { try { execFileSync('tmux', ['has-session', '-t', t], { stdio: 'ignore' }); return true; } catch { return false; } };

let fail = 0;
const ok = (n, c, d = '') => { console.log(`${c ? '✅' : '❌'} ${n} ${c ? '' : d}`); if (!c) fail++; };
const s = io('http://127.0.0.1:3928', { transports: ['websocket'] });
await new Promise((r) => s.on('connect', r));
const emit = (ev, data) => new Promise((r) => s.emit(ev, data, r));
let id = null;
const b = await chromium.launch();
try {
  // 建会话：走「历史项目开工」的入口，工作目录与目标从一开始就在服务端内存里
  // （⚠ 不能事后改库：内存里的旧值会在会话结束时写回去，测试会话就没了目录、被「最近关闭」过滤掉）
  const created = new Promise((r) => s.once('session:created', r));
  s.emit('session:createAndResume', { name: 'wtreopene2e', aiType: 'claude', workingDir: DIR, projectName: 'wtreopene2e' });
  id = (await created).id;
  const t = `whatyterm-${id.slice(0, 8)}`;
  await sleep(2500);
  const goalBefore = sql(`select goal || '|' || auto_action_enabled from sessions where id='${id}'`);
  // 在终端里打 exit：走真实的「会话结束」路径
  execFileSync('tmux', ['send-keys', '-t', t, 'exit', 'Enter']);
  for (let i = 0; i < 20 && tmuxAlive(t); i++) await sleep(500);
  await sleep(4000);   // 等服务端确认 tmux 没了、把记录标成已删除
  ok('exit 后会话记录标为已删除并记下关闭时间', sql(`select status, closed_at is not null from sessions where id='${id}'`) === 'deleted|1',
    sql(`select status, closed_at from sessions where id='${id}'`));

  const page = await (await b.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
  await page.goto('http://127.0.0.1:3928/', { waitUntil: 'networkidle' });
  await page.locator('.session-item').first().waitFor();
  await page.keyboard.press('Meta+k');
  await page.waitForTimeout(1000);
  const firstClosed = await page.evaluate(() => document.querySelector('.switcher-item.history .switcher-name')?.textContent);
  ok('⌘K 不输入：「最近关闭」第一个就是它', firstClosed === 'wtreopene2e', firstClosed);
  await page.keyboard.press('Escape');

  // 安全闸：⌥⇧T 恢复的是「最近关闭的那一个」。最近那一个不是测试会话就绝不按，否则会把你自己关掉的会话打开
  const top = await emit('recentClosed:list', { limit: 1 });
  if (top?.list?.[0]?.id !== id) throw new Error(`最近关闭的第一个不是测试会话（是 ${top?.list?.[0]?.name}），中止，不按快捷键`);
  await page.locator('.xterm').first().click().catch(() => {});   // 焦点在终端里也得生效（xterm 要放行这个组合键）
  await page.keyboard.press('Alt+Shift+KeyT');
  for (let i = 0; i < 20 && !tmuxAlive(t); i++) await sleep(500);
  await sleep(2500);
  ok('⌥⇧T：同一个会话 id 回来了', sql(`select status from sessions where id='${id}'`) === 'running');
  ok('tmux 在原目录重建', tmuxAlive(t) && execFileSync('tmux', ['display', '-p', '-t', t, '#{pane_current_path}'], { encoding: 'utf-8' }).trim() === DIR);
  const goalAfter = sql(`select goal || '|' || auto_action_enabled from sessions where id='${id}'`);
  ok('目标与自动操作开关照旧', goalAfter === goalBefore, `${goalBefore} → ${goalAfter}`);
  ok('界面切到了它', (await page.locator('.session-item.active').textContent())?.includes('wtreopene2e'));
  const r = await emit('recentClosed:list', { limit: 10 });
  ok('恢复后不再出现在「最近关闭」里', r.ok && !r.list.some((x) => x.id === id));
} catch (e) {
  fail++; console.log(`❌ ${e.message}`);
} finally {
  await b.close();
  if (id) s.emit('session:delete', id);
  await sleep(3000);
  s.close();
  fs.rmSync(DIR, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);

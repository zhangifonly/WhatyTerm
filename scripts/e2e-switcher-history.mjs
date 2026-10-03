/**
 * ⌘K 搜索历史项目 E2E：真页面 + Playwright 真键盘 + 真建会话。
 * 场景：搜一个既有运行中会话、又有历史记录的词 → 运行中的在前、历史另起一节；
 *      搜自建的测试项目 → 只出现在历史一节 → 回车 → 新建会话、自动切过去、CLI 在项目目录续接 → 删会话，服务进程不变。
 * 测试项目 ~/wtsearche2e（不能放临时目录、路径不能带点号，原因见 e2e-mobile-projects.mjs），结束后全部清理。
 * 运行：node scripts/e2e-switcher-history.mjs <playwright-core/index.mjs> <一个运行中、同时有历史记录的项目名>
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const [pwPath, both = 'iSpring'] = process.argv.slice(2);
const { chromium } = await import(pwPath);
const { io } = await import(path.resolve('node_modules/socket.io-client/build/esm-debug/index.js'));
const DIR = path.join(os.homedir(), 'wtsearche2e');
const REC = path.join(os.homedir(), '.claude', 'projects', DIR.replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(DIR, { recursive: true });
fs.mkdirSync(REC, { recursive: true });
fs.writeFileSync(path.join(REC, 'e2e.jsonl'), '{}\n');
const db = path.join(os.homedir(), '.webtmux', 'db', 'webtmux.db');
const sessionsIn = () => execFileSync('sqlite3', [db, `select id from sessions where working_dir='${DIR}' and status='running'`], { encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
const svcPid = () => execFileSync('launchctl', ['list'], { encoding: 'utf-8' }).split('\n').find((l) => l.endsWith('\tcom.whaty.webtmux'))?.split('\t')[0];

let fail = 0;
const ok = (n, c, d = '') => { console.log(`${c ? '✅' : '❌'} ${n} ${c ? '' : d}`); if (!c) fail++; };
const b = await chromium.launch();
const page = await (await b.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
const items = () => page.evaluate(() => [...document.querySelectorAll('.switcher-list > .switcher-item, .switcher-list .switcher-section, .switcher-list > div > .switcher-item')]
  .map((e) => (e.classList.contains('switcher-section') ? '§' : `${e.classList.contains('history') ? 'H' : 'R'}:${e.querySelector('.switcher-name')?.textContent}`)));
try {
  await page.goto('http://127.0.0.1:3928/', { waitUntil: 'networkidle' });
  await page.locator('.session-item').first().waitFor();
  await page.getByText('搜索', { exact: false }).first().click();
  await page.locator('.switcher-input').fill(both);
  await page.waitForTimeout(800);
  const list = await items();
  const firstH = list.findIndex((x) => x.startsWith('H:') || x === '§');
  const lastR = list.map((x) => x.startsWith('R:')).lastIndexOf(true);
  ok(`搜「${both}」：运行中的在前、历史另起一节`, lastR >= 0 && (firstH < 0 || lastR < firstH), JSON.stringify(list));

  await page.locator('.switcher-input').fill('wtsearche2e');
  await page.waitForTimeout(600);
  const l2 = await items();
  ok('测试项目只出现在历史一节', l2.includes('§') && l2.filter((x) => x.startsWith('H:')).length === 1 && !l2.some((x) => x.startsWith('R:')), JSON.stringify(l2));
  if (process.env.SHOT) await page.locator('.switcher').screenshot({ path: process.env.SHOT });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(6000);
  const ids = sessionsIn();
  ok('回车：建了一个会话', ids.length === 1, `建了 ${ids.length} 个`);
  ok('搜索框关了，并切到了新会话', !(await page.locator('.switcher').count())
    && (await page.locator('.session-item.active').textContent())?.includes('wtsearche2e'));
  if (ids[0]) {
    const t = `whatyterm-${ids[0].slice(0, 8)}`;
    const cwd = execFileSync('tmux', ['display', '-p', '-t', t, '#{pane_current_path}'], { encoding: 'utf-8' }).trim();
    ok('会话在项目目录里', cwd === DIR, cwd);
  }
} finally {
  await b.close();
  const before = svcPid();
  const s = io('http://127.0.0.1:3928', { transports: ['websocket'] });
  await new Promise((r) => s.on('connect', r));
  for (const id of sessionsIn()) s.emit('session:delete', id);
  await new Promise((r) => setTimeout(r, 3000));
  s.close();
  ok('删除测试会话后服务进程不变', svcPid() === before, `${before} → ${svcPid()}`);
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.rmSync(REC, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);

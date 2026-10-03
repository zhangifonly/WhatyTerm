/**
 * 移动版「历史项目」E2E：真页面（iPhone 视口）+ Playwright 真点击 + 真建会话。
 * 场景：列表按 CLI 分类带数量 → 已开着的项目点了直接进它的详情（不新建）→ 新项目点了（含连点两下）
 *      只建一个会话并自动进详情 → 会话里确实在项目目录启动了 CLI → 删掉会话，服务进程不受影响。
 * 自建测试项目于 ~/wtmobilee2e，结束后全部清理。不能放系统临时目录（会被历史项目过滤掉），
 * 路径里也不能有点号（Claude 记录目录名把点编成横线，历史项目解不回原路径，~/.webtmux 下就因此不显示）。
 * 运行：node scripts/e2e-mobile-projects.mjs <playwright-core/index.mjs> <一个已开着的 Codex 项目名>
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const [pwPath, runningName = 'iSpring'] = process.argv.slice(2);
const { chromium, devices } = await import(pwPath);
const { io } = await import(path.resolve('node_modules/socket.io-client/build/esm-debug/index.js'));
const DIR = path.join(os.homedir(), 'wtmobilee2e');
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
const page = await (await b.newContext({ ...devices['iPhone 13'] })).newPage();
try {
  await page.goto('http://127.0.0.1:3928/m/', { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: /历史项目/ }).tap();
  await page.waitForSelector('.m-project', { timeout: 20000 });
  const tabs = await page.locator('.m-tab').allTextContents();
  ok('历史项目按 CLI 分类且带数量', tabs.length >= 1 && tabs.every((t) => /\d/.test(t)), JSON.stringify(tabs));
  ok('不含系统临时目录', !(await page.locator('.m-project-path', { hasText: '/var/folders/' }).count()));

  await page.locator('.m-tab', { hasText: 'Codex' }).tap();
  await page.locator('.m-search').fill(runningName);
  const running = page.locator('.m-project', { hasText: '进行中' }).first();
  ok(`已开着的项目（${runningName}）标「进行中」`, (await running.count()) > 0);
  await running.tap();
  await page.waitForTimeout(1500);
  ok('点已开着的项目：进它的详情，不新建', (await page.locator('.m-topbar-title').textContent()).includes(runningName));
  await page.locator('.m-back').tap();

  await page.getByRole('tab', { name: /历史项目/ }).tap();
  await page.locator('.m-tab', { hasText: 'Claude' }).tap();
  await page.locator('.m-search').fill('wtmobilee2e');
  const card = page.locator('.m-project', { hasText: 'wtmobilee2e' }).first();
  await card.tap();
  await card.tap({ force: true, timeout: 2000 }).catch(() => {});        // 连点第二下
  await page.waitForSelector('.m-detail', { timeout: 25000 }).catch(() => {});
  ok('点新项目：自动进入新会话详情', (await page.locator('.m-topbar-title').textContent()).includes('wtmobilee2e'));
  await page.waitForTimeout(4000);
  const ids = sessionsIn();
  ok('连点两下只建了一个会话', ids.length === 1, `建了 ${ids.length} 个`);
  if (ids[0]) {
    // pane_current_command 在 WhatyTerm 会话里恒为 zsh（CLI 由 shell 拉起），不能用；看目录 + 屏幕上 CLI 的字样
    const t = `whatyterm-${ids[0].slice(0, 8)}`;
    const cwd = execFileSync('tmux', ['display', '-p', '-t', t, '#{pane_current_path}'], { encoding: 'utf-8' }).trim();
    const screen = execFileSync('tmux', ['capture-pane', '-p', '-t', t], { encoding: 'utf-8' });
    ok('会话在项目目录里启动了 CLI', cwd === DIR && /Claude Code|trust this folder|No conversation/i.test(screen),
      `cwd=${cwd} 屏幕=${JSON.stringify(screen.trim().slice(-160))}`);
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

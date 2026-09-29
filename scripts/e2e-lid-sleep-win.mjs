/**
 * 合盖不睡眠 · Windows E2E（真 powercfg、真注册表、真 PowerShell 看门狗与保活进程）。
 * 覆盖合盖以外的全部环节；真正合盖需要 Windows 笔记本（家人试用时看面板的「停顿记录」）。
 *
 * 场景：读原值 → 就绪（脚本+登录自启）→ 开启（LIDACTION 读回 0/0、保活进程在跑、看门狗在跑）
 *      → 模拟服务被强杀（心跳过期）→ 看门狗 -Once 还原成原值 → 再开启 → 关闭还原
 *      → 卸载（自启项与脚本删除）→ 最终合盖设置与开始时完全一致
 * 产物：~/.webtmux/e2e/lid-sleep-win-<时间>.json
 * 运行（Windows）：node scripts/e2e-lid-sleep-win.mjs
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  readWinPower, setWinOverride, ensureWinReady, uninstallWin, detectModernStandby,
  WIN_MARKER, WIN_HEARTBEAT, WIN_WATCHDOG, WIN_KEEPER, RUN_KEY, RUN_VALUE
} from '../server/services/lidSleepWin.js';

if (process.platform !== 'win32') { console.log('只能在 Windows 上运行'); process.exit(2); }
const steps = [];
let failed = false;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function check(name, ok, detail = {}) {
  const p = await readWinPower();
  steps.push({ name, ok: !!ok, lidAction: p.lidAction, marker: fs.existsSync(WIN_MARKER), ...detail });
  console.log(`${ok ? '✅' : '❌'} ${name}  LIDACTION=${JSON.stringify(p.lidAction)}`);
  if (!ok) failed = true;
}
const procRunning = (needle) => {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*${needle}*' }).Count`],
  { encoding: 'utf-8', windowsHide: true });
  return Number(out.trim()) > 0;
};
const runKeyPresent = () => {
  try { execFileSync('reg', ['query', RUN_KEY, '/v', RUN_VALUE], { stdio: 'pipe' }); return true; } catch { return false; }
};

const original = (await readWinPower()).lidAction;
console.log('原始合盖设置', original, '现代待机', await detectModernStandby());
if (!original) { console.log('读不到 LIDACTION，终止'); process.exit(2); }
if (fs.existsSync(WIN_MARKER)) { console.log('已有标记文件（正在使用中？），终止以免打乱'); process.exit(2); }

try {
  await check('就绪：脚本写好、登录自启项已注册', await ensureWinReady() && fs.existsSync(WIN_WATCHDOG) && fs.existsSync(WIN_KEEPER) && runKeyPresent());
  let r = await setWinOverride(true, 20);
  fs.writeFileSync(WIN_HEARTBEAT, String(Date.now()));
  await wait(6000);   // 保活进程要编译 C# 片段，等它起来
  let p = await readWinPower();
  await check('开启：插电/电池都改为「不采取任何操作」', r.ok && p.lidAction?.ac === 0 && p.lidAction?.dc === 0, { error: r.error });
  await check('保活进程在跑', procRunning('lid-keeper.ps1'));
  await check('看门狗在跑', procRunning('lid-guard.ps1'));

  // 模拟服务被强杀：心跳停在 10 分钟前，什么都不调用，等常驻看门狗自己发现（它 60 秒一轮）
  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(WIN_HEARTBEAT, old, old);
  const t0 = Date.now();
  while (fs.existsSync(WIN_MARKER) && Date.now() - t0 < 80000) await wait(2000);
  p = await readWinPower();
  await check('心跳过期：常驻看门狗自己把合盖设置改回原值并删标记',
    p.lidAction?.ac === original.ac && p.lidAction?.dc === original.dc && !fs.existsSync(WIN_MARKER),
  { tookSec: Math.round((Date.now() - t0) / 1000) });
  await check('看门狗还原后自行退出', !procRunning('lid-guard.ps1'));

  // 登录自启的 -Once 路径：重启电脑后心跳必然过期，登录即还原
  r = await setWinOverride(true, 20);
  fs.utimesSync(WIN_HEARTBEAT, old, old);
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WIN_WATCHDOG, '-Once'], { windowsHide: true });
  p = await readWinPower();
  await check('登录自启（-Once）：心跳过期即还原', r.ok && p.lidAction?.ac === original.ac && !fs.existsSync(WIN_MARKER));

  r = await setWinOverride(true, 20);
  p = await readWinPower();
  await check('再次开启', r.ok && p.lidAction?.ac === 0 && p.lidAction?.dc === 0);
  r = await setWinOverride(false);
  p = await readWinPower();
  await check('关闭：还原成原值', r.ok && p.lidAction?.ac === original.ac && p.lidAction?.dc === original.dc && !fs.existsSync(WIN_MARKER));
} finally {
  const u = await uninstallWin();
  const p = await readWinPower();
  await check('卸载：自启项与脚本已删，合盖设置与开始时一致',
    u.ok && !runKeyPresent() && !fs.existsSync(WIN_WATCHDOG) && p.lidAction?.ac === original.ac && p.lidAction?.dc === original.dc);
  const out = path.join(os.homedir(), '.webtmux', 'e2e', `lid-sleep-win-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), original, steps }, null, 2));
  console.log(`产物：${out}`);
}
process.exit(failed ? 1 : 0);

/**
 * 合盖不睡眠 · Windows 执行器层 E2E：走服务实际调用的 LidSleepGuard.tick，而不是直接调适配函数。
 * 验证：开关开 + 有在跑的会话 → 生效；会话停了 → 还原；开关关 → 不动；配置与标记最后都复原。
 * 运行（Windows，需装好依赖）：node scripts/e2e-lid-sleep-guard-win.mjs
 */
import fs from 'fs';
import guard from '../server/services/LidSleepGuard.js';
import { readWinPower, uninstallWin, WIN_MARKER } from '../server/services/lidSleepWin.js';

if (process.platform !== 'win32') { console.log('只能在 Windows 上运行'); process.exit(2); }
const E = '\x1b';
const running = { getScreenContent: () => ` ${E}[2mWorking${E}[0m ${E}[2m(3s • ${E}[0;1mesc${E}[0;2m to interrupt)${E}[0m\n› Ask Codex\n` };
const idle = { getScreenContent: () => '⏺ 完成\n\n❯ \n  ? for shortcuts\n' };
let failed = false;
const ok = (name, cond, extra = '') => { console.log(`${cond ? '✅' : '❌'} ${name} ${extra}`); if (!cond) failed = true; };

const original = (await readWinPower()).lidAction;
const cfg = { enabled: guard.status.enabled, batteryFloor: guard.status.batteryFloor };
try {
  await guard.setConfig({ enabled: true });
  await guard.tick([running]);
  let s = guard.status, p = await readWinPower();
  ok('开关开 + 有会话在跑 → 生效', s.active && p.lidAction?.ac === 0 && p.lidAction?.dc === 0, `reason=${s.reason} err=${s.lastError}`);
  ok('状态里带平台/实验性/现代待机', s.platform === 'win32' && s.experimental === true && s.modernStandby !== null, `modernStandby=${s.modernStandby}`);
  await guard.tick([running]);
  ok('再来一轮保持生效（不重复写、不误还原）', guard.status.active);
  await guard.tick([idle]);
  p = await readWinPower();
  ok('会话停了 → 还原原值', !guard.status.active && p.lidAction?.ac === original.ac && p.lidAction?.dc === original.dc, guard.status.reason);
  await guard.setConfig({ enabled: false });
  await guard.tick([running]);
  p = await readWinPower();
  ok('开关关着，有会话在跑也不动', !guard.status.active && p.lidAction?.ac === original.ac, guard.status.reason);
} finally {
  await guard.setConfig(cfg);
  await uninstallWin();
  const p = await readWinPower();
  ok('收尾：合盖设置与开始时一致、无残留标记', p.lidAction?.ac === original.ac && p.lidAction?.dc === original.dc && !fs.existsSync(WIN_MARKER));
}
process.exit(failed ? 1 : 0);

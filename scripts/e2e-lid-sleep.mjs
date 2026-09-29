/**
 * 合盖保活 E2E（真机、真 pmset、真看门狗）。需先在面板里完成一次授权安装。
 *
 * 场景：开启 → 标志真的变 1 → 模拟服务被强杀（心跳过期）→ 看门狗真的还原成 0
 *      → 服务下一轮自动接回 → 关闭开关后还原成 0。
 * 产物：~/.webtmux/e2e/lid-sleep-<时间>.json（每一步的读回值，可复查）
 * 运行：node scripts/e2e-lid-sleep.mjs
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const BASE = 'http://127.0.0.1:3928/api/lid-sleep';
const RUN = path.join(os.homedir(), '.webtmux', 'run');
const MARKER = path.join(RUN, 'lid-sleep-owner');
const HB = path.join(RUN, 'lid-sleep-heartbeat');
const WATCHDOG = path.join(os.homedir(), '.webtmux', 'bin', 'lid-guard.sh');
const steps = [];
let failed = false;

const sleepDisabled = () => /SleepDisabled\s+1/.test(execFileSync('/usr/bin/pmset', ['-g'], { encoding: 'utf-8' }));
const api = async (body) => (await fetch(BASE, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})).json();
function check(name, ok, detail = {}) {
  steps.push({ name, ok, sleepDisabled: sleepDisabled(), marker: fs.existsSync(MARKER), ...detail });
  console.log(`${ok ? '✅' : '❌'} ${name}`);
  if (!ok) failed = true;
}

const before = await api();
if (!before.installed || !before.watchdogReady) {
  console.log('授权或看门狗未就绪，先在面板里点「授权安装」。', JSON.stringify(before.manual || []));
  process.exit(2);
}
if (sleepDisabled() && !before.owned) {
  console.log('SleepDisabled 已被其他工具（如 Amphetamine）开着，先关掉它再测。');
  process.exit(2);
}
const original = { enabled: before.enabled, batteryFloor: before.batteryFloor };

try {
  let s = await api({ enabled: true });
  check('开启后 disablesleep 读回为 1', s.keepAwake === 0 ? true : sleepDisabled() && s.active, { reason: s.reason, keepAwake: s.keepAwake });
  if (s.keepAwake === 0) console.log('（当前没有运行中会话，决策为允许睡眠，以下步骤跳过）');
  else {
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(HB, old, old);                       // 模拟服务被强杀：心跳停在 10 分钟前
    execFileSync('/bin/sh', [WATCHDOG]);
    check('心跳过期后看门狗还原为 0 并删除标记', !sleepDisabled() && !fs.existsSync(MARKER));
    s = await api();
    check('服务下一轮自动接回（重新置 1）', sleepDisabled() && s.active, { reason: s.reason });
    execFileSync('/bin/sh', [WATCHDOG]);
    check('心跳新鲜时看门狗不动', sleepDisabled());
  }
  s = await api({ enabled: false });
  check('关闭开关后还原为 0', !sleepDisabled() && !s.active, { reason: s.reason });
} finally {
  await api(original);
  const out = path.join(os.homedir(), '.webtmux', 'e2e', `lid-sleep-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), steps, restored: original }, null, 2));
  console.log(`产物：${out}`);
}
process.exit(failed ? 1 : 0);

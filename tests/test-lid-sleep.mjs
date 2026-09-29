/**
 * 合盖保活 —— 失效模式清单测试（先列出会怎么坏，再逐条钉住）
 *
 * 会坏的方式：
 *   ① 带色码的 Codex 运行屏认不出「在跑」→ 合盖照睡（v1.4.70 台账同一个坑）
 *   ② 空闲屏的正文/旧 scrollback 里有 Work/Form/esc to interrupt → 误判在跑 → 永不睡，电池下耗光
 *   ③ 开着自动操作但 CLI 空闲 → 判成不用保活 → 睡下后监控发不出「继续」
 *   ④ 电量到下限 / 低电量模式 / 读不到电量 仍然不睡
 *   ⑤ 没装授权（或看门狗不在位）仍去开标志
 *   ⑥ sudoers 规则能被用户名注入放宽；规则语法错会锁死 sudo
 *   ⑦ 看门狗脚本 / plist 本身语法错 → 崩溃后没人还原
 * 系统层的真实开关与看门狗还原，见 scripts/e2e-lid-sleep.mjs（需先装授权）。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { countKeepAwakeSessions, decideLidSleep, parseBatt, parsePmset, clampFloor, thermalVerdict, parseBatteryTemp } from '../server/services/lidSleepPolicy.js';
import { buildSudoersRule, buildWatchdogScript, buildPlist } from '../server/services/lidSleepInstall.js';
import { MARKER_PATH, HEARTBEAT_PATH } from '../server/services/LidSleepGuard.js';
import { parseLidAction, parseActiveScheme, parseWinBattery, parseModernStandby, psq, buildWinWatchdog, WIN_MARKER } from '../server/services/lidSleepWin.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n    ${e.message}`); }
}
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || ''} 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); }
const E = '\x1b';
const screen = (text, extra = {}) => ({ getScreenContent: () => text, ...extra });

// 真实形态：iSpring 会话 capture-pane -e 抓到的底栏（色码插在 esc 两侧）
const codexRunning = `• Explored\n  └ Read a.py\n ${E}[2mWorking${E}[0m ${E}[2m(2m 54s • ${E}[0;1mesc${E}[0;2m to interrupt)${E}[0m\n› Ask Codex to do anything\n`;
const claudeRunning = `⏺ 正在改代码\n${E}[38;5;174m✶${E}[39m ${E}[38;5;174m构建数学实验课程…${E}[39m ${E}[2m(53m 38s · ↓ 13.5k tokens)${E}[0m\n❯ \n`;
const filler = Array.from({ length: 60 }, (_, i) => `  普通输出第 ${i} 行，没有任何运行迹象`).join('\n');
const idleWithWords = `Working (1m · esc to interrupt)\n${filler}\n⏺ 已完成：Form 表单与 Work 目录的 Backup 都处理好了\n\n❯ \n  ? for shortcuts\n`;

test('① 带色码的 Codex / Claude 运行屏都算在跑', () => {
  eq(countKeepAwakeSessions([screen(codexRunning), screen(claudeRunning)]).busy, 2);
});

test('② 空闲屏正文有 Work/Form/Backup、旧 scrollback 有 esc to interrupt，不算在跑', () => {
  eq(countKeepAwakeSessions([screen(idleWithWords)]).total, 0);
});

test('③ CLI 空闲但开着自动操作，仍要保活；关着自动操作不保活', () => {
  const r = countKeepAwakeSessions([screen(idleWithWords, { autoActionEnabled: true }), screen(idleWithWords)]);
  eq(r.auto, 1); eq(r.total, 1);
});

const base = { enabled: true, installed: true, keepAwake: 2, onAC: false, percent: 60, lowPowerMode: false, floor: 20 };
test('④ 电池：下限之上不睡；等于下限、低电量模式、读不到电量都恢复睡眠', () => {
  eq(decideLidSleep(base).disable, true);
  eq(decideLidSleep({ ...base, percent: 20 }).disable, false, '等于下限');
  eq(decideLidSleep({ ...base, percent: 7 }).disable, false, '低于下限');
  eq(decideLidSleep({ ...base, lowPowerMode: true }).disable, false, '低电量模式');
  eq(decideLidSleep({ ...base, percent: null }).disable, false, '电量未知');
  eq(decideLidSleep({ ...base, onAC: true, percent: 5 }).disable, true, '插电时不受下限约束');
});

test('⑤ 未开启 / 未授权（含看门狗不在位）/ 没活干，一律不开标志', () => {
  eq(decideLidSleep({ ...base, enabled: false }).disable, false);
  eq(decideLidSleep({ ...base, installed: false }).disable, false);
  eq(decideLidSleep({ ...base, keepAwake: 0 }).disable, false);
});

test('本机真实 pmset 输出能解析；下限夹在 5~80', () => {
  const b = parseBatt(execFileSync('/usr/bin/pmset', ['-g', 'batt'], { encoding: 'utf-8' }));
  eq(typeof b.onAC, 'boolean'); eq(Number.isInteger(b.percent), true, '电量');
  eq(parsePmset(execFileSync('/usr/bin/pmset', ['-g'], { encoding: 'utf-8' })).sleepDisabled !== null, true, 'SleepDisabled 行');
  eq(clampFloor(1), 5); eq(clampFloor(99), 80); eq(clampFloor('abc'), 20);
});

test('⑥ sudoers：注入用户名被拒；规则只有两条字面命令且过 visudo 校验', () => {
  for (const bad of ['a b', 'x ALL=(ALL) ALL', 'root\nevil', 'a,b', '']) {
    let threw = false; try { buildSudoersRule(bad); } catch { threw = true; }
    eq(threw, true, `未拒绝 ${JSON.stringify(bad)}`);
  }
  const rule = buildSudoersRule(os.userInfo().username);
  const cmds = rule.split('NOPASSWD:')[1].trim().split(/\s*,\s*/);
  eq(JSON.stringify(cmds), JSON.stringify(['/usr/bin/pmset -a disablesleep 0', '/usr/bin/pmset -a disablesleep 1']));
  const f = path.join(os.tmpdir(), `lidsleep-sudoers-test-${process.pid}`);
  fs.writeFileSync(f, rule);
  try { execFileSync('/usr/sbin/visudo', ['-cf', f], { stdio: 'pipe' }); } finally { fs.rmSync(f, { force: true }); }
});

test('⑦ 看门狗脚本过 sh -n、plist 过 plutil -lint', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lidsleep-'));
  try {
    fs.writeFileSync(path.join(dir, 'g.sh'), buildWatchdogScript());
    execFileSync('/bin/sh', ['-n', path.join(dir, 'g.sh')], { stdio: 'pipe' });
    fs.writeFileSync(path.join(dir, 'g.plist'), buildPlist());
    execFileSync('/usr/bin/plutil', ['-lint', path.join(dir, 'g.plist')], { stdio: 'pipe' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ⑧ 过热：插电也不豁免；阈值附近不能反复开关（滞回）；读不到温度不误触发
test('⑧ 过热保护：热状态严重/电池超上限即恢复睡眠，插电也不豁免', () => {
  const hot = thermalVerdict({ thermalState: 2, batteryTempC: 30 });
  eq(hot.hot, true);
  eq(decideLidSleep({ ...base, onAC: true, thermal: hot }).disable, false, '插电过热仍须睡');
  eq(thermalVerdict({ thermalState: 1, batteryTempC: 46, limitC: 45 }).hot, true, '电池超上限');
  eq(thermalVerdict({ thermalState: 1, batteryTempC: 40, limitC: 45 }).hot, false, '偏高(1)是负载下的常态，不触发');
  eq(thermalVerdict({ thermalState: null, batteryTempC: null }).hot, false, '读不到不误触发');
});

test('⑧ 滞回：触发后降到 上限-5°C 且热状态<2 才解除', () => {
  let v = thermalVerdict({ thermalState: 1, batteryTempC: 45.2, limitC: 45 });
  v = thermalVerdict({ thermalState: 1, batteryTempC: 43, limitC: 45, tripped: v.tripped });
  eq(v.hot, true, '43°C 仍在降温中');
  v = thermalVerdict({ thermalState: 2, batteryTempC: 38, limitC: 45, tripped: v.tripped });
  eq(v.hot, true, '温度降了但热状态仍严重');
  v = thermalVerdict({ thermalState: 1, batteryTempC: 39.5, limitC: 45, tripped: v.tripped });
  eq(v.hot, false, '两路都降下来才解除');
});

test('本机真实电池温度可读（Apple Silicon 在 AppleSmartBatteryPack）', () => {
  let out = execFileSync('/usr/sbin/ioreg', ['-r', '-c', 'AppleSmartBatteryPack', '-w0'], { encoding: 'utf-8' });
  if (parseBatteryTemp(out) == null) out = execFileSync('/usr/sbin/ioreg', ['-r', '-c', 'AppleSmartBattery', '-w0'], { encoding: 'utf-8' });
  const t = parseBatteryTemp(out);
  eq(t > 5 && t < 80, true, `温度 ${t}`);
  eq(parseBatteryTemp('"Temperature" = 3012'), 30.12, 'Intel 带空格写法');
});

// ⑨ 看门狗脚本真跑：路径换到临时目录、sudo pmset 换成写记录文件，其余逻辑原样
function runWatchdog({ marker, hbAgeSec, lid = 'Yes' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lidguard-'));
  const m = path.join(dir, 'owner'), hb = path.join(dir, 'hb'), rec = path.join(dir, 'restored');
  const script = buildWatchdogScript()
    .replace(MARKER_PATH, m).replace(HEARTBEAT_PATH, hb)
    .replace('/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0', `echo restored > "${rec}"`)
    .replace('/usr/bin/logger -t whatyterm-lidguard', 'echo')
    .replace('/usr/sbin/ioreg -r -k AppleClamshellState -d 1', `echo '"AppleClamshellState" = ${lid}'`);
  if (!script.includes(`= ${lid}'`)) throw new Error('看门狗脚本里找不到盖子状态读取，测试替换失效');
  fs.writeFileSync(path.join(dir, 'g.sh'), script);
  if (marker !== null) fs.writeFileSync(m, marker);
  fs.writeFileSync(hb, '');
  const t = new Date(Date.now() - hbAgeSec * 1000); fs.utimesSync(hb, t, t);
  const out = execFileSync('/bin/sh', [path.join(dir, 'g.sh')], { encoding: 'utf-8' });
  const r = { restored: fs.existsSync(rec), markerLeft: fs.existsSync(m), out: out.trim() };
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
}

test('⑨ 看门狗：心跳新鲜不动；心跳超时还原并删标记；没标记（别人开的）不碰', () => {
  const fresh = runWatchdog({ marker: '20 60', hbAgeSec: 10 });
  eq(fresh.restored, false, `心跳新鲜却还原了：${fresh.out}`);
  const stale = runWatchdog({ marker: '20 60', hbAgeSec: 600 });
  eq(stale.restored, true); eq(stale.markerLeft, false);
  eq(/心跳超时/.test(stale.out), true, stale.out);
  eq(runWatchdog({ marker: null, hbAgeSec: 600 }).restored, false, '没有标记也还原了');
});

test('⑨ 看门狗：温度上限低于当前电池温度时还原（两个数的标记文件解析正确）', () => {
  const r = runWatchdog({ marker: '5 1', hbAgeSec: 10 });   // 上限 1°C，必然超
  eq(r.restored, true, `未按温度还原：${r.out}`);
  eq(/电池温度|热状态/.test(r.out), true, r.out);
});

test('⑩ 开着盖子不管温度：看门狗与决策都不因过热还原', () => {
  eq(runWatchdog({ marker: '5 1', hbAgeSec: 10, lid: 'No' }).restored, false, '开盖却按温度还原了');
  eq(thermalVerdict({ thermalState: 3, batteryTempC: 55, lidClosed: false }).hot, false, '开盖危急也不管');
  eq(thermalVerdict({ thermalState: 2, batteryTempC: 30, lidClosed: true }).hot, true, '合盖照常保护');
  eq(thermalVerdict({ thermalState: 2, batteryTempC: 30, lidClosed: null }).hot, true, '读不到盖子按合盖');
  eq(thermalVerdict({ thermalState: 1, batteryTempC: 44, limitC: 45, tripped: true, lidClosed: false }).tripped, false, '开盖清掉滞回');
});

// ============ Windows（实验性）：解析真实输出。系统层行为见 scripts/e2e-lid-sleep-win.mjs（win-4090 实跑） ============
const fx = (n) => fs.readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf-8');

test('⑪ Windows：中文系统 powercfg /qh 能读出插电/电池两个值（win-4090 实采）', () => {
  eq(JSON.stringify(parseLidAction(fx('powercfg-qh-lidaction-zh.txt'))), JSON.stringify({ ac: 1, dc: 1 }));
  eq(JSON.stringify(parseLidAction('    Current AC Power Setting Index: 0x00000000\n    Current DC Power Setting Index: 0x00000003\n')),
    JSON.stringify({ ac: 0, dc: 3 }), '英文系统');
  eq(parseLidAction('电源方案 GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (平衡)\n  GUID 别名: SCHEME_BALANCED\n'), null,
    '/q 在无盖机器上只有方案头（就是改用 /qh 的原因），不能读成值');
  eq(parseActiveScheme('电源方案 GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (平衡)'), '381b4222-f694-41f0-9685-ff5bb260df2e');
});

test('⑪ Windows：电池——台式机无电池视为插电、放电=用电池、电量读得到', () => {
  eq(JSON.stringify(parseWinBattery('')), JSON.stringify({ onAC: true, percent: null, hasBattery: false }));
  eq(parseWinBattery('{"EstimatedChargeRemaining":37,"BatteryStatus":1}').onAC, false);
  eq(parseWinBattery('[{"EstimatedChargeRemaining":88,"BatteryStatus":2}]').percent, 88, '多电池取第一块');
});

test('⑪ Windows：现代待机只看「可用」那段（台式机的 S0 在「不可用」里，win-4090 实采）', () => {
  eq(parseModernStandby(fx('powercfg-a-desktop-zh.txt')), false);
  eq(parseModernStandby('此系统上有以下睡眠状态:\n    待机(S0 低电量待机) 已连接网络\n    休眠\n\n此系统上没有以下睡眠状态:\n    待机 (S3)\n'), true);
});

test('⑪ Windows：脚本里的路径做了单引号转义（用户名带撇号不会截断命令）', () => {
  eq(psq("C:\\Users\\O'Brien\\x"), "'C:\\Users\\O''Brien\\x'");
  eq(buildWinWatchdog().includes(psq(WIN_MARKER)), true);
});

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);

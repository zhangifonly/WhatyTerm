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
import { countKeepAwakeSessions, decideLidSleep, parseBatt, parsePmset, clampFloor } from '../server/services/lidSleepPolicy.js';
import { buildSudoersRule, buildWatchdogScript, buildPlist } from '../server/services/lidSleepInstall.js';

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

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);

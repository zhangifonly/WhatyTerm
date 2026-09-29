/**
 * 合盖保活的一次性安装 / 卸载：sudoers 规则 + launchd 看门狗。
 *
 * 安装需要管理员密码，走 osascript 的系统授权框（弹在 Mac 本机屏幕上）。
 * 人不在 Mac 前（手机远程）弹框没人点，所以同时给出可在终端里手动执行的命令。
 * sudoers 文件先 visudo -cf 校验再以 root:wheel 0440 装入——语法错的 sudoers 会锁死 sudo。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import {
  SUDOERS_PATH, WATCHDOG_SCRIPT, WATCHDOG_PLIST, WATCHDOG_LABEL, MARKER_PATH, HEARTBEAT_PATH
} from './LidSleepGuard.js';

const RUN_DIR = path.dirname(MARKER_PATH);
const USER_RE = /^[a-z_][a-z0-9_.-]{0,31}$/i;

function run(cmd, args, timeout = 120000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, encoding: 'utf-8' }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', canceled: /-128|User canceled/i.test(stderr || '') });
    });
  });
}

/** sudoers 按参数字面匹配、无通配，所以这条规则只能执行这两条命令 */
export function buildSudoersRule(user) {
  if (!USER_RE.test(user)) throw new Error(`用户名不合法：${user}`);
  return `# WhatyTerm 合盖保活：只允许切换 disablesleep，别无其他权限\n`
    + `${user} ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1\n`;
}

/** 看门狗：心跳超 180 秒（服务死了）或电池到下限，就还原睡眠。只处理 WhatyTerm 自己开的标志 */
export function buildWatchdogScript() {
  return `#!/bin/sh
# WhatyTerm 合盖保活看门狗（launchd 每 60 秒运行一次）
MARKER="${MARKER_PATH}"
HB="${HEARTBEAT_PATH}"
[ -f "$MARKER" ] || exit 0
# 标记文件内容：「电量下限 温度上限」
read FLOOR TLIMIT < "$MARKER"
case "$FLOOR" in ''|*[!0-9]*) FLOOR=20;; esac
case "$TLIMIT" in ''|*[!0-9]*) TLIMIT=45;; esac
NOW=$(date +%s); HBT=$(stat -f %m "$HB" 2>/dev/null || echo 0)
BATT=$(/usr/bin/pmset -g batt)
PCT=$(echo "$BATT" | grep -Eo '[0-9]+%' | head -1 | tr -d %)
TEMP=$(/usr/sbin/ioreg -r -c AppleSmartBatteryPack -w0 | grep -Eo '"Temperature" ?= ?[0-9]+' | head -1 | grep -Eo '[0-9]+$')
[ -n "$TEMP" ] || TEMP=$(/usr/sbin/ioreg -r -c AppleSmartBattery -w0 | grep -Eo '"Temperature" ?= ?[0-9]+' | head -1 | grep -Eo '[0-9]+$')
THERM=$(/usr/bin/osascript -l JavaScript -e 'ObjC.import("Foundation"); $.NSProcessInfo.processInfo.thermalState' 2>/dev/null)
WHY=""
[ $((NOW - HBT)) -gt 180 ] && WHY="WhatyTerm 心跳超时"
if echo "$BATT" | grep -q "Battery Power" && [ -n "$PCT" ] && [ "$PCT" -le "$FLOOR" ]; then WHY="电量 $PCT% 到下限 $FLOOR%"; fi
# 开着盖子不管温度（人在用、散热正常）；读不到盖子状态按合盖处理
LID=$(/usr/sbin/ioreg -r -k AppleClamshellState -d 1 | grep -Eo '"AppleClamshellState" = (Yes|No)' | grep -Eo '(Yes|No)$')
if [ "$LID" != "No" ]; then
  if [ -n "$TEMP" ] && [ "$TEMP" -ge $((TLIMIT * 100)) ]; then WHY="电池温度 $((TEMP / 100))°C 到上限 $TLIMIT°C"; fi
  case "$THERM" in 2|3) WHY="系统热状态 $THERM（严重/危急）";; esac
fi
[ -n "$WHY" ] || exit 0
/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0 && rm -f "$MARKER"
/usr/bin/logger -t whatyterm-lidguard "已恢复睡眠：$WHY"
`;
}

export function buildPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${WATCHDOG_LABEL}</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>${WATCHDOG_SCRIPT}</string></array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
</dict></plist>
`;
}

/** 给人手动执行的等价命令（不在 Mac 前、或授权框被拒时用） */
export function manualCommands(user = os.userInfo().username) {
  const rule = buildSudoersRule(user).split('\n')[1];
  return [
    `echo '${rule}' | sudo tee ${SUDOERS_PATH} >/dev/null`,
    `sudo chmod 0440 ${SUDOERS_PATH} && sudo visudo -cf ${SUDOERS_PATH}`
  ];
}

/**
 * 看门狗在位才允许开标志：规则可能是用户照 manualCommands 手动装的，那条路径不会注册看门狗。
 * 脚本内容过期（升级后改了）也重写。返回看门狗是否就绪。
 */
export async function ensureWatchdog() {
  let current = '';
  try { current = fs.readFileSync(WATCHDOG_SCRIPT, 'utf-8'); } catch {}
  if (current === buildWatchdogScript() && fs.existsSync(WATCHDOG_PLIST)) return true;
  return loadWatchdog();
}

async function loadWatchdog() {
  fs.mkdirSync(path.dirname(WATCHDOG_SCRIPT), { recursive: true });
  fs.mkdirSync(path.dirname(WATCHDOG_PLIST), { recursive: true });
  fs.writeFileSync(WATCHDOG_SCRIPT, buildWatchdogScript(), { mode: 0o755 });
  fs.writeFileSync(WATCHDOG_PLIST, buildPlist());
  const domain = `gui/${process.getuid()}`;
  await run('/bin/launchctl', ['bootout', `${domain}/${WATCHDOG_LABEL}`], 10000);
  const r = await run('/bin/launchctl', ['bootstrap', domain, WATCHDOG_PLIST], 10000);
  return r.ok;
}

/**
 * 以管理员身份跑一段 root 脚本（系统授权框）。脚本与数据先写进用户目录，
 * AppleScript 字符串里只出现一个不含引号的路径，避免拼接注入。
 */
async function runAsAdmin(scriptBody) {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const f = path.join(RUN_DIR, `lidsleep-admin-${process.pid}.sh`);
  fs.writeFileSync(f, scriptBody, { mode: 0o700 });
  try {
    if (/["\\]/.test(f)) throw new Error('临时脚本路径含非法字符');
    const r = await run('/usr/bin/osascript', ['-e',
      `do shell script "/bin/sh ${f}" with prompt "WhatyTerm 需要安装合盖保活授权（仅允许切换 pmset disablesleep）" with administrator privileges`]);
    return r;
  } finally {
    fs.rmSync(f, { force: true });
  }
}

export async function install() {
  const user = os.userInfo().username;
  const src = path.join(RUN_DIR, `lidsleep-sudoers-${process.pid}`);
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(src, buildSudoersRule(user), { mode: 0o600 });
  try {
    const r = await runAsAdmin(`set -e
/usr/sbin/visudo -cf "${src}"
/usr/bin/install -m 0440 -o root -g wheel "${src}" "${SUDOERS_PATH}"
/usr/sbin/visudo -cf "${SUDOERS_PATH}"
`);
    if (!r.ok) {
      return { ok: false, canceled: r.canceled, error: r.canceled ? '已取消授权' : (r.stderr.trim().slice(0, 200) || '安装失败'), manual: manualCommands(user) };
    }
  } finally {
    fs.rmSync(src, { force: true });
  }
  const watchdog = await loadWatchdog();
  return { ok: true, watchdog, error: watchdog ? '' : '授权已装，但看门狗注册失败（launchctl bootstrap）' };
}

/** 卸载：先还原睡眠（此时规则还在，能免密），再删规则和看门狗 */
export async function uninstall() {
  await run('/usr/bin/sudo', ['-n', '/usr/bin/pmset', '-a', 'disablesleep', '0'], 10000);
  fs.rmSync(MARKER_PATH, { force: true });
  await run('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${WATCHDOG_LABEL}`], 10000);
  fs.rmSync(WATCHDOG_PLIST, { force: true });
  fs.rmSync(WATCHDOG_SCRIPT, { force: true });
  const r = await runAsAdmin(`rm -f "${SUDOERS_PATH}"\n`);
  return { ok: r.ok, canceled: r.canceled, error: r.ok ? '' : (r.canceled ? '已取消授权，规则未删除' : r.stderr.trim().slice(0, 200)),
    manual: r.ok ? [] : [`sudo rm -f ${SUDOERS_PATH}`] };
}

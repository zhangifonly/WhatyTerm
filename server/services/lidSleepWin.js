/**
 * 合盖不睡眠 · Windows 适配（实验性：未在 Windows 笔记本上实测，只在台式机上验证过合盖以外的部分）。
 *
 * 与 macOS 的对应关系：
 *   pmset disablesleep 1  ←→  powercfg 把「合上盖子时」设为「不采取任何操作」（LIDACTION=0，插电/电池各一份）
 *   caffeinate            ←→  常驻隐藏 PowerShell 持有 PowerRequest（SystemRequired + ExecutionRequired），
 *                              防空闲睡眠，也防「现代待机」笔记本熄屏后把后台进程挂起
 *   launchd 看门狗        ←→  服务派生的独立 PowerShell 看门狗（服务崩了它还在）+ 登录时自启（HKCU Run），
 *                              心跳超 180 秒或电量到下限就把 LIDACTION 改回原值
 * 全程不需要管理员：改的是当前用户的电源方案、HKCU 注册表。
 * 没有温度：Windows 读温度要管理员且多数笔记本返回假值，交给固件自带的过热保护。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile, spawn } from 'child_process';

const HOME = os.homedir();
export const WIN_DIR = path.join(HOME, '.webtmux', 'run');
export const WIN_MARKER = path.join(WIN_DIR, 'lid-sleep-owner.json');   // 原值 + 下限，看门狗据此还原
export const WIN_HEARTBEAT = path.join(WIN_DIR, 'lid-sleep-heartbeat');
export const WIN_WATCHDOG = path.join(HOME, '.webtmux', 'bin', 'lid-guard.ps1');
export const WIN_KEEPER = path.join(HOME, '.webtmux', 'bin', 'lid-keeper.ps1');
const WIN_WATCHDOG_PID = path.join(WIN_DIR, 'lid-guard.pid');
export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const RUN_VALUE = 'WhatyTermLidGuard';
const SUB = ['SUB_BUTTONS', 'LIDACTION'];

function run(cmd, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, encoding: 'utf-8', windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}
// PowerShell 单引号字面量：内部的 ' 写成 ''（用户名可能带撇号）
export const psq = (v) => `'${String(v).replace(/'/g, "''")}'`;
const ps = (script) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);

/** 看门狗：常驻循环。-Once 只查一次（登录自启时用：重启后心跳必然过期，直接还原） */
export function buildWinWatchdog() {
  return `param([switch]$Once)
# WhatyTerm lid-sleep watchdog
$marker = ${psq(WIN_MARKER)}; $hb = ${psq(WIN_HEARTBEAT)}
while ($true) {
  if (-not (Test-Path $marker)) { exit 0 }
  $m = Get-Content $marker -Raw | ConvertFrom-Json
  $age = 99999
  if (Test-Path $hb) { $age = ((Get-Date) - (Get-Item $hb).LastWriteTime).TotalSeconds }
  $why = ''
  if ($age -gt 180) { $why = 'heartbeat' }
  $b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($b -and $b.BatteryStatus -eq 1 -and $b.EstimatedChargeRemaining -le $m.floor) { $why = 'battery' }
  if ($why) {
    powercfg /setacvalueindex $m.scheme ${SUB.join(' ')} $m.ac | Out-Null
    powercfg /setdcvalueindex $m.scheme ${SUB.join(' ')} $m.dc | Out-Null
    powercfg /setactive SCHEME_CURRENT | Out-Null
    Remove-Item $marker -Force -ErrorAction SilentlyContinue
    exit 0
  }
  if ($Once) { exit 0 }
  Start-Sleep -Seconds 60
}
`;
}

/** 保活：持有电源请求直到父进程（服务）退出。PowerRequest 比 SetThreadExecutionState 多一个 ExecutionRequired，现代待机也不挂起 */
export function buildWinKeeper() {
  return `param([int]$ParentPid)
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class WtPower {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Ctx { public uint Version; public uint Flags; public string Reason; }
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr PowerCreateRequest(ref Ctx c);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool PowerSetRequest(IntPtr h, int t);
  [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);
}
"@
$c = New-Object WtPower+Ctx; $c.Version = 0; $c.Flags = 1; $c.Reason = 'WhatyTerm: sessions running'
$h = [WtPower]::PowerCreateRequest([ref]$c)
[void][WtPower]::PowerSetRequest($h, 1)   # SystemRequired
[void][WtPower]::PowerSetRequest($h, 3)   # ExecutionRequired
[void][WtPower]::SetThreadExecutionState([uint32]"0x80000001")
while (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 5 }
`;
}

/** powercfg /q 的输出随系统语言本地化（中文是「当前交流电源设置索引」），只认两个 0x 十六进制值：先 AC 后 DC */
export function parseLidAction(out) {
  const hex = String(out || '').match(/0x[0-9a-f]{8}/gi) || [];
  if (hex.length < 2) return null;
  const [ac, dc] = hex.slice(-2).map((h) => parseInt(h, 16));
  return { ac, dc };
}

export function parseActiveScheme(out) {
  const m = String(out || '').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0] : null;
}

/** Win32_Battery.BatteryStatus：1 放电（用电池），2 接交流电；台式机没有电池对象 → 视为插电、电量未知 */
export function parseWinBattery(json) {
  let b = null;
  try { b = JSON.parse(json || 'null'); } catch {}
  if (Array.isArray(b)) b = b[0];
  if (!b) return { onAC: true, percent: null, hasBattery: false };
  return { onAC: b.BatteryStatus !== 1, percent: Number.isFinite(b.EstimatedChargeRemaining) ? b.EstimatedChargeRemaining : null, hasBattery: true };
}

export async function readWinPower() {
  const [bat, lid] = await Promise.all([
    ps('Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress'),
    // /qh 而非 /q：没有盖子的机器（台式机、部分驱动）会把 LIDACTION 隐藏，/q 读不到当前值
    run('powercfg', ['/qh', 'SCHEME_CURRENT', ...SUB])
  ]);
  const b = parseWinBattery(bat.stdout.trim());
  const la = parseLidAction(lid.stdout);
  return { ...b, lidAction: la, overrideOn: !!la && la.ac === 0 && la.dc === 0, owned: fs.existsSync(WIN_MARKER) };
}

async function applyLidAction(scheme, ac, dc) {
  const a = await run('powercfg', ['/setacvalueindex', scheme, ...SUB, String(ac)]);
  const d = await run('powercfg', ['/setdcvalueindex', scheme, ...SUB, String(dc)]);
  await run('powercfg', ['/setactive', 'SCHEME_CURRENT']);
  return a.ok && d.ok ? '' : `powercfg 失败：${(a.stderr || d.stderr || a.stdout).trim().slice(0, 120)}`;
}

let keeper = null;
function startKeeper() {
  if (keeper && keeper.exitCode === null) return;
  keeper = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', WIN_KEEPER,
    '-ParentPid', String(process.pid)], { stdio: 'ignore', windowsHide: true });
  keeper.on('exit', () => { keeper = null; });
}
function stopKeeper() {
  try { keeper?.kill(); } catch {}
  keeper = null;
}

/**
 * 看门狗必须独立于服务：服务被强杀它照样在，这正是它存在的意义。
 * ⚠ 不能用 spawn({ detached: true })：win-4090 实测 PowerShell 以 DETACHED_PROCESS 启动后立即退出（没有控制台）。
 *   改由 WMI 的 Win32_Process.Create 创建：父进程是 WmiPrvSE，与服务无父子关系，ShowWindow=0 不弹窗；
 *   实测发起方 node 与 SSH 会话都退出后它仍在运行。
 */
async function startWatchdog() {
  try {
    const pid = Number(fs.readFileSync(WIN_WATCHDOG_PID, 'utf-8'));
    if (pid) { process.kill(pid, 0); return; }        // 还活着
  } catch {}
  const cmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${WIN_WATCHDOG}"`;
  const r = await ps(`$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}; `
    + `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=${psq(cmd)}; ProcessStartupInformation=$si}; `
    + `"$($r.ReturnValue) $($r.ProcessId)"`);
  const [code, pid] = r.stdout.trim().split(/\s+/).map(Number);
  if (code === 0 && pid) fs.writeFileSync(WIN_WATCHDOG_PID, String(pid));
  else console.warn(`[LidSleep] 看门狗启动失败：${r.stdout.trim() || r.stderr.trim()}`);
}

/**
 * 开/关覆盖。开之前**先写标记**（原值 + 方案 + 下限）再改设置：中间崩了，看门狗也知道改回什么。
 * 用户自己本来就设成「不采取任何操作」且没有我们的标记 → 不接管，也永远不去「还原」它。
 */
export async function setWinOverride(on, floor) {
  fs.mkdirSync(WIN_DIR, { recursive: true });
  if (on) {
    const cur = await readWinPower();
    if (cur.overrideOn && !cur.owned) return { ok: true, foreign: true };
    if (!cur.owned) {
      const scheme = parseActiveScheme((await run('powercfg', ['/getactivescheme'])).stdout);
      if (!scheme || !cur.lidAction) return { ok: false, error: '读不到当前电源方案或合盖设置' };
      fs.writeFileSync(WIN_MARKER, JSON.stringify({ scheme, ac: cur.lidAction.ac, dc: cur.lidAction.dc, floor }));
    }
    if (!cur.overrideOn) {       // 已生效（服务重启后接回）就不重复写 powercfg，只补回保活与看门狗
      const m = JSON.parse(fs.readFileSync(WIN_MARKER, 'utf-8'));
      const err = await applyLidAction(m.scheme, 0, 0);
      if (err) return { ok: false, error: err };
    }
    startKeeper();
    // 先写心跳再拉看门狗：否则它第一轮看到「没有心跳」就判服务已死，刚开就被还原
    fs.writeFileSync(WIN_HEARTBEAT, String(Date.now()));
    await startWatchdog();
    return { ok: true };
  }
  stopKeeper();
  if (!fs.existsSync(WIN_MARKER)) return { ok: true };
  const m = JSON.parse(fs.readFileSync(WIN_MARKER, 'utf-8'));
  const err = await applyLidAction(m.scheme, m.ac, m.dc);
  if (err) return { ok: false, error: err };
  fs.rmSync(WIN_MARKER, { force: true });
  return { ok: true };
}

/** 看门狗读标记里的下限，改配置时同步过去 */
export function updateWinFloor(floor) {
  try {
    const m = JSON.parse(fs.readFileSync(WIN_MARKER, 'utf-8'));
    fs.writeFileSync(WIN_MARKER, JSON.stringify({ ...m, floor }));
  } catch {}
}

/** PowerShell 5.1 读无 BOM 文件按 ANSI 解码，中文用户名路径会乱码 → 写 UTF-8 BOM */
function writePs(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = '\ufeff' + body.replace(/\n/g, '\r\n');
  let cur = '';
  try { cur = fs.readFileSync(file, 'utf-8'); } catch {}
  if (cur !== text) fs.writeFileSync(file, text);
}

/**
 * 就绪：写好两个脚本 + 登录自启看门狗（-Once）。
 * 自启是为了「关机重启」：powercfg 设置跨重启保留，而看门狗进程不会，重启后心跳必然过期，登录即还原。
 */
export async function ensureWinReady() {
  writePs(WIN_WATCHDOG, buildWinWatchdog());
  writePs(WIN_KEEPER, buildWinKeeper());
  const cmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${WIN_WATCHDOG}" -Once`;
  const q = await run('reg', ['query', RUN_KEY, '/v', RUN_VALUE]);
  if (q.ok && q.stdout.includes(WIN_WATCHDOG)) return true;
  return (await run('reg', ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', cmd, '/f'])).ok;
}

/** 卸载：先还原合盖设置，再删自启项与脚本 */
export async function uninstallWin() {
  const r = await setWinOverride(false);
  try { process.kill(Number(fs.readFileSync(WIN_WATCHDOG_PID, 'utf-8'))); } catch {}
  fs.rmSync(WIN_WATCHDOG_PID, { force: true });
  await run('reg', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f']);
  fs.rmSync(WIN_WATCHDOG, { force: true });
  fs.rmSync(WIN_KEEPER, { force: true });
  return { ok: r.ok, error: r.error || '', manual: [] };
}

/** 现代待机（S0 低功耗空闲）机型：熄屏后后台最容易被挂起，诊断时要知道是不是这类机器 */
export async function detectModernStandby() {
  const r = await run('powercfg', ['/a']);
  return r.ok ? parseModernStandby(r.stdout) : null;
}

/**
 * `powercfg /a` 先列「有」的睡眠状态、空一行、再列「没有」的。S0 出现在后半段（台式机实测
 * 「待机(S0 低电量待机) 系统固件不支持」）不算，所以只看第一个空行之前那段。
 */
export function parseModernStandby(out) {
  const available = String(out || '').split(/\r?\n\s*\r?\n/)[0] || '';
  return /S0/.test(available);
}

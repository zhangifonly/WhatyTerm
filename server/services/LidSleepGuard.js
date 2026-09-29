/**
 * 合盖保活执行器：按 lidSleepPolicy 的决策切换 `pmset -a disablesleep`。
 *
 * 权限：服务不拿 root。一次性装一条 sudoers 规则，**只**放行两条字面命令
 *   /usr/bin/pmset -a disablesleep 0 / 1（sudoers 按参数字面匹配，放不宽）
 * 之后用 `sudo -n` 调用，永不弹密码。
 *
 * 所有权：只还原**自己**开的标志（标记文件 lid-sleep-owner）。别的工具（Amphetamine 等）
 * 开的 SleepDisabled 一律不碰，否则两个管理器互相关掉对方。
 *
 * 崩溃兜底：标志是持久的，服务被强杀后不会自己消失。独立的 launchd 看门狗每 60 秒
 * 查一次心跳文件，心跳超过 180 秒没更新或电量到下限，就还原并删掉标记。
 *
 * ⚠️ 后台循环禁用 execSync（会阻塞事件循环致终端卡顿，见记忆 puppeteer-mcp-runaway-lag）
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import {
  decideLidSleep, countKeepAwakeSessions, parseBatt, parsePmset, clampFloor, DEFAULT_BATTERY_FLOOR,
  thermalVerdict, parseBatteryTemp, DEFAULT_TEMP_LIMIT
} from './lidSleepPolicy.js';

const HOME = os.homedir();
const RUN_DIR = path.join(HOME, '.webtmux', 'run');
const CONFIG_PATH = path.join(HOME, '.webtmux', 'lid-sleep.json');
export const MARKER_PATH = path.join(RUN_DIR, 'lid-sleep-owner');
export const HEARTBEAT_PATH = path.join(RUN_DIR, 'lid-sleep-heartbeat');
export const WATCHDOG_SCRIPT = path.join(HOME, '.webtmux', 'bin', 'lid-guard.sh');
export const WATCHDOG_LABEL = 'com.whaty.webtmux.lidguard';
export const WATCHDOG_PLIST = path.join(HOME, 'Library', 'LaunchAgents', `${WATCHDOG_LABEL}.plist`);
const UID = typeof process.getuid === 'function' ? process.getuid() : 0;
export const SUDOERS_PATH = `/etc/sudoers.d/whatyterm-lidsleep-${UID}`;
const PMSET = '/usr/bin/pmset';
const LID_POLL_MS = 5000;
// 系统热状态：经 JXA 的 ObjC 桥读 NSProcessInfo.thermalState，免编译、免 root，约 70ms
const THERMAL_JXA = 'ObjC.import("Foundation"); $.NSProcessInfo.processInfo.thermalState';

export function clampTempLimit(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_TEMP_LIMIT;
  return Math.min(60, Math.max(38, Math.round(n)));
}

function run(cmd, args, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, encoding: 'utf-8' }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

class LidSleepGuard {
  constructor() {
    this.supported = os.platform() === 'darwin';
    this.config = this._loadConfig();
    this.installed = false;
    this.state = { sleepDisabled: null, owned: false, onAC: false, percent: null, lowPowerMode: false,
      keepAwake: 0, busy: 0, auto: 0, reason: '', lidClosed: null, lastError: '',
      thermalState: null, batteryTempC: null, thermalTripped: false };
    this._lidTimer = null;
    this._ticking = false;
    this.watchdogReady = false;
    this._ensureWatchdog = null;   // 由 index.js 注入 lidSleepInstall.ensureWatchdog（避免循环 import）
  }

  setWatchdogProvider(fn) { this._ensureWatchdog = fn; }

  _loadConfig() {
    try {
      const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      return { enabled: !!c.enabled, batteryFloor: clampFloor(c.batteryFloor), tempLimit: clampTempLimit(c.tempLimit) };
    } catch {
      return { enabled: false, batteryFloor: DEFAULT_BATTERY_FLOOR, tempLimit: DEFAULT_TEMP_LIMIT };
    }
  }

  _saveConfig() {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(this.config, null, 2));
  }

  /** 授权规则是否可用：sudo -n -l 能列出这条命令即说明免密可执行（不需要 root 就能查） */
  async checkInstalled() {
    if (!this.supported) return false;
    const r = await run('/usr/bin/sudo', ['-n', '-l', PMSET, '-a', 'disablesleep', '1']);
    this.installed = r.ok;
    return this.installed;
  }

  async _readPower() {
    const [batt, pm, th, bt] = await Promise.all([
      run(PMSET, ['-g', 'batt']), run(PMSET, ['-g']),
      run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', THERMAL_JXA]),
      run('/usr/sbin/ioreg', ['-r', '-c', 'AppleSmartBatteryPack', '-w0'])
    ]);
    const b = parseBatt(batt.stdout);
    const p = parsePmset(pm.stdout);
    const ts = parseInt(th.stdout.trim(), 10);
    this.state.thermalState = th.ok && Number.isInteger(ts) ? ts : null;
    let tempC = parseBatteryTemp(bt.stdout);
    if (tempC == null) tempC = parseBatteryTemp((await run('/usr/sbin/ioreg', ['-r', '-c', 'AppleSmartBattery', '-w0'])).stdout);
    this.state.batteryTempC = tempC;
    Object.assign(this.state, { onAC: b.onAC, percent: b.percent, sleepDisabled: p.sleepDisabled, lowPowerMode: p.lowPowerMode });
    this.state.owned = fs.existsSync(MARKER_PATH);
  }

  /** 切换标志并读回核对——面板显示的是读回值，不是我们以为设成了什么 */
  async _setDisabled(on) {
    const r = await run('/usr/bin/sudo', ['-n', PMSET, '-a', 'disablesleep', on ? '1' : '0']);
    if (!r.ok) {
      this.state.lastError = `pmset 执行失败：${(r.stderr || '').trim().slice(0, 120) || `退出码 ${r.code}`}`;
      return false;
    }
    fs.mkdirSync(RUN_DIR, { recursive: true });
    if (on) {
      this._writeMarker();
      this._touchHeartbeat();
    } else {
      fs.rmSync(MARKER_PATH, { force: true });
    }
    await this._readPower();
    this.state.lastError = this.state.sleepDisabled === on ? '' : '读回的 SleepDisabled 与期望不一致';
    console.log(`[LidSleep] disablesleep=${on ? 1 : 0}（读回 ${this.state.sleepDisabled ? 1 : 0}）`);
    return this.state.sleepDisabled === on;
  }

  /** 标记文件兼作看门狗的参数：「电量下限 温度上限」两个整数 */
  _writeMarker() {
    fs.writeFileSync(MARKER_PATH, `${this.config.batteryFloor} ${this.config.tempLimit}`);
  }

  _touchHeartbeat() {
    try { fs.writeFileSync(HEARTBEAT_PATH, String(Date.now())); } catch {}
  }

  /** 周期调用（与 SleepPreventionService 同一个 60 秒定时器）。重入保护：上一轮没完就跳过 */
  async tick(sessions) {
    if (!this.supported || this._ticking) return;
    this._ticking = true;
    try {
      await this.checkInstalled();
      // 看门狗不在位就不开标志：服务一旦被强杀，没人还原，Mac 会永远不睡
      this.watchdogReady = this.installed && this._ensureWatchdog ? await this._ensureWatchdog() : false;
      await this._readPower();
      const k = countKeepAwakeSessions(sessions);
      Object.assign(this.state, { keepAwake: k.total, busy: k.busy, auto: k.auto });
      const thermal = thermalVerdict({ thermalState: this.state.thermalState, batteryTempC: this.state.batteryTempC,
        limitC: this.config.tempLimit, tripped: this.state.thermalTripped });
      if (thermal.tripped !== this.state.thermalTripped) console.log(`[LidSleep] 过热保护${thermal.tripped ? '触发' : '解除'}：${thermal.why || '已降温'}`);
      this.state.thermalTripped = thermal.tripped;
      const d = decideLidSleep({
        thermal,
        enabled: this.config.enabled, installed: this.installed && this.watchdogReady, keepAwake: k.total,
        onAC: this.state.onAC, percent: this.state.percent, lowPowerMode: this.state.lowPowerMode,
        floor: this.config.batteryFloor
      });
      this.state.reason = d.reason;
      if (d.disable) {
        if (!this.state.sleepDisabled) await this._setDisabled(true);
        else if (!this.state.owned) this.state.reason = '合盖不睡已由其他工具开启（如 Amphetamine），WhatyTerm 不接管';
        if (this.state.owned) this._touchHeartbeat();
      } else if (this.state.owned && this.installed) {
        // 只还原自己开的；别人开的不碰
        await this._setDisabled(false);
      }
      this._syncLidWatcher();
    } catch (err) {
      this.state.lastError = err.message;
    } finally {
      this._ticking = false;
    }
  }

  /**
   * 合盖黑屏：SleepDisabled=1 时合盖不会关内屏，屏幕在盖子里一直亮着发热耗电
   * （lidwatch / LidAwake 都专门处理了这一点）。我们开着标志期间轮询盖子状态，
   * 一合上就 `pmset displaysleepnow`（不需要 root）。
   */
  _syncLidWatcher() {
    const need = this.state.owned && this.state.sleepDisabled;
    if (need && !this._lidTimer) {
      this._lidTimer = setInterval(() => this._pollLid(), LID_POLL_MS);
      if (this._lidTimer.unref) this._lidTimer.unref();
    } else if (!need && this._lidTimer) {
      clearInterval(this._lidTimer);
      this._lidTimer = null;
      this.state.lidClosed = null;
    }
  }

  async _pollLid() {
    const r = await run('/usr/sbin/ioreg', ['-r', '-k', 'AppleClamshellState', '-d', '1']);
    const m = r.stdout.match(/"AppleClamshellState"\s*=\s*(Yes|No)/);
    if (!m) return;
    const closed = m[1] === 'Yes';
    if (closed && this.state.lidClosed === false) {
      await run(PMSET, ['displaysleepnow']);
      console.log('[LidSleep] 盖子合上，已关闭内屏');
    }
    this.state.lidClosed = closed;
  }

  get status() {
    return {
      supported: this.supported,
      enabled: this.config.enabled,
      batteryFloor: this.config.batteryFloor,
      tempLimit: this.config.tempLimit,
      installed: this.installed,
      watchdogReady: this.watchdogReady,
      active: !!(this.state.owned && this.state.sleepDisabled),
      ...this.state
    };
  }

  async setConfig({ enabled, batteryFloor, tempLimit } = {}) {
    if (typeof enabled === 'boolean') this.config.enabled = enabled;
    if (tempLimit !== undefined) this.config.tempLimit = clampTempLimit(tempLimit);
    if (batteryFloor !== undefined) this.config.batteryFloor = clampFloor(batteryFloor);
    this._saveConfig();
    if (this.state.owned) this._writeMarker(); // 看门狗读这里的下限
    return this.status;
  }

  // ⚠ 刻意不在服务退出时还原：合盖+电池时 `service:restart`，一还原 Mac 当场睡下，
  //   新进程根本起不来。退出后的还原统一交给看门狗（心跳 180 秒没更新才还原），
  //   服务几秒内重启回来会接着续心跳，标记文件还在所以所有权不丢。
}

export default new LidSleepGuard();

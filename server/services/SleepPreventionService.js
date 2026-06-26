import { spawn, execSync } from 'child_process';
import os from 'os';

class SleepPreventionService {
  constructor() {
    this.caffeinateProcess = null;
    this.enabled = false;
    this.reason = '';
    this.activeSessionCount = 0;
    this.onACPower = false;       // 是否接通电源
    this.clamshellSafe = false;   // 合盖能否保持运行（仅插电的 Apple Silicon/Intel 才行）
  }

  get isActive() {
    return this.caffeinateProcess !== null && !this.caffeinateProcess.killed;
  }

  // 检测是否接通电源（AC）。电池供电时 Apple Silicon 合盖必休眠，caffeinate -s 被忽略。
  detectPowerSource() {
    if (os.platform() !== 'darwin') return false;
    try {
      const out = execSync('pmset -g batt', { encoding: 'utf-8', timeout: 3000 });
      // "Now drawing from 'AC Power'" = 插电；"'Battery Power'" = 电池
      this.onACPower = /AC Power/i.test(out);
    } catch {
      this.onACPower = false;
    }
    return this.onACPower;
  }

  get status() {
    return {
      supported: os.platform() === 'darwin',
      active: this.isActive,
      enabled: this.enabled,
      reason: this.reason,
      activeSessionCount: this.activeSessionCount,
      pid: this.caffeinateProcess?.pid || null,
      onACPower: this.onACPower,
      clamshellSafe: this.clamshellSafe,
      // 给前端的人类可读提示
      clamshellHint: this.clamshellSafe
        ? '已接电源，合盖可保持运行（Wi-Fi 长任务建议外接显示器或保持开盖最稳）'
        : '电池供电下合盖会休眠并断开 Wi-Fi（Apple Silicon 硬限制），请接通电源后再合盖'
    };
  }

  prevent(reason = '') {
    if (os.platform() !== 'darwin') return;
    if (this.isActive) return;

    try {
      // -d: 阻止显示器休眠（可选）
      // -i: 阻止系统空闲休眠
      // -s: 阻止系统休眠（包括合盖）
      this.caffeinateProcess = spawn('caffeinate', ['-dis'], {
        stdio: 'ignore',
        detached: false
      });

      this.caffeinateProcess.on('error', (err) => {
        console.error('[SleepPrevention] caffeinate 启动失败:', err.message);
        this.caffeinateProcess = null;
      });

      this.caffeinateProcess.on('exit', (code) => {
        console.log(`[SleepPrevention] caffeinate 退出 (code=${code})`);
        this.caffeinateProcess = null;
      });

      this.enabled = true;
      this.reason = reason;
      console.log(`[SleepPrevention] 已阻止休眠 (pid=${this.caffeinateProcess.pid}, 原因: ${reason})`);
    } catch (err) {
      console.error('[SleepPrevention] 启动失败:', err.message);
    }
  }

  release() {
    if (!this.caffeinateProcess) return;

    try {
      this.caffeinateProcess.kill('SIGTERM');
    } catch {}

    this.caffeinateProcess = null;
    this.enabled = false;
    this.reason = '';
    console.log('[SleepPrevention] 已释放休眠阻止');
  }

  update(sessions) {
    if (os.platform() !== 'darwin') return;

    // 检测电源：决定合盖能否保持（Apple Silicon 电池供电下合盖必休眠，caffeinate 拦不住）
    this.detectPowerSource();

    // 统计有活跃 claude 进程的会话数
    let activeCount = 0;
    for (const session of sessions) {
      const content = session.getScreenContent?.() || '';
      const isRunning = /esc to interrupt|Cogitat|Brew|Bak|Wrangl|Form|Work/i.test(content);
      if (isRunning) activeCount++;
    }

    this.activeSessionCount = activeCount;
    // 合盖保活只有"插电 + 有 caffeinate 保活"时才成立
    this.clamshellSafe = this.onACPower && (this.isActive || activeCount > 0);

    if (activeCount > 0 && !this.isActive) {
      this.prevent(`${activeCount} 个会话运行中`);
    } else if (activeCount === 0 && this.isActive) {
      this.release();
    } else if (activeCount > 0 && this.isActive) {
      this.reason = `${activeCount} 个会话运行中`;
    }

    // 电池供电 + 有运行中会话时，警告用户合盖会中断（每 60s 最多提示一次，避免刷屏）
    if (activeCount > 0 && !this.onACPower) {
      const now = Date.now();
      if (!this._lastBatteryWarn || now - this._lastBatteryWarn > 60000) {
        this._lastBatteryWarn = now;
        console.warn(`[SleepPrevention] ⚠️ 电池供电中，${activeCount} 个会话运行中——此时合盖会休眠并断开 Wi-Fi（Apple Silicon 硬限制），请接通电源后再合盖。`);
      }
    }
  }

  destroy() {
    this.release();
  }
}

export default new SleepPreventionService();
/**
 * 合盖保活决策（纯逻辑，可单测）。副作用全在 LidSleepGuard.js。
 *
 * 背景：caffeinate / 电源断言只能挡空闲睡眠，挡不住合盖——合盖是硬件触发的显式睡眠请求。
 * 唯一可靠的开关是 `pmset -a disablesleep 1`（内核 SleepDisabled 标志），插电与电池都生效。
 * 做法对齐三个开源实现（Sleepless / caffeinate-disablesleep / LidAwake）：
 *   - 只开「真有活要跑」的时候，活一停就还原
 *   - 电池低于下限、低电量模式时强制还原，不把电耗光
 *   - 标志是持久的（不像 caffeinate -w 随进程消失），崩溃后由独立看门狗还原
 */

import { isCliBusy } from './AIEngine.js';

export const DEFAULT_BATTERY_FLOOR = 20;
export const MIN_BATTERY_FLOOR = 5;
export const MAX_BATTERY_FLOOR = 80;

// 与 index.js 的 stripAnsiForProbe 同三条：抓屏走 capture-pane -e，Codex 会把色码插进
// "esc to interrupt" 词中间，不剥码必失配（见记忆 screen-parsing-must-strip-ansi）
export function stripAnsi(text) {
  return String(text || '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '');
}

// 运行指示器永远贴底：Claude 是 spinner 行 + 其下的待办清单 + 输入框 + 底栏，Codex 是
// Working 行 + Tip + 输入框 + 底栏。按「末尾非空行」而不是字符数取窗口——中文屏一行只有
// 二十来个字符，1500 字符能回溯 60 行，会把早已结束的旧 esc to interrupt 当成正在跑
const TAIL_LINES = 15;

export function screenTail(text, n = TAIL_LINES) {
  return stripAnsi(text).split('\n').filter((l) => l.trim()).slice(-n).join('\n');
}

/**
 * 需要保持唤醒的会话数：CLI 正忙，或开着自动操作（监控要能继续发「继续」，睡了就断）。
 */
export function countKeepAwakeSessions(sessions) {
  let busy = 0;
  let auto = 0;
  for (const s of sessions || []) {
    const tail = screenTail(s.getScreenContent?.() || '');
    if (isCliBusy(tail)) busy++;
    else if (s.autoActionEnabled) auto++;
  }
  return { busy, auto, total: busy + auto };
}

export function clampFloor(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_BATTERY_FLOOR;
  return Math.min(MAX_BATTERY_FLOOR, Math.max(MIN_BATTERY_FLOOR, Math.round(n)));
}

/** 解析 `pmset -g batt`：是否插电、电量百分比（读不到为 null） */
export function parseBatt(out) {
  const text = String(out || '');
  const m = text.match(/(\d{1,3})%/);
  return { onAC: /AC Power/i.test(text), percent: m ? Number(m[1]) : null };
}

/** 解析 `pmset -g`：SleepDisabled 标志与低电量模式 */
export function parsePmset(out) {
  const text = String(out || '');
  const sd = text.match(/SleepDisabled\s+(\d)/);
  const lpm = text.match(/lowpowermode\s+(\d)/);
  return { sleepDisabled: sd ? sd[1] === '1' : null, lowPowerMode: lpm ? lpm[1] === '1' : false };
}

/**
 * 该不该让合盖不睡。返回 { disable, reason }，reason 给面板显示。
 * @param {object} s
 *   enabled 用户开关 · installed 授权规则已装 · keepAwake 需保活的会话数
 *   onAC 是否插电 · percent 电量 · lowPowerMode · floor 电池下限
 */
export function decideLidSleep(s) {
  if (!s.enabled) return { disable: false, reason: '未开启' };
  if (!s.installed) return { disable: false, reason: '尚未授权（需管理员密码安装一次）' };
  if (!s.keepAwake) return { disable: false, reason: '没有运行中或自动操作的会话，允许正常睡眠' };
  if (!s.onAC) {
    if (s.lowPowerMode) return { disable: false, reason: '电池供电且处于低电量模式，已让位' };
    if (s.percent == null) return { disable: false, reason: '读不到电量，保守起见允许睡眠' };
    if (s.percent <= s.floor) return { disable: false, reason: `电量 ${s.percent}% 已到下限 ${s.floor}%，恢复睡眠` };
    return { disable: true, reason: `电池 ${s.percent}%，${s.keepAwake} 个会话在跑，合盖不睡（低于 ${s.floor}% 自动恢复）` };
  }
  return { disable: true, reason: `已接电源，${s.keepAwake} 个会话在跑，合盖不睡` };
}

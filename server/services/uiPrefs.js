/**
 * 界面偏好（跨设备）：会话置顶顺序与列表排序模式。
 *
 * 为什么放服务端：这两项原来只存浏览器 localStorage，而**手机是另一台设备读不到** ——
 * 于是电脑上置顶的会话在手机上不置顶、排序模式也各是各的，同一批会话两端顺序对不上号
 * （2026-09-21 检查移动版时发现）。
 *
 * 与 ConfigService（故障转移、健康检查那些运行参数）分开：那是"系统怎么跑"，
 * 这是"我想怎么看"，改动频率与失败后果都不同，混在一个文件里互相牵连。
 *
 * 落盘在 ~/.webtmux/ui-prefs.json —— 与 longrun-requirements 同一个用户级目录，
 * 不进项目仓库（这是个人偏好，不该随代码走）。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import os from 'os';

export const PREFS_DIR = path.join(os.homedir(), '.webtmux');
export const PREFS_FILE = path.join(PREFS_DIR, 'ui-prefs.json');

/** 排序模式取值必须与前端共享模块（src/utils/sessionSort.js）一致 */
export const SORT_MODES = ['fixed', 'active', 'pending', 'auto'];
export const DEFAULT_PREFS = { pinnedSessions: [], sessionSort: 'fixed' };

/**
 * 规整：外部传进来的东西一律按白名单过一遍。
 * 置顶是**有序数组**而非集合 —— 顺序决定快捷键位（先置顶的拿 ⌘1），用 Set 会丢掉这个语义。
 */
export function normalizePrefs(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const pinned = Array.isArray(o.pinnedSessions) ? o.pinnedSessions : [];
  const seen = new Set();
  const pinnedSessions = [];
  for (const id of pinned) {
    const s = String(id || '').trim();
    if (s && !seen.has(s)) { seen.add(s); pinnedSessions.push(s); }
  }
  const sessionSort = SORT_MODES.includes(o.sessionSort) ? o.sessionSort : DEFAULT_PREFS.sessionSort;
  return { pinnedSessions, sessionSort };
}

/** 读。文件不存在或坏了都返回默认值 —— 偏好读不出来不该让界面打不开 */
export function readPrefs() {
  try {
    if (!existsSync(PREFS_FILE)) return { ...DEFAULT_PREFS };
    return normalizePrefs(JSON.parse(readFileSync(PREFS_FILE, 'utf8')));
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/**
 * 合并写入（只覆盖传进来的字段）。
 * @returns {{ok:boolean, prefs:object, error?:string}} 失败也把当前值带回去，调用方好如实告诉人
 */
export function writePrefs(patch = {}) {
  const next = normalizePrefs({ ...readPrefs(), ...(patch || {}) });
  try {
    mkdirSync(PREFS_DIR, { recursive: true });
    writeFileSync(PREFS_FILE, JSON.stringify(next, null, 2), 'utf8');
    return { ok: true, prefs: next };
  } catch (e) {
    return { ok: false, prefs: readPrefs(), error: e.message };
  }
}

/**
 * 切换某个会话的置顶。追加到末尾：先置顶的先拿小号（与桌面版原有语义一致）。
 */
export function togglePinned(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return { ok: false, prefs: readPrefs(), error: '缺少会话 id' };
  const cur = readPrefs().pinnedSessions;
  const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  return writePrefs({ pinnedSessions: next });
}

/**
 * 清掉已经不存在的会话的置顶。
 * 不清的话，删掉的会话会一直占着快捷键位，⌘1 按下去什么都不会发生。
 * @param {string[]} aliveIds 当前仍存在的会话 id
 */
export function prunePinned(aliveIds = []) {
  const alive = new Set((aliveIds || []).map((x) => String(x)));
  const cur = readPrefs().pinnedSessions;
  const next = cur.filter((id) => alive.has(id));
  if (next.length === cur.length) return { ok: true, prefs: readPrefs(), changed: false };
  return { ...writePrefs({ pinnedSessions: next }), changed: true };
}

export default { readPrefs, writePrefs, togglePinned, prunePinned, normalizePrefs, DEFAULT_PREFS, SORT_MODES };

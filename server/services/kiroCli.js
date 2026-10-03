/**
 * Kiro CLI（AWS，`kiro-cli`）接入：屏幕状态判读、本地会话记录、账号与模型、credits 用量。
 *
 * 以下全部是 2026-10-03 在本机 kiro-cli 2.26.0（默认 V2 引擎、默认新 TUI）上实测的，不是照文档写的：
 *   空闲   顶栏「kiro_default · auto · ◔ 4%」（agent · 模型 · 上下文占用），输入框「›  ask a question or describe a task ↵」
 *   运行中 输入框位置换成「›  Kiro is working · 1s · Type to steer · Ctrl+S to queue」，工具行下有「esc to cancel」
 *   确认框 「shell requires approval」+「❯ Yes, single permission / Trust, always allow in this session / No (Tab to edit)」
 *          + 底栏「esc to close · ↑↓ to navigate · ↵ to select · Tab to edit」。**按数字没反应**，光标默认在 Yes，回车即放行一次
 *   一轮结束「▸ Credits: turn 0.07 • session 0.07 | Time: 20s」
 *   不开鼠标上报、不用备用屏；tmux 的 pane_current_command 是 kiro-cli
 *   续接：`kiro-cli chat --resume`（本目录最近一段；目录里没有对话时直接开新的，不报错）
 *   会话记录（V2）：~/.kiro/sessions/cli/<id>.json —— cwd、updated_at、每轮 metering_usage（credits）、model；
 *          token 数字段在 model=auto 时全是 0，所以用量只能按 credits 计
 * 文字发送与 Claude 一样两段式（文本 + 回车）实测可用。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';

export const KIRO_START = 'kiro-cli chat --resume';
const SESSIONS_DIR = () => path.join(os.homedir(), '.kiro', 'sessions', 'cli');

// ── 屏幕状态 ──────────────────────────────────────────────
const IDLE_PROMPT = /›\s+ask a question,? or describe a task/i;
const WORKING = /Kiro is working|Thinking\.\.\.|Initializing(?:\.\.\.| ·)/i;
const CONFIRM_TITLE = /\S+ requires approval/i;
const CONFIRM_YES_POINTER = /^\s*❯\s*Yes, single permission/m;
const CONFIRM_FOOTER = /esc to close · ↑↓ to navigate · ↵ to select/i;
export const KIRO_HEADER = /^\s*\S+ · \S+ · ◔ \d+%/m;     // 「kiro_default · auto · ◔ 4%」

/**
 * 判读 Kiro 当前状态（输入须已剥 ANSI，取屏幕末尾一段）。
 * @returns {{state:'confirm'|'running'|'idle', pointerOnYes?:boolean, contextPct?:number}|null} 认不出返回 null
 */
export function detectKiroState(tail) {
  const t = String(tail || '');
  const ctx = t.match(/ · ◔ (\d+)%/);
  const contextPct = ctx ? Number(ctx[1]) : undefined;
  // 确认框优先：它出现时底下没有输入框，也不显示 working
  if (CONFIRM_TITLE.test(t) && CONFIRM_FOOTER.test(t)) {
    return { state: 'confirm', pointerOnYes: CONFIRM_YES_POINTER.test(t), contextPct };
  }
  if (WORKING.test(t.slice(-600))) return { state: 'running', contextPct };
  if (IDLE_PROMPT.test(t.slice(-600))) return { state: 'idle', contextPct };
  return null;
}

/** 屏幕上像不像 Kiro（用于从屏幕识别正在跑的 CLI） */
const stripAnsi = (t) => String(t || '')
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b[@-Z\\-_]/g, '');
export const looksLikeKiro = (raw) => { const tail = stripAnsi(raw).slice(-2500); return (KIRO_HEADER.test(tail) && (IDLE_PROMPT.test(tail) || WORKING.test(tail)))
  // 确认框弹出时顶栏不在屏上，靠它自己的措辞认（「Yes, single permission」是 Kiro 独有的）
  || (CONFIRM_TITLE.test(tail) && /Yes, single permission/.test(tail)); };

// ── 本地会话记录 ──────────────────────────────────────────
/** 读所有 V2 会话的元数据：[{id, cwd, updatedAt, file}]，新的在前。读坏的跳过 */
export function listKiroSessions(dir = SESSIONS_DIR()) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const file = path.join(dir, f);
    try {
      const m = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (!m?.cwd) continue;
      out.push({ id: m.session_id || f.slice(0, -5), cwd: m.cwd, updatedAt: Date.parse(m.updated_at) || fs.statSync(file).mtimeMs, file, meta: m });
    } catch { /* 写到一半或格式不认识 */ }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

const sameDir = (a, b) => String(a || '').replace(/\/+$/, '') === String(b || '').replace(/\/+$/, '');

/**
 * 某工作目录在某时刻之后的 credits：累计（since 之后结束的轮次）与今天（dayStart 之后）。
 * 每轮的 metering_usage 是一组 {value, unit:'credit'}，求和即这一轮的花费（与屏上「Credits: turn」一致）。
 */
export function kiroCredits(workingDir, { since = 0, dayStart = 0, sessions = listKiroSessions() } = {}) {
  let total = 0, today = 0, model = '';
  for (const s of sessions) {
    if (!sameDir(s.cwd, workingDir)) continue;
    const turns = s.meta?.session_state?.conversation_metadata?.user_turn_metadatas || [];
    for (const t of turns) {
      const end = Date.parse(t.end_timestamp) || 0;
      if (end < since) continue;
      const usd = (t.metering_usage || []).filter((u) => u?.unit === 'credit').reduce((a, u) => a + (Number(u.value) || 0), 0);
      total += usd;
      if (end >= dayStart) today += usd;
    }
    if (!model) model = s.meta?.session_state?.rts_model_state?.model_info?.model_id || '';
  }
  return { credits: total, todayCredits: today, model };
}

// ── 账号 ──────────────────────────────────────────────────
let whoamiCache = { at: 0, value: null };
/** `kiro-cli whoami`：{method:'Google'|…, email} 或 null（没登录 / 没装）。缓存 10 分钟，后台循环里不能每轮起进程 */
export function kiroAccount() {
  if (Date.now() - whoamiCache.at < 600000) return Promise.resolve(whoamiCache.value);
  return new Promise((resolve) => {
    execFile('kiro-cli', ['whoami'], { timeout: 8000, encoding: 'utf-8' }, (err, out) => {
      const method = (String(out || '').match(/Logged in with (.+)/) || [])[1]?.trim();
      const email = (String(out || '').match(/Email:\s*(\S+)/) || [])[1];
      whoamiCache = { at: Date.now(), value: !err && method ? { method, email: email || '' } : null };
      resolve(whoamiCache.value);
    });
  });
}

/** 面板显示用的供应商信息：Kiro 只能用自家账号（后端 Bedrock），不走 CC Switch */
export async function kiroProviderInfo(workingDir) {
  const acct = await kiroAccount();
  const latest = listKiroSessions().find((s) => sameDir(s.cwd, workingDir));
  const model = latest?.meta?.session_state?.rts_model_state?.model_info?.model_id || 'auto';
  return {
    id: 'kiro', name: 'Kiro 官方', url: '', apiKey: '', model, apiType: 'kiro', app: 'kiro',
    exists: !!acct, configSource: 'kiro', oauthEmail: acct?.email || '', loginMethod: acct?.method || '',
  };
}

// ── 历史项目 ──────────────────────────────────────────────
/**
 * 用过 Kiro 的工作目录：[{path, lastUsed}]，新的在前，同一目录取最近一次。三处来源（本机实测都有数据）：
 *   V2（当前默认引擎）~/.kiro/sessions/cli/<id>.json 的 cwd
 *   V3（--v3）       ~/.kiro/sessions/<hash>/sess_<uuid>/session.json 的 workspacePaths
 *   V1（旧引擎）      ~/Library/Application Support/kiro-cli/data.sqlite3 的 conversations_v2.key（就是 cwd）
 * @param {{home?:string, openDb?:(file:string)=>({prepare:Function, close:Function})}} [o] openDb 由调用方传入（better-sqlite3）
 */
export function listKiroProjectDirs({ home = os.homedir(), openDb = null } = {}) {
  const best = new Map();
  const add = (p, t) => { if (p && (!best.has(p) || best.get(p) < t)) best.set(p, t); };
  for (const s of listKiroSessions(path.join(home, '.kiro', 'sessions', 'cli'))) add(s.cwd, s.updatedAt);
  const v3 = path.join(home, '.kiro', 'sessions');
  if (fs.existsSync(v3)) {
    for (const h of fs.readdirSync(v3)) {
      if (h === 'cli') continue;
      const d = path.join(v3, h);
      let entries = [];
      try { entries = fs.readdirSync(d).filter((x) => x.startsWith('sess_')); } catch { continue; }
      for (const e of entries) {
        try {
          const m = JSON.parse(fs.readFileSync(path.join(d, e, 'session.json'), 'utf-8'));
          add((m.workspacePaths || [])[0], Date.parse(m.lastModifiedAt || m.createdAt) || 0);
        } catch { /* 坏的跳过 */ }
      }
    }
  }
  const v1 = path.join(home, 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3');
  if (openDb && fs.existsSync(v1)) {
    let db = null;
    try {
      db = openDb(v1);
      for (const r of db.prepare('SELECT key, MAX(updated_at) t FROM conversations_v2 GROUP BY key').all()) add(r.key, Number(r.t) || 0);
    } catch { /* 表结构变了就不读 */ } finally { try { db?.close(); } catch { /* 忽略 */ } }
  }
  return [...best.entries()].map(([p, t]) => ({ path: p, lastUsed: t })).sort((a, b) => b.lastUsed - a.lastUsed);
}

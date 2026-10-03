/**
 * Cursor CLI（`cursor-agent`）接入：屏幕状态判读、启动命令、历史项目、账号与模型。
 *
 * 以下全部是 2026-10-03 在本机 cursor-agent 2026.10.01-e373342 上实测的，不是照文档写的：
 *   信任目录 「⚠ Workspace Trust Required … ▶ [a] Trust this workspace / [q] Quit」（新目录第一次启动）
 *   空闲     输入行「→ Plan, search, build anything」（新对话）/「→ Add a follow-up」（对话中），占位文字是暗色；
 *            下面是模型行「Auto · 6.9% · 1 file edited」（模型 · 上下文占用 · …）和「~/目录 · 分支」
 *   运行中   「⠠⠜ Working」，输入行右侧「ctrl+c to stop」
 *   确认框   「Run this command? / Not in allowlist: echo / → Run (once) (y) / Add Shell(echo) to allowlist? (tab) /
 *            Run Everything (shift+tab) / Skip & tell the agent what to do instead (esc or n)」。
 *            按 y = 只放行这一次（实测 allowlist 不变）；不能按回车以外的 tab / shift+tab（那是永久放开）
 *   写文件默认不需要确认；不用备用屏、不开鼠标上报；进程是 ~/.local/share/cursor-agent/versions/<v>/ 下的 node
 *   续接：`cursor-agent --continue` 接回本目录最近一段；**目录里没有对话时报「No previous chats found.」直接退出**，
 *         所以启动命令要先看本目录有没有对话
 *   对话记录：~/.cursor/chats/<md5(cwd)>/<chatId>/meta.json —— cwd、hasConversation、updatedAtMs；
 *         store.db 里没有 token / 费用（Cursor 按订阅计费，本地拿不到用量）
 *   账号：`cursor-agent status` →「✓ Logged in as <邮箱>」；模型：~/.cursor/cli-config.json 的 model.displayName
 * ⚠ 命令一律用 cursor-agent：它装的 `agent` 别名在本机被 Grok 占着（~/.local/bin/agent → Grok）。
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';

export const CHATS_DIR = (home = os.homedir()) => path.join(home, '.cursor', 'chats');

// ── 屏幕状态 ──────────────────────────────────────────────
const stripAnsi = (t) => String(t || '')
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b[@-Z\\-_]/g, '');
const lastLines = (t, n) => t.split('\n').filter((l) => l.trim()).slice(-n);
const TRUST = /Workspace Trust Required[\s\S]*\[a\] Trust this workspace/;
const CONFIRM_ONCE = /\(once\) \(y\)/;
const CONFIRM_SKIP = /Skip & tell the agent what to do instead/;
const RUNNING = /ctrl\+c to stop/;
const PLACEHOLDERS = { fresh: 'Plan, search, build anything', followUp: 'Add a follow-up' };
const INPUT_LINE = /^\s*→ (.*)$/;

/** 输入行（「→ …」）及其下方模型行；输入行必须在末尾 4 行内（下面只有模型行与目录行） */
function inputArea(lines) {
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 4); i--) {
    const m = lines[i].match(INPUT_LINE);
    if (m) return { text: m[1].split(/\s{6,}/)[0].trim(), model: (lines[i + 1] || '').trim() };
  }
  return null;
}

/**
 * 判读 Cursor CLI 当前状态（可传带色码的原文，内部先剥）。
 * @returns {{state:'trust'|'confirm'|'running'|'idle', fresh?:boolean, pending?:boolean, contextPct?:number}|null}
 */
export function detectCursorState(raw) {
  const lines = lastLines(stripAnsi(raw), 30);
  const tail = lines.join('\n');
  if (TRUST.test(tail) && !/Trusting workspace/.test(tail) && !inputArea(lines)) return { state: 'trust' };
  // 确认框优先：它出现时没有输入行
  if (CONFIRM_ONCE.test(tail) && CONFIRM_SKIP.test(lines.slice(-8).join('\n'))) return { state: 'confirm' };
  const input = inputArea(lines);
  if (!input) return null;
  const pct = input.model.match(/ · (\d+(?:\.\d+)?)%/);
  const contextPct = pct ? Number(pct[1]) : undefined;
  if (RUNNING.test(lines.slice(-4).join('\n'))) return { state: 'running', contextPct };
  const fresh = input.text === PLACEHOLDERS.fresh;
  const pending = !!input.text && !fresh && input.text !== PLACEHOLDERS.followUp;
  return { state: 'idle', fresh, pending, contextPct };
}

/** 屏幕上像不像 Cursor CLI（用于从屏幕识别正在跑的 CLI） */
export function looksLikeCursor(raw) {
  const lines = lastLines(stripAnsi(raw), 30);
  const tail = lines.join('\n');
  if (TRUST.test(tail) && /Cursor Agent/.test(tail)) return true;
  if (CONFIRM_ONCE.test(tail) && CONFIRM_SKIP.test(tail)) return true;
  const input = inputArea(lines);
  return !!input && (input.text === PLACEHOLDERS.fresh || input.text === PLACEHOLDERS.followUp
    || /^\s*Cursor Agent\s*$/m.test(tail) && /^\s*v20\d\d\.\d\d\.\d\d-/m.test(tail));
}

// ── 对话记录 ──────────────────────────────────────────────
/** 某目录的对话目录：~/.cursor/chats/<md5(cwd)>（实测 md5 的是 cwd 原样字符串） */
export const chatsDirFor = (cwd, home) => path.join(CHATS_DIR(home), crypto.createHash('md5').update(String(cwd || '')).digest('hex'));

/** 读所有对话的 meta.json：[{id, cwd, updatedAt}]，新的在前；没真正说过话的（hasConversation=false）不算 */
export function listCursorChats(home = os.homedir()) {
  const root = CHATS_DIR(home);
  const out = [];
  for (const h of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    let ids = [];
    try { ids = fs.readdirSync(path.join(root, h)); } catch { continue; }
    for (const id of ids) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(root, h, id, 'meta.json'), 'utf8'));
        if (m.cwd && m.hasConversation !== false) out.push({ id, cwd: m.cwd, updatedAt: Number(m.updatedAtMs) || Number(m.createdAtMs) || 0 });
      } catch { /* 读坏的跳过 */ }
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 本目录有没有可续接的对话（cursor-agent --continue 在没有对话时会直接退出） */
export function hasCursorChat(cwd, home) {
  const dir = chatsDirFor(cwd, home);
  if (!fs.existsSync(dir)) return false;
  return listCursorChats(home).some((c) => c.cwd === cwd);
}

/** 启动 / 续接命令：本目录有对话就 --continue，否则开新的 */
export const cursorStartCommand = (cwd, { has = hasCursorChat } = {}) => (cwd && has(cwd) ? 'cursor-agent --continue' : 'cursor-agent');

/** 用过 Cursor CLI 的项目目录：[{path, lastUsed}]，新的在前，同一目录取最近一次 */
export function listCursorProjectDirs(home) {
  const best = new Map();
  for (const c of listCursorChats(home)) if (!best.has(c.cwd)) best.set(c.cwd, c.updatedAt);
  return [...best].map(([p, t]) => ({ path: p, lastUsed: t }));
}

// ── 账号与模型 ────────────────────────────────────────────
let statusCache = { at: 0, value: null };
/** `cursor-agent status`：{email} 或 null（没登录 / 没装）。登录上缓存 10 分钟；没登录只缓存 1 分钟（用户刚登录完要尽快显示） */
export function cursorAccount() {
  const ttl = statusCache.value ? 600000 : 60000;
  if (Date.now() - statusCache.at < ttl) return Promise.resolve(statusCache.value);
  return new Promise((resolve) => {
    execFile('cursor-agent', ['status'], { timeout: 10000, encoding: 'utf-8' }, (err, out) => {
      const email = (stripAnsi(out).match(/Logged in as\s+(\S+)/) || [])[1];
      statusCache = { at: Date.now(), value: !err && email ? { email } : null };
      resolve(statusCache.value);
    });
  });
}

/** 当前模型（cli-config.json 里的显示名，默认 Auto） */
export function cursorModel(home = os.homedir()) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'cli-config.json'), 'utf8'));
    return c.model?.displayName || c.model?.displayModelId || 'Auto';
  } catch { return 'Auto'; }
}

/** 面板显示用：Cursor CLI 只能用 Cursor 自家账号（订阅计费），不走 CC Switch */
export async function cursorProviderInfo() {
  const acct = await cursorAccount();
  return { id: 'cursor', name: 'Cursor 官方', url: '', apiKey: '', model: cursorModel(), apiType: 'cursor', app: 'cursor',
    exists: !!acct, configSource: 'cursor', oauthEmail: acct?.email || '', loginMethod: 'Cursor 账号' };
}

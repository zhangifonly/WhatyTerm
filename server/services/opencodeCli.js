/**
 * OpenCode（`opencode`，sst/anomalyco）接入：会话级供应商配置、屏幕状态判读、历史项目、用量。
 *
 * 以下全部是 2026-10-03 在本机 opencode 1.18.34 上实测的，不是照文档写的：
 *   欢迎屏 大字 logo +「Ask anything… "…"」输入框 +「Build · <模型> <供应商名>」+「tab agents  ctrl+p commands」
 *   对话中 输入框下沿「╹▀▀▀…」，底栏「<目录>  42.1K  ctrl+p commands  • OpenCode 1.18.34」
 *   运行中 底栏换成「⬝⬝⬝⬝  esc interrupt」（注意没有 to）
 *   确认框 「△ Permission required」+「Allow once   Allow always   Reject」+「⇆ select  enter confirm」。
 *          高亮项靠**背景色**区分（纯文本里看不出来），默认在 Allow once；左右键移动，回车确认
 *   用备用屏、开鼠标上报；进程名 opencode（npm 包里的二进制叫 opencode.exe）
 *   续接：`opencode -c` 接回**本目录**最近一段；目录里没有对话时直接开新的
 *   退出：输入 /exit 回车
 *   会话记录：~/.local/share/opencode/opencode.db —— session(directory 是 realpath，/tmp 记成 /private/tmp)、
 *          message.data 里每条 assistant 消息有 modelID、tokens、cost（自定义供应商没有单价时 cost 恒为 0）
 *
 * 供应商：和 Claude 会话一样从 CC Switch 的 claude 类供应商里选。写成会话专属的配置文件
 * （~/.webtmux/sessions/<id>/opencode/opencode.json，0600，不放项目目录），启动时用 OPENCODE_CONFIG 指过去。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

export const OPENCODE_DB = () => path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
/** 写进配置的供应商 id（OpenCode 里显示为「Build · <模型> <供应商名>」） */
export const OC_PROVIDER_ID = 'ccswitch';

// ── 屏幕状态 ──────────────────────────────────────────────
const stripAnsi = (t) => String(t || '')
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b[@-Z\\-_]/g, '');
const CONFIRM_TITLE = /Permission required/;
const CONFIRM_OPTIONS = /Allow once\s+Allow always\s+Reject/;
const RUNNING = /esc interrupt/;
const FOOTER = /ctrl\+p commands/;
const INPUT_BORDER = /╹▀{10,}|Ask anything…/;

/** 末尾 n 个非空行 */
const lastLines = (t, n) => t.split('\n').filter((l) => l.trim()).slice(-n).join('\n');

/**
 * 确认框里高亮的是哪一项（只能从带色码的原文看）：三项里颜色状态与另外两项不同的那个。
 * @returns {'once'|'always'|'reject'|null} 没色码 / 认不出返回 null
 */
export function highlightedPermission(raw) {
  const line = String(raw || '').split('\n').find((l) => /Allow once/.test(stripAnsi(l)) && /Reject/.test(stripAnsi(l)));
  if (!line || !/\x1b\[/.test(line)) return null;
  const labels = { once: 'Allow once', always: 'Allow always', reject: 'Reject' };
  const at = {};
  let fg = '', bg = '';
  // 逐段扫描：遇到 SGR 更新当前前景/背景，遇到文字检查是不是某个选项的开头
  const re = /\x1b\[([0-9;]*)m|([^\x1b]+)/g;
  let m;
  while ((m = re.exec(line))) {
    if (m[1] !== undefined) {
      const ps = m[1] === '' ? ['0'] : m[1].split(';');
      for (let i = 0; i < ps.length; i++) {
        const c = ps[i];
        if (c === '0') { fg = ''; bg = ''; }
        else if (c === '39') fg = '';
        else if (c === '49') bg = '';
        else if (c === '38' || c === '48') {
          const n = ps[i + 1] === '2' ? 4 : ps[i + 1] === '5' ? 2 : 0;   // 38;2;r;g;b 或 38;5;n
          const v = ps.slice(i, i + 1 + n).join(';');
          if (c === '38') fg = v; else bg = v;
          i += n;
        } else if (/^(3[0-7]|9[0-7])$/.test(c)) fg = c;
        else if (/^(4[0-7]|10[0-7])$/.test(c)) bg = c;
      }
      continue;
    }
    for (const [k, label] of Object.entries(labels)) if (at[k] === undefined && m[2].trimStart().startsWith(label)) at[k] = `${fg}|${bg}`;
  }
  const keys = Object.keys(labels);
  if (keys.some((k) => at[k] === undefined)) return null;
  const odd = keys.filter((k) => keys.filter((o) => at[o] === at[k]).length === 1);
  return odd.length === 1 ? odd[0] : null;
}

/**
 * 输入框里有没有没发出去的文字。输入框是「┃」开头的一串行，最后一行是「┃  Build · <模型> …」（agent 行），
 * 下沿「╹▀▀▀」。宽屏时右侧边栏的字和这些行同一行，所以只看「┃」后面、遇到大段空白之前的那一截。
 */
function pendingInput(t) {
  const lines = t.split('\n');
  const border = lines.findLastIndex((l) => /╹▀{10,}/.test(l));
  if (border < 1) return false;
  const agent = border - 1;
  if (!/^\s*┃\s+\S+ · \S/.test(lines[agent])) return false;
  for (let i = agent - 1; i >= 0 && /^\s*┃/.test(lines[i]); i--) {
    const text = lines[i].replace(/^\s*┃/, '').trim().split(/\s{6,}/)[0];
    if (text && !text.startsWith('Ask anything…')) return true;
  }
  return false;
}

/**
 * 判读 OpenCode 当前状态。raw 传带色码的屏幕末尾原文（判高亮要用；没色码时 highlighted 为 null）。
 * @returns {{state:'confirm'|'running'|'idle', highlighted?:string|null, fresh?:boolean}|null} 认不出返回 null
 */
export function detectOpencodeState(raw) {
  const t = stripAnsi(raw);
  const tail = lastLines(t, 25);
  // 确认框优先：它出现时底栏没有 esc interrupt
  if (CONFIRM_TITLE.test(tail) && CONFIRM_OPTIONS.test(tail)) return { state: 'confirm', highlighted: highlightedPermission(raw) };
  const foot = lastLines(t, 3);
  if (!FOOTER.test(foot) && !RUNNING.test(foot)) return null;
  if (RUNNING.test(foot)) return { state: 'running' };
  // fresh：欢迎屏（还没有对话，输入框里是「Ask anything…」占位），没什么可「继续」的；
  // pending：输入框里有人打了字还没发 —— 这时发「继续」会接在人家的字后面一起发出去
  if (INPUT_BORDER.test(lastLines(t, 12))) {
    const pending = pendingInput(t);
    return { state: 'idle', fresh: !pending && /Ask anything…/.test(lastLines(t, 12)), pending };
  }
  return null;
}

/** 屏幕上像不像 OpenCode（用于从屏幕识别正在跑的 CLI） */
export function looksLikeOpencode(raw) {
  const tail = lastLines(stripAnsi(raw), 25);
  if (CONFIRM_TITLE.test(tail) && CONFIRM_OPTIONS.test(tail)) return true;
  const foot = lastLines(tail, 3);
  return FOOTER.test(foot) && (/• OpenCode \d/.test(foot) || /tab agents/.test(foot) || RUNNING.test(foot));
}

// ── 会话级供应商配置 ──────────────────────────────────────
/** 会话专属配置文件（与 index.js applySessionProviderInfo 写入的位置一致） */
export const sessionOpencodeConfig = (sessionId, home = os.homedir()) =>
  path.join(home, '.webtmux', 'sessions', String(sessionId), 'opencode', 'opencode.json');

/** 默认模型的挑选顺序：CC Switch 没写 ANTHROPIC_MODEL 时，从供应商清单里按这个顺序取第一个有的 */
export const MODEL_PREFERENCE = [/^claude-opus-5-5$/, /^claude-opus-5\.5$/, /^claude-sonnet-5-5$/, /^claude-fable-5-1$/,
  /^claude-opus-5$/, /^claude-sonnet-5$/, /^claude-opus-4-8$/, /^claude-sonnet-4-6$/, /^claude-sonnet-4-5/];

/**
 * 由 CC Switch 的 claude 类供应商生成 OpenCode 配置（纯函数）。
 * @param {{name:string, env:object, models?:string[]}} p  env 即 CC Switch 的 ANTHROPIC_* 四键；
 *   models 是供应商 /v1/models 里的模型（拿不到给 []）
 * @returns {{ok:true, config:object, model:string}|{ok:false, error:string}}
 */
export function buildOpencodeConfig({ name, env = {}, models = [] }) {
  const baseUrl = String(env.ANTHROPIC_BASE_URL || '').trim().replace(/\/+$/, '');
  const token = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '';
  if (!baseUrl) return { ok: false, error: 'OpenCode 不能用 Claude 官方登录，请选一个第三方供应商' };
  if (!token) return { ok: false, error: 'CC Switch 里这个供应商没有密钥' };
  // 只列 Claude 系：供应商走 Anthropic 协议（/v1/messages），清单里的 gpt / qwen 用这个协议多半调不通
  const claude = [...new Set(models.filter((m) => /claude/i.test(m)))];
  const want = String(env.ANTHROPIC_MODEL || '').trim();
  const model = want || MODEL_PREFERENCE.map((re) => claude.find((m) => re.test(m))).find(Boolean) || claude[0] || '';
  // 拿不到清单又没指定模型：不编一个名字（编的会撞「无可用渠道」，见 ProviderModels.js 文件头）
  if (!model) return { ok: false, error: '拿不到这个供应商的模型清单，请在 CC Switch 里给它填 ANTHROPIC_MODEL' };
  const list = claude.includes(model) ? claude : [model, ...claude];
  const small = list.find((m) => /haiku/i.test(m)) || model;
  const options = { baseURL: `${baseUrl}/v1`, apiKey: token };
  // CC Switch 里写成 AUTH_TOKEN 的供应商按 Bearer 鉴权（Claude Code 的口径）；@ai-sdk/anthropic 默认只发 x-api-key，两个都带上
  if (env.ANTHROPIC_AUTH_TOKEN) options.headers = { Authorization: `Bearer ${token}` };
  return {
    ok: true, model,
    config: {
      $schema: 'https://opencode.ai/config.json',
      model: `${OC_PROVIDER_ID}/${model}`,
      small_model: `${OC_PROVIDER_ID}/${small}`,
      provider: { [OC_PROVIDER_ID]: { npm: '@ai-sdk/anthropic', name: String(name || 'CC Switch'), options,
        models: Object.fromEntries(list.map((m) => [m, { name: m }])) } },
    },
  };
}

/** 读回会话配置里的供应商名与模型（面板显示用；没有配置返回 null） */
export function readSessionOpencodeConfig(sessionId, home) {
  try {
    const c = JSON.parse(fs.readFileSync(sessionOpencodeConfig(sessionId, home), 'utf8'));
    const p = c.provider?.[OC_PROVIDER_ID] || {};
    return { name: p.name || '', model: String(c.model || '').replace(`${OC_PROVIDER_ID}/`, ''), url: String(p.options?.baseURL || '').replace(/\/v1$/, '') };
  } catch { return null; }
}

/**
 * 启动 / 续接 opencode 的命令。OPENCODE_CONFIG 必须写进命令：tmux set-environment 对窗格里早已在跑的 shell 无效
 * （与 codexStartCommand 同一个坑）。会话没选过供应商（没有配置文件）就跟随 OpenCode 自己的全局配置。
 */
export function opencodeStartCommand(session, { resume = true, exists = fs.existsSync, home } = {}) {
  const id = session?.id && /^[A-Za-z0-9_-]{1,80}$/.test(String(session.id)) ? String(session.id) : '';
  const cfg = id ? sessionOpencodeConfig(id, home) : '';
  const prefix = cfg && exists(cfg) ? `OPENCODE_CONFIG='${cfg.replace(/'/g, "'\\''")}' ` : '';
  return `${prefix}opencode${resume ? ' -c' : ''}`;
}

// ── 本地会话记录 ──────────────────────────────────────────
const defaultOpenDb = (file) => new Database(file, { readonly: true, fileMustExist: true });
/** OpenCode 记的是 realpath（/tmp → /private/tmp），比较前两边都解析一次 */
const real = (p) => { try { return fs.realpathSync(p); } catch { return String(p || ''); } };

/** 只读打开 opencode.db 跑一个查询；库不存在 / 表结构变了返回 fallback */
function withDb(fn, { dbPath = OPENCODE_DB(), openDb = defaultOpenDb, fallback = [] } = {}) {
  if (!fs.existsSync(dbPath)) return fallback;
  let db = null;
  try { db = openDb(dbPath); return fn(db); } catch { return fallback; } finally { try { db?.close(); } catch { /* 忽略 */ } }
}

/** 用过 OpenCode 的项目目录：[{path, lastUsed}]，新的在前（子代理会话、已归档的不算） */
export function listOpencodeProjectDirs(o = {}) {
  return withDb((db) => db.prepare(`SELECT directory, MAX(time_updated) t FROM session
      WHERE parent_id IS NULL AND time_archived IS NULL GROUP BY directory ORDER BY t DESC`).all()
    .map((r) => ({ path: r.directory, lastUsed: Number(r.t) || 0 })), o);
}

/**
 * 某目录里 OpenCode 的花费：只算 since 之后完成的 assistant 消息（续接的老对话，之前花的不算进来）。
 * 消息自带 cost（内置供应商有单价）就用它；是 0 的（自定义供应商没单价）按 priceOf(model) 用 token 算。
 * @param {{since?:number, dayStart?:number, priceOf?:(model:string)=>((usage:object)=>number|null)}} q
 * @returns {{usd:number, todayUsd:number, model:string, incomplete:boolean, unknownModels:string[], byModel:object[]}}
 */
export function opencodeUsage(workingDir, { since = 0, dayStart = 0, priceOf = () => () => null } = {}, o = {}) {
  const dir = real(workingDir);
  const rows = withDb((db) => db.prepare(`SELECT m.data, m.time_created FROM message m JOIN session s ON s.id = m.session_id
      WHERE s.directory = ? AND m.time_created >= ? AND json_extract(m.data, '$.role') = 'assistant'
      ORDER BY m.time_created`).all(dir, since), o);
  const out = { usd: 0, todayUsd: 0, model: '', incomplete: false, unknownModels: [], byModel: [] };
  const by = new Map();
  for (const r of rows) {
    let d; try { d = JSON.parse(r.data); } catch { continue; }
    const t = d.tokens || {};
    const usage = { input: t.input || 0, output: (t.output || 0) + (t.reasoning || 0), cacheRead: t.cache?.read || 0, cacheWrite: t.cache?.write || 0 };
    if (!usage.input && !usage.output) continue;
    const model = String(d.modelID || '');
    let usd = Number(d.cost) || 0;
    if (!usd) {
      const p = priceOf(model)(usage);
      if (p == null) { out.incomplete = true; if (model && !out.unknownModels.includes(model)) out.unknownModels.push(model); }
      else usd = p;
    }
    const isToday = (d.time?.completed || r.time_created) >= dayStart;
    const m = by.get(model) || { model, usd: 0, today: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, today_tokens: 0 };
    m.usd += usd; m.input_tokens += usage.input; m.output_tokens += usage.output;
    m.cache_read_tokens += usage.cacheRead; m.cache_write_tokens += usage.cacheWrite;
    if (isToday) { m.today += usd; m.today_tokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite; out.todayUsd += usd; }
    by.set(model, m);
    out.usd += usd; out.model = model;
  }
  out.byModel = [...by.values()];
  return out;
}

// ── 面板显示 ──────────────────────────────────────────────
/** 选中的 CC Switch 供应商 id 另存一份（OpenCode 校验配置字段，不能往 opencode.json 里塞自定义键） */
export const sessionOpencodeMeta = (sessionId, home) => path.join(path.dirname(sessionOpencodeConfig(sessionId, home)), 'provider.json');

/**
 * 会话当前的 OpenCode 供应商（getCurrentProvider 用）。会话选过供应商就读它自己的配置，否则是 OpenCode 自带的全局配置。
 * @param {{id?:string}|null} session
 */
export function opencodeProviderInfo(session, home = os.homedir()) {
  const cfg = session?.id ? readSessionOpencodeConfig(session.id, home) : null;
  if (cfg) {
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(sessionOpencodeMeta(session.id, home), 'utf8')); } catch { /* 旧配置没有 */ }
    return { id: meta.id || 'opencode-session', name: meta.name || cfg.name, model: cfg.model, url: cfg.url,
      apiType: 'opencode', app: 'opencode', exists: true, configSource: 'local' };
  }
  let model = '';
  try { model = JSON.parse(fs.readFileSync(path.join(home, '.config', 'opencode', 'opencode.json'), 'utf8')).model || ''; } catch { /* 没有全局配置 */ }
  return { id: 'opencode-global', name: 'OpenCode 自带配置', model, url: '', apiType: 'opencode', app: 'opencode',
    exists: true, configSource: 'global' };
}

/**
 * 用会话配置里的地址、密钥、默认模型直接发一个 1 token 的 /v1/messages 请求，确认这套配置 OpenCode 能用。
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function verifyOpencodeConfig(cfgPath, { fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  let c;
  try { c = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) { return { ok: false, error: `读不了配置：${e.message}` }; }
  const p = c.provider?.[OC_PROVIDER_ID];
  const model = String(c.model || '').replace(`${OC_PROVIDER_ID}/`, '');
  if (!p?.options?.baseURL || !model) return { ok: false, error: '配置里没有供应商地址或模型' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${p.options.baseURL}/messages`, {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': p.options.apiKey, ...(p.options.headers || {}) },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ok' }] }),
    });
    if (res.ok) return { ok: true };
    const body = await res.text().catch(() => '');
    const msg = (body.match(/"message"\s*:\s*"([^"]{1,200})"/) || [])[1] || body.slice(0, 200);
    return { ok: false, error: `供应商返回 ${res.status}${msg ? `：${msg}` : ''}` };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? `请求超时（${timeoutMs / 1000} 秒）` : e.message };
  } finally { clearTimeout(timer); }
}

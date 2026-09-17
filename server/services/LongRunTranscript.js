/**
 * 长程编排：会话记录浏览（原版 transcript.py 的移植）
 *
 * 背景：`claude -c` / `-r` 靠 ~/.claude/history.jsonl 索引找会话，而 `claude -p`（编排器用的 SDK 入口）
 * **不往索引里写** —— 实测 132 个沙箱会话文件只有 1 个在索引里。所以编排器跑出来的会话用 -c 一律找不到。
 * 这里绕开索引，直接读 ~/.claude/projects/<转义后的 cwd>/*.jsonl。
 *
 * 与回放的分工：回放看**编排器层**（发了哪段提示词、监督者判了什么），这里看**对话层**
 * （执行者的每一次思考、工具入参、工具返回）。两者互补。
 *
 * 已知差异：JSON 里写成 1.0 的浮点数，JS 解析后丢了类型，在重新序列化的片段（工具入参、system 记录）
 * 里显示为 1。只影响显示，不影响计数与统计。
 */

import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'fs';
import os from 'os';
import path from 'path';
import { realResolve } from './LongRunSandbox.js';

/** 会话记录根目录。环境变量覆盖仅供测试。 */
export const projectsRoot = () => process.env.LONGRUN_CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects');

// 单条正文上限：工具返回动辄几十万字，原样送前端会把浏览器卡死（25 MB 会话里有单条 300KB+ 的 tool_result）
export const BODY_LIMIT = 20000;
export const HEAD_LIMIT = 120;
// 单行摘要取哪个入参，按此顺序。与 runner 的 SALIENT_KEYS 刻意一致：同一工具在两个界面显示同样的摘要
export const SALIENT = ['file_path', 'command', 'path', 'pattern', 'url', 'notebook_path', 'prompt', 'description', 'query'];

// ── Python 行为 ─────────────────────────────────────────────

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const cp = (s) => Array.from(s);                                  // 按码点，与 Python len/切片一致
const cutCp = (s, n) => { const a = cp(s); return a.length > n ? a.slice(0, n).join('') : s; };
const oneLine = (s) => String(s).split(/\s+/).filter(Boolean).join(' ');
const comma = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const str = (v) => (v === null || v === undefined ? 'None' : v === true ? 'True' : v === false ? 'False' : String(v));

/** json.dumps(v, ensure_ascii=False[, indent])：分隔符 ", " 与 ": "；indent 时逐层缩进。 */
export function pyDumps(v, indent = null, level = 0) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : (Number.isNaN(v) ? 'NaN' : (v > 0 ? 'Infinity' : '-Infinity'));
  if (typeof v === 'string') return JSON.stringify(v);
  const items = Array.isArray(v)
    ? v.map((x) => pyDumps(x, indent, level + 1))
    : Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${pyDumps(x, indent, level + 1)}`);
  const [open, close] = Array.isArray(v) ? ['[', ']'] : ['{', '}'];
  if (!items.length) return open + close;
  if (indent == null) return open + items.join(', ') + close;
  const pad = (n) => ' '.repeat(indent * n);
  return `${open}\n${pad(level + 1)}${items.join(`,\n${pad(level + 1)}`)}\n${pad(level)}${close}`;
}

/** int(x or 0)：float 截断、数字串解析。 */
const pyInt = (v) => { const n = Number(v || 0); return Number.isFinite(n) ? Math.trunc(n) : 0; };

// ── 目录定位 ─────────────────────────────────────────────────

/**
 * 工作目录 → projects 下的目录名：非字母数字一律换成 `-`。
 * 中文目录名逐字符换成 `-`，所以**不可逆**，不同中文目录可能撞名 —— 下面按真实 cwd 反查兜底。
 */
export function encodeCwd(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

/** 读出文件里第一条带 cwd 的记录。只扫前 41 行：头几行常是 mode/queue-operation 这类没有 cwd 的记录。 */
export function peekCwd(file) {
  try {
    const fd = openSync(file, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    const lines = buf.subarray(0, n).toString('utf8').split('\n');
    for (let i = 0; i < lines.length && i <= 40; i++) {
      try { const ev = JSON.parse(lines[i]); if (isObj(ev) && ev.cwd) return String(ev.cwd); } catch { /* 跳过 */ }
    }
  } catch { /* 读不了就当没有 */ }
  return '';
}

/** 按工作目录定位 transcript 目录，找不到返回 null。 */
export function findProjectDir(cwd) {
  const root = projectsRoot();
  const exact = path.join(root, encodeCwd(cwd));
  if (existsSync(exact) && statSync(exact).isDirectory()) return exact;
  const norm = (s) => s.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const target = norm(String(cwd));
  let dirs = [];
  try { dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return null; }
  for (const d of dirs) {
    const first = readdirSync(path.join(root, d.name)).find((f) => f.endsWith('.jsonl'));
    if (!first) continue;                                  // 每个目录只探一个文件，够了
    const got = peekCwd(path.join(root, d.name, first));
    if (got && norm(got) === target) return path.join(root, d.name);
  }
  return null;
}

// ── 摘要与解析 ───────────────────────────────────────────────

/** 与 Python 逐行迭代一致：保留行尾换行，空文件是 0 行（split 会给出一个空串） */
const readLines = (file) => readFileSync(file, 'utf8').split(/(?<=\n)/).filter((l) => l !== '');
const tryJson = (line) => { try { return JSON.parse(line); } catch { return undefined; } };
const get = (o, k, d = null) => (isObj(o) && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : d);

/**
 * 一遍扫完取全部摘要（单文件可达 25 MB，扫两遍太慢）。
 * user 计数只算真人/编排器发的话：工具返回也是 user 记录，混进去会虚高一个量级（实测 2404 条里 2235 条是 tool_result）。
 */
export function summarize(file) {
  let firstUser = '', entrypoint = '', cwd = '', branch = '';
  let tFirst = null, tLast = null, nLines = 0, nUser = 0, nAssistant = 0, nTool = 0, cost = 0.0;
  for (const line of readLines(file)) {
    nLines += 1;
    const ev = tryJson(line);
    if (!isObj(ev)) continue;
    const ts = get(ev, 'timestamp');
    if (ts) { tFirst = tFirst || ts; tLast = ts; }
    entrypoint = entrypoint || get(ev, 'entrypoint') || '';
    cwd = cwd || get(ev, 'cwd') || '';
    if (!branch && get(ev, 'gitBranch')) branch = ev.gitBranch;
    const kind = get(ev, 'type');
    const msg = get(ev, 'message') || {};
    const content = get(msg, 'content');
    if (kind === 'user') {
      if (typeof content === 'string') {
        nUser += 1;
        if (!firstUser) firstUser = content;
      } else if (Array.isArray(content)) {
        const texts = content.filter((b) => isObj(b) && get(b, 'type') === 'text').map((b) => get(b, 'text', ''));
        if (texts.length) { nUser += 1; if (!firstUser) firstUser = texts.join('\n'); }
      }
    } else if (kind === 'assistant') {
      nAssistant += 1;
      if (Array.isArray(content)) nTool += content.filter((b) => isObj(b) && get(b, 'type') === 'tool_use').length;
    } else if (kind === 'cost-state') {
      // 实测字段名不固定，能取到就用，取不到不猜
      for (const key of ['totalCostUsd', 'total_cost_usd', 'costUsd']) {
        const v = get(ev, key);
        if (typeof v === 'number' || typeof v === 'boolean') cost = Number(v);
      }
    }
  }
  return {
    id: path.basename(file).replace(/\.[^.]*$/, ''), file, size: statSync(file).size, lines: nLines,
    users: nUser, assistants: nAssistant, tools: nTool, cost, entrypoint, cwd, branch,
    started: tFirst || '', ended: tLast || '', title: cutCp(oneLine(firstUser), 120),
  };
}

/** 列出目录下所有会话的摘要，按修改时间倒序。 */
export function listSessions(pdir) {
  return readdirSync(pdir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(pdir, f))
    .map((f) => [f, statSync(f).mtimeMs]).sort((a, b) => b[1] - a[1]).map(([f]) => summarize(f));
}

export function clip(text, limit = BODY_LIMIT) {
  const t = typeof text === 'string' ? text : pyDumps(text, 2);
  const n = cp(t).length;
  return n <= limit ? t : `${cutCp(t, limit)}\n\n…（共 ${comma(n)} 字，已截断）`;
}

function brief(inp) {
  if (!isObj(inp)) return cutCp(oneLine(str(inp)), HEAD_LIMIT);
  for (const key of SALIENT) {
    const v = get(inp, key);
    if (typeof v === 'string' && v.trim()) return cutCp(oneLine(v), HEAD_LIMIT);
  }
  return cutCp(Object.keys(inp).join(', '), HEAD_LIMIT);
}

/** 工具入参渲染成多行，长值**逐个**截断：整体截断会吃掉最后一个参数，而那常是最关键的（Write 的 content）。 */
function fmtInput(inp) {
  if (!isObj(inp)) return clip(inp);
  return Object.entries(inp).map(([k, v]) => `${k}: ${clip(typeof v === 'string' ? v : pyDumps(v), 4000)}`).join('\n');
}

/** tool_result 的 content 可能是 str，也可能是块列表（含 image）。 */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => {
      if (!isObj(b)) return str(b);
      if (get(b, 'type') === 'text') return str(get(b, 'text', ''));
      if (get(b, 'type') === 'image') return `[图片 ${str(get(get(b, 'source') || {}, 'media_type', '?'))}]`;
      return cutCp(pyDumps(b), 500);
    }).join('\n');
  }
  return pyDumps(content);
}

/**
 * 把一个会话记录解析成可渲染的条目序列。role 与看板同一套命名：injected / say / thinking / tool / toolout / meta
 */
export function parse(file) {
  const entries = [];
  let seq = 0;
  const toolNames = {};
  const stats = { peak_tokens: 0, out_tokens: 0, models: {} };
  const add = (role, label, body, { head = '', at = '', extra = null } = {}) => {
    if (!str(body).trim()) return;                   // 空条目不入列，否则时间轴上一堆空壳
    seq += 1;
    entries.push({ id: seq, role, label, at, head: head || '', body: clip(body), ...(extra || {}) });
  };

  for (const line of readLines(file)) {
    const ev = tryJson(line);
    if (!isObj(ev)) continue;
    const at = get(ev, 'timestamp') || '';
    const kind = get(ev, 'type');
    const msg = get(ev, 'message') || {};
    const content = get(msg, 'content');

    if (kind === 'user') {
      if (typeof content === 'string') add('injected', '发给它', content, { at });
      else if (Array.isArray(content)) {
        for (const b of content) {
          if (!isObj(b)) continue;
          const t = get(b, 'type');
          if (t === 'text') add('injected', '发给它', get(b, 'text', ''), { at });
          else if (t === 'tool_result') {
            const name = toolNames[get(b, 'tool_use_id') || ''] ?? '工具';
            const txt = resultText(get(b, 'content'));
            const err = !!get(b, 'is_error');
            add('toolout', '工具返回', txt, { at, head: `${err ? '✗ 出错' : '✓'} ${name} → ${cutCp(oneLine(txt), 80)}`,
              extra: { is_error: err, tool: name } });
          } else if (t === 'image') add('meta', '图片输入', '[用户提供了一张图片]', { at });
        }
      }
    } else if (kind === 'assistant') {
      const model = get(msg, 'model') || '';
      if (model) stats.models[model] = (stats.models[model] || 0) + 1;
      const usage = get(msg, 'usage') || {};
      // 输入取**峰值**不累加：input_tokens 是当轮上下文占用，每轮都含全部前文，累加虚高一两个数量级
      //（实测 312 轮累加出 4832 万，真实峰值 15 万）。输出每轮各自新生成，才可累加
      const occupied = pyInt(get(usage, 'input_tokens')) + pyInt(get(usage, 'cache_read_input_tokens'))
        + pyInt(get(usage, 'cache_creation_input_tokens'));
      stats.peak_tokens = Math.max(stats.peak_tokens, occupied);
      stats.out_tokens += pyInt(get(usage, 'output_tokens'));
      for (const b of Array.isArray(content) ? content : []) {
        if (!isObj(b)) continue;
        const t = get(b, 'type');
        if (t === 'thinking') {
          const txt = get(b, 'thinking') || get(b, 'text') || '';
          add('thinking', '思考', txt, { at, head: cutCp(oneLine(txt), HEAD_LIMIT) });
        } else if (t === 'text') add('say', '它说', get(b, 'text', ''), { at });
        else if (t === 'tool_use') {
          const name = str(get(b, 'name', ''));
          toolNames[get(b, 'id') || ''] = name;
          add('tool', '调用工具', fmtInput(get(b, 'input')), { at, head: `${name}(${brief(get(b, 'input'))})`, extra: { tool: name } });
        }
      }
    } else if (kind === 'system') {
      const rest = Object.fromEntries(Object.entries(ev).filter(([k]) => !['type', 'timestamp', 'uuid', 'parentUuid', 'sessionId'].includes(k)));
      add('meta', `系统 ${get(ev, 'subtype') || ''}`.trim(), get(ev, 'content') || cutCp(pyDumps(rest), 2000), { at });
    }
  }
  return { summary: { ...summarize(file), ...stats }, entries };
}

// ── 两个接口（原版 /api/sessions、/api/session） ─────────────────

export function apiSessions(dir) {
  const d = String(dir || '').trim();
  if (!d) return { error: '没给目录' };
  const pdir = findProjectDir(d);
  if (!pdir) {
    return { error: `找不到这个工作目录的会话记录。\n\n查过: ${path.join(projectsRoot(), encodeCwd(d))}\n\n`
      + '确认这个目录下真的跑过 claude；另外注意会话是按 cwd 存的，子目录里跑的会话不算在父目录下。' };
  }
  try { return { project_dir: pdir, sessions: listSessions(pdir) }; } catch (e) { return { error: `读取失败: ${e.message}` }; }
}

/** 路径来自客户端，必须校验落在 projects 下 —— 否则这个接口等于"读本机任意文件"。 */
export function apiSession(file) {
  // 与原版 Path.resolve() 一致：跟随符号链接，但文件不存在也能解析（不存在时报"不是可读的文件"而不是"越界"）
  const real = realResolve(path.resolve(String(file || '')));
  const root = realResolve(projectsRoot());
  if (real !== root && !real.startsWith(root + path.sep)) return { error: '路径不在 ~/.claude/projects 下，已拒绝' };
  let isFile = false;
  try { isFile = statSync(real).isFile(); } catch { /* 不存在 */ }
  if (path.extname(real) !== '.jsonl' || !isFile) return { error: `不是可读的 .jsonl 文件: ${real}` };
  try { return parse(real); } catch (e) { return { error: `解析失败: ${e.message}` }; }
}

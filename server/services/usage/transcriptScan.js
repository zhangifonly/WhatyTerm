/**
 * Claude transcript 的增量扫描（纯函数：进 Buffer，出结构，零 I/O）
 *
 * 两条实测约束决定了这里的写法：
 *   · 单行可达数百 KB（tool_result 整块塞在一行里），整行 JSON.parse 会把 CPU 烧在用不到的字段上，
 *     所以先做字节级预筛，命中再用平衡括号截出 `"usage":{…}` 那一小段（约 200 字节）单独解析。
 *   · `cost-state` 是稀疏锚点（21MB 文件里只有 2 条），且**不在文件尾**（活跃会话实测距 EOF 24/29/36 MB），
 *     所以扫描必须是正向游标式的，锚点出现在哪读到哪，不能靠尾部读。
 */

const COST_STATE_MARK = '"type":"cost-state"';
const USAGE_MARK = '"usage":{';

/** 从 start 处的 `{` 开始，按括号配平截出完整对象（忽略字符串里的括号与转义） */
export function sliceBalanced(line, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < line.length; i += 1) {
    const c = line[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) return line.slice(start, i + 1); }
  }
  return '';
}

const MODEL_RE = /"model":"([^"]+)"/;
const MSG_ID_RE = /"id":"(msg_[^"]+)"/;
/** 去重窗口：同一条 assistant 消息会写成多行（正文/思考/工具调用），每行都带同一份 usage。
 *  实测 2100 行里 752 组重复，不去重折算会虚高 53%。重复行都相邻，留 200 条足够。 */
export const SEEN_CAP = 200;

/** 一行 → {model, usage, msgId} 或 null。usage 字段名沿用 Anthropic 的原始命名 */
export function pickUsage(line) {
  const at = line.indexOf(USAGE_MARK);
  if (at < 0) return null;
  const json = sliceBalanced(line, at + USAGE_MARK.length - 1);
  if (!json) return null;
  let u;
  try { u = JSON.parse(json); } catch { return null; }
  return {
    msgId: (line.match(MSG_ID_RE) || [])[1] || '',
    model: (line.match(MODEL_RE) || [])[1] || '',
    usage: {
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
      cacheWrite: u.cache_creation_input_tokens || 0,
    },
  };
}

export function addUsage(into, model, usage) {
  const a = into[model] || (into[model] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  a.input += usage.input; a.output += usage.output; a.cacheRead += usage.cacheRead; a.cacheWrite += usage.cacheWrite;
  return into;
}

/**
 * 扫一段字节。
 * @param {Buffer|string} chunk
 * @param {object} state {remainder: string, byModel: object, anchor: object|null, anchorAt: number}
 * @param {number} baseOffset 这段字节在文件中的起始偏移（用于记锚点位置）
 * @returns {object} 新 state；调用方用 state.remainder 拼下一段
 */
export function scanChunk(chunk, state = {}, baseOffset = 0) {
  const s = {
    remainder: '', byModel: {}, anchor: null, anchorAt: -1, lines: 0, seen: [],
    ...state,
  };
  const seen = new Set(s.seen);
  const remember = (id) => {
    seen.add(id); s.seen.push(id);
    if (s.seen.length > SEEN_CAP) seen.delete(s.seen.shift());
  };
  const text = s.remainder + (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
  let from = 0;
  for (;;) {
    const nl = text.indexOf('\n', from);
    if (nl < 0) break;
    const line = text.slice(from, nl);
    const lineAt = baseOffset - s.remainder.length + from;
    from = nl + 1;
    s.lines += 1;
    if (!line) continue;
    if (line.includes(COST_STATE_MARK)) {
      let ev = null;
      try { ev = JSON.parse(line); } catch { ev = null; }
      if (ev && typeof ev.totalCostUSD === 'number') {
        // 新锚点 = CLI 自己的权威累计值：此前折算出来的增量全部作废，从锚点重新开始，漂移不累积
        s.anchor = ev; s.anchorAt = lineAt; s.byModel = {};
      }
      continue;
    }
    const hit = pickUsage(line);
    if (!hit) continue;
    if (hit.msgId) {
      if (seen.has(hit.msgId)) continue;   // 同一条消息的另一行，usage 是同一份，不能再加
      remember(hit.msgId);
    }
    addUsage(s.byModel, hit.model, hit.usage);
  }
  s.remainder = text.slice(from);
  return s;
}

/**
 * 换 CLI 时，把前一个 CLI 这段对话导出成能读的 Markdown，交给接手的 CLI 按需查（摘要没写到的细节去这里找，不要猜）。
 *
 * 只取原始记录的末尾一段（默认 32MB）：Codex 的 rollout 实测能到 1.15GB（iSpring），整份读会直接报
 * ERR_STRING_TOO_LONG；换人时要的是最近的来龙去脉，更早的部分在文件开头注明省略、给出原始文件位置。
 * 导出时去掉思考过程，长输出截短，命令失败的输出多留一些（报错原文最有用）。
 *
 * 两家的格式（2026-10 实测）：
 *   Claude  ~/.claude/projects/<编码目录>/<对话id>.jsonl：user（字符串或 tool_result 块）、assistant（text / tool_use / thinking 块）
 *   Codex   rollout：event_msg/item_completed 的 item —— UserMessage、AgentMessage、CommandExecution、FileChange、ContextCompaction
 */

import { openSync, readSync, closeSync, statSync, mkdirSync, writeFileSync, chmodSync } from 'fs';
import path from 'path';

export const EXPORT_TAIL_BYTES = 32 * 1024 * 1024;
export const EXPORT_MAX_CHARS = 1_500_000;

/** 文件末尾 bytes 字节，按行切开（第一行可能是半截，丢掉） */
export function readTailLines(file, bytes = EXPORT_TAIL_BYTES) {
  let fd = null;
  try {
    const size = statSync(file).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fd = openSync(file, 'r');
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    return { lines: size > len ? lines.slice(1) : lines, truncated: size > len, size };
  } catch { return { lines: [], truncated: false, size: 0 }; } finally { if (fd != null) try { closeSync(fd); } catch { /* 忽略 */ } }
}

const cut = (s, n) => { const t = String(s ?? '').trim(); return t.length > n ? `${t.slice(0, n)}…（共 ${t.length} 字，已截短）` : t; };
const time = (ts) => (ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '');
const fence = (s) => `\`\`\`\n${String(s).replace(/```/g, '``​`')}\n\`\`\``;

/** Claude 对话记录 → Markdown 片段数组 */
export function claudeEntries(lines) {
  const out = [];
  for (const line of lines) {
    if (!line) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    const c = d.message?.content;
    if (d.type === 'user') {
      if (typeof c === 'string') { if (c.trim()) out.push(`### 用户（${time(d.timestamp)}）\n\n${cut(c, 4000)}`); continue; }
      for (const b of Array.isArray(c) ? c : []) {
        if (b?.type === 'text' && String(b.text).trim()) out.push(`### 用户（${time(d.timestamp)}）\n\n${cut(b.text, 4000)}`);
        else if (b?.type === 'tool_result' && b.is_error) {
          const text = Array.isArray(b.content) ? b.content.map((x) => x?.text || '').join('\n') : b.content;
          out.push(`- ⚠ 工具报错：\n${fence(cut(text, 1500))}`);
        }
      }
    } else if (d.type === 'assistant') {
      for (const b of Array.isArray(c) ? c : []) {
        if (b?.type === 'text' && String(b.text).trim()) out.push(`### Claude（${time(d.timestamp)}）\n\n${cut(b.text, 6000)}`);
        else if (b?.type === 'tool_use') {
          const i = b.input || {};
          const brief = i.command || i.file_path || i.path || i.pattern || i.url || i.description || JSON.stringify(i);
          out.push(`- 工具 ${b.name}：\`${cut(String(brief).replace(/\n/g, ' '), 300)}\``);
        }
      }
    }
  }
  return out;
}

/** Codex rollout → Markdown 片段数组 */
export function codexEntries(lines) {
  const out = [];
  const text = (content) => (Array.isArray(content) ? content.map((x) => x?.text || '').join('') : String(content || ''));
  for (const line of lines) {
    if (!line.includes('"item_completed"')) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    const it = d.payload?.item || {};
    if (it.type === 'UserMessage') { const t = text(it.content); if (t.trim()) out.push(`### 用户（${time(d.timestamp)}）\n\n${cut(t, 4000)}`); }
    else if (it.type === 'AgentMessage') { const t = text(it.content); if (t.trim()) out.push(`### Codex（${time(d.timestamp)}）\n\n${cut(t, 6000)}`); }
    else if (it.type === 'CommandExecution') {
      const cmd = Array.isArray(it.command) ? it.command.at(-1) : it.command;
      const failed = typeof it.exit_code === 'number' && it.exit_code !== 0;
      const body = cut(it.aggregated_output || it.stdout || '', failed ? 1500 : 300);
      out.push(`- 运行命令：\`${cut(String(cmd).replace(/\n/g, ' '), 300)}\`${failed ? `（⚠ 退出码 ${it.exit_code}）` : ''}${body ? `\n${fence(body)}` : ''}`);
    } else if (it.type === 'FileChange') {
      const files = Object.entries(it.changes || {}).map(([p, ch]) => `${ch?.type || 'change'} ${p}`);
      out.push(`- 改文件：${files.join('；')}`);
    } else if (it.type === 'ContextCompaction') out.push('- （这里 Codex 压缩过一次上下文）');
  }
  return out;
}

/**
 * 导出成 Markdown 文件（0600，在 ~/.webtmux 下，不进项目）。
 * @returns {string} 文件路径；原始记录读不到时返回空串
 */
export function exportTranscript({ cli, file, outDir, label }) {
  const { lines, truncated, size } = readTailLines(file);
  if (!lines.length) return '';
  let parts = cli === 'codex' ? codexEntries(lines) : claudeEntries(lines);
  // 太长就丢最早的，保留最近的来龙去脉
  let dropped = false;
  while (parts.join('\n\n').length > EXPORT_MAX_CHARS && parts.length > 1) { parts = parts.slice(Math.ceil(parts.length / 10)); dropped = true; }
  const head = [`# ${label} 的对话记录（换 CLI 时导出）`, '',
    `原始记录：${file}（${(size / 1048576).toFixed(1)} MB）`,
    truncated || dropped ? '⚠ 只导出了最近的一段，更早的部分省略；需要时去原始记录里查。' : '',
    '已去掉思考过程；长输出截短，命令报错多留了一些原文。', '', '---', ''].filter((l, i, a) => l || a[i - 1] !== '').join('\n');
  const outFile = path.join(outDir, `transcript-${cli}-${Date.now()}.md`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outFile, head + parts.join('\n\n') + '\n', { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(outFile, 0o600); } catch { /* 新建时已是 0600 */ }
  return outFile;
}

/**
 * 改写对话记录时 CLI 还在往里追加：不能把新追加的记录覆盖掉。
 *
 * 由来（2026-09-26）：定时改写把「整份读出 → 删 thinking → 整份写回」用在 Claude Code 正在写的对话记录上，
 * 读与写之间 CLI 追加的记录被覆盖，对话链断在那一处。当天被改写过的对话记录里有 134 处断链、58 个 tool_use 丢失，
 * 断点与改写时刻相差 2~41 秒；从没被改写过的对话记录断链数为 0。
 *
 * 运行: node tests/test-session-fixer-race.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

let pass = 0, fail = 0;
const queue = [];
const test = (name, fn) => queue.push([name, fn]);
const assert = (c, m) => { if (!c) throw new Error(m || '断言失败'); };

const m = await import('../server/services/ClaudeSessionFixer.js');
const Fixer = m.ClaudeSessionFixer || m.default.constructor;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-race-'));
const proj = path.join(root, 'projects', '-x');
fs.mkdirSync(proj, { recursive: true });
const fixer = new Fixer(); fixer.claudeDir = path.join(root, 'projects');
const quiet = () => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; return () => { console.log = l; console.warn = w; }; };

/** 一份带 thinking 的对话记录（让改写有事可做），n 行 */
function transcript(n) {
  const rows = []; let prev = null;
  for (let i = 0; i < n; i++) {
    const u = `u-${i}`;
    const content = i % 3 === 1 ? [{ type: 'thinking', thinking: 'x'.repeat(200), signature: 's' }, { type: 'text', text: `回复 ${i}` }] : [{ type: 'text', text: `消息 ${i}` }];
    rows.push(JSON.stringify({ uuid: u, parentUuid: prev, type: i % 2 ? 'assistant' : 'user', message: { role: i % 2 ? 'assistant' : 'user', content } }));
    prev = u;
  }
  return rows.join('\n') + '\n';
}

test('改写期间 CLI 追加了新记录：放弃改写，新记录一条不丢', async () => {
  const f = path.join(proj, 'race.jsonl');
  fs.writeFileSync(f, transcript(20000));
  const appended = [];
  let k = 0;
  const writer = setInterval(() => { const u = `new-${k++}`; appended.push(u); fs.appendFileSync(f, JSON.stringify({ uuid: u, parentUuid: 'u-19999', type: 'user', message: { role: 'user', content: 'x' } }) + '\n'); }, 1);
  const restore = quiet();
  let r; try { r = await fixer.fixSessionFile(f); } finally { clearInterval(writer); restore(); }
  const text = fs.readFileSync(f, 'utf8');
  const lostN = appended.filter((u) => !text.includes(`"uuid":"${u}"`)).length;
  assert(appended.length > 0, '测试没能在改写期间追加（样本太小）');
  assert(lostN === 0, `改写覆盖掉了 CLI 追加的 ${lostN}/${appended.length} 条记录`);
  assert(r.success === false && r.skippedBusy, `文件在变却仍改写了：${JSON.stringify(r).slice(0, 120)}`);
});

test('没人在写时照常改写：thinking 被删、链重连完整、没有残留临时文件', async () => {
  const f = path.join(proj, 'quiet.jsonl');
  fs.writeFileSync(f, transcript(30));
  const restore = quiet();
  let r; try { r = await fixer.fixSessionFile(f); } finally { restore(); }
  assert(r.success && r.removedCount > 0, JSON.stringify(r));
  const rows = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const ids = new Set(rows.map((x) => x.uuid));
  assert(rows.every((x) => !x.parentUuid || ids.has(x.parentUuid)), '改写后对话链断了');
  assert(!fs.readdirSync(proj).some((n) => n.includes('.fixing-')), '留下了临时文件');
});

for (const [name, fn] of queue) {
  try { await fn(); pass++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n    ${e.message}`); }
}
fs.rmSync(root, { recursive: true, force: true });
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);

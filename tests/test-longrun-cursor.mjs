/**
 * 长程 Cursor 执行者（server/services/LongRunCursorRunner.js、longrunExecutor.js）。
 * 事件样本 tests/fixtures/longrun/cursor-stream.jsonl 是 cursor-agent 2026.10.01 实抓（建文件 + 两次 shell）。
 *   ① 实抓事件流：拿到对话 id、工具在飞与收回、shell 记为 bash、最终文字取 result
 *   ② 参数：续接带 --resume，提示词放最后，--force/--trust 必带
 *   ③ 真起子进程（假 cursor-agent 脚本回放样本）：正常完成、退出报错带 stderr、空返回、静默中插话
 *   ④ 提示词改写：Cursor 版没有 Auto Memory / CLAUDE.md 字样，指向 .memory/；Claude 原样
 *   ⑤ 选项：executor 不认识的一律当 claude；Claude 执行者「终止」不再抛错
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildCursorArgs, handleCursorEvent, LongRunCursorRunner } from '../server/services/LongRunCursorRunner.js';
import { promptsFor, normalizeExecutor } from '../server/services/longrunExecutor.js';
import { loadPrompts } from '../server/services/LongRunPrompts.js';
import { ExitReason, LongRunRunner } from '../server/services/LongRunRunner.js';
import { normalizeOptions } from '../server/services/LongRunService.js';

let pass = 0, fail = 0;
const test = async (n, fn) => { try { await fn(); pass++; console.log(`✅ ${n}`); } catch (e) { fail++; console.log(`❌ ${n}\n    ${e.message}`); } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); };
const FIX = new URL('./fixtures/longrun/cursor-stream.jsonl', import.meta.url);
const events = fs.readFileSync(FIX, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const freshState = () => ({ inFlight: {}, toolNames: {}, toolCalls: 0, texts: [], thinking: '', finalText: '', result: null, toolInFlight: null });

await test('① 实抓事件流：对话 id、工具在飞与收回、最终文字', () => {
  const st = freshState(), seen = [];
  let sawBash = false;
  for (const ev of events) {
    handleCursorEvent(ev, st, (k, d) => seen.push([k, d]));
    if (st.toolInFlight === 'bash') sawBash = true;
  }
  eq(st.sessionId, '1a5de21e-b667-415f-9448-59bfb9f48ba4', '对话 id');
  eq([st.toolCalls, st.toolInFlight, Object.keys(st.inFlight).length], [3, null, 0], '三次工具都收回');
  eq(sawBash, true, 'shell 在飞时记为 bash（看门狗按 Bash 档容忍静默）');
  eq(seen.filter(([k]) => k === 'tool').map(([, d]) => d.names[0]), ['edit', 'shell', 'shell'], '工具名');
  eq(seen.filter(([k]) => k === 'tool_result').length, 3, '工具结果');
  eq(/No such file/.test(seen.find(([k, d]) => k === 'tool_result' && d.name === 'shell')[1].text), true, '失败的 shell 输出也拿得到');
  eq(st.finalText.endsWith('done'), true, '最终文字取 result');
});

await test('② 参数：续接带 --resume、提示词放最后', () => {
  eq(buildCursorArgs({ prompt: '做事', sessionId: 'abc', resume: true, model: 'gpt-5.2', extraDirs: ['/r'] }),
    ['-p', '--output-format', 'stream-json', '--force', '--trust', '--resume', 'abc', '--model', 'gpt-5.2', '--add-dir', '/r', '做事'], '续接');
  eq(buildCursorArgs({ prompt: 'x', sessionId: 'abc', resume: false }).includes('--resume'), false, '新对话不带 --resume');
});

// 假 cursor-agent：按环境变量决定行为，回放实抓样本
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-cursor-'));
const BIN = path.join(TMP, 'cursor-agent');
fs.writeFileSync(BIN, `#!/bin/sh
case "$FAKE" in
  ok) cat "${FIX.pathname}" ;;
  err) echo "boom: not logged in" >&2; exit 1 ;;
  empty) echo '{"type":"system","subtype":"init","session_id":"s-empty"}'; echo '{"type":"result","subtype":"success","is_error":false,"result":"","session_id":"s-empty"}' ;;
  hang) echo '{"type":"system","subtype":"init","session_id":"s-hang"}'; sleep 30 ;;
esac
`, { mode: 0o755 });
const runner = (fake, extra = {}) => new LongRunCursorRunner({ cwd: TMP, env: { ...process.env, FAKE: fake }, cursorBin: BIN, watchdogInterval: 0.1, ...extra });

await test('③ 正常完成：COMPLETED、对话 id、token、不记美元', async () => {
  const r = await runner('ok').run('做事');
  eq([r.exitReason, r.sessionId, r.costUsd, r.costEstimate, r.contextPeak], [ExitReason.COMPLETED, '1a5de21e-b667-415f-9448-59bfb9f48ba4', 0, 0, 0], '结果');
  eq(r.usage, { input: 17731, output: 241, cacheRead: 34688, cacheWrite: 0 }, 'token');
});

await test('③ 进程报错退出：ERROR，错误正文取 stderr', async () => {
  const r = await runner('err').run('做事');
  eq([r.exitReason, /not logged in/.test(r.error)], [ExitReason.ERROR, true], '报错');
});

await test('③ 空返回：EMPTY_RESULT', async () => {
  eq((await runner('empty').run('做事')).exitReason, ExitReason.EMPTY_RESULT, '空返回');
});

await test('③ 静默中插话：结束本发、带回插话内容，进程被杀', async () => {
  let given = false;
  const t0 = Date.now();
  const r = await runner('hang', { checkInject: () => (given ? null : (given = true, ['改成先写测试', false])) }).run('做事');
  eq([r.exitReason, r.injectText, r.sessionId], [ExitReason.INTERRUPTED_BY_HUMAN, '改成先写测试', 's-hang'], '插话');
  eq(Date.now() - t0 < 15000, true, '没有等到假进程自己退出');
});

await test('④ 提示词改写：Cursor 版指向 .memory/，不提 Auto Memory / CLAUDE.md；Claude 原样', () => {
  const orig = loadPrompts(path.resolve('server/prompts/longrun/提示词.txt'));
  const c = promptsFor('cursor', orig);
  const all = ['init', 'wrapup', 'resume', 'maintain_1', 'maintain_2'].map((k) => c[k]).join('\n');
  eq(/Auto Memory|自动记忆库|CLAUDE\.md|\.claude\/rules/.test(all), false, '没有 Claude 专有说法');
  eq(/`\.memory\/MEMORY\.md`/.test(c.resume) && !/\.memory\/`?\.memory/.test(all), true, '指向 .memory/MEMORY.md 且不重复替换');
  eq(/停下来/.test(c.init), false, '不会因「记忆库没开启」停下');
  eq(promptsFor('claude', orig), orig, 'Claude 原样');
});

await test('⑤ 选项与「终止」', () => {
  eq([normalizeExecutor('cursor'), normalizeExecutor('x'), normalizeExecutor()], ['cursor', 'claude', 'claude'], 'executor');
  eq([normalizeOptions({ executor: 'cursor' }).executor, normalizeOptions({}).executor], ['cursor', 'claude'], 'normalizeOptions');
  const r = new LongRunRunner({});
  r._proc = { exitCode: null, signalCode: null, pid: 2 ** 30 };
  r.abort();   // 曾因裸标识符 SIGTERM 抛 ReferenceError
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);

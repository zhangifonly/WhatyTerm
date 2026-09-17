/**
 * 长程编排：会话记录浏览（LongRunTranscript）与原版 transcript.py 对拍
 *
 * 1. 合成夹具：覆盖全部解析分支（user 字符串/块列表、tool_result 三种 content、图片、thinking、
 *    tool_use 的字典/非字典入参与超长值、usage 的峰值与累加、system 有无 content、cost-state、坏行、
 *    空正文、码点截断），以及目录定位的精确匹配与按 cwd 反查兜底。
 * 2. 真实数据：本机 WebTmux 项目的全部会话摘要，与原版逐字段比较。
 * 3. 接口：越界路径拒绝、非 jsonl 拒绝、缺目录报错文案。
 *
 * 运行: node tests/test-longrun-transcript.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const FIX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'transcript_fix_')));
const REAL_PROJECTS = path.join(os.homedir(), '.claude', 'projects');
process.env.LONGRUN_CLAUDE_PROJECTS = FIX;
const T = await import('../server/services/LongRunTranscript.js');
const { orchestratorRoot } = await import('../server/services/LongRunSandbox.js');

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
async function test(name, fn) {
  try { await fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}

// ── 夹具 ────────────────────────────────────────────────────
const CWD_A = '/tmp/项目A';
const CWD_B = 'C:\\Work\\中文目录';
const jl = (rows) => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
const ts = (s) => `2026-09-17T10:00:${String(s).padStart(2, '0')}.000Z`;
const big = `${'长'.repeat(19999)}😀尾巴`;
const sessionA = jl([
  { type: 'queue-operation', operation: 'enqueue' },
  { type: 'user', cwd: CWD_A, entrypoint: 'sdk-cli', gitBranch: 'main', timestamp: ts(1), message: { role: 'user', content: `  初始化\n 记忆库   请开始 ${'需'.repeat(150)}` } },
  { type: 'assistant', timestamp: ts(2), message: { model: 'claude-opus-5', usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: '5', output_tokens: 7.9 },
    content: [{ type: 'thinking', thinking: '先想\n一想' }, { type: 'text', text: '我来读文件' },
      { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/x/a.md', limit: 20, opts: { deep: [1, 'b', null, true] } } },
      { type: 'tool_use', id: 'tu2', name: 'Write', input: { content: 'x'.repeat(4100), file_path: '' } },
      { type: 'tool_use', id: 'tu3', name: 'Weird', input: 'not-a-dict' },
      { type: 'tool_use', id: 'tu4', name: 'Empty', input: { a: 1, b: 2 } }, { type: 'text', text: '   ' },
      // 摘要取值顺序（command 写在前、file_path 在后，仍应取 file_path）与 120 字截断
      { type: 'tool_use', id: 'tu5', name: 'Mixed', input: { command: 'ls', file_path: `/很长/${'路'.repeat(150)}` } },
      { type: 'thinking', thinking: `长思考 ${'想'.repeat(200)}` }] } },
  'this is not json',
  { type: 'user', timestamp: ts(3), message: { content: [
    { type: 'tool_result', tool_use_id: 'tu1', content: '文件内容\n第二行' },
    { type: 'tool_result', tool_use_id: 'tu2', is_error: true, content: [{ type: 'text', text: '写失败' }, { type: 'image', source: { media_type: 'image/png' } }, { type: 'other', x: 1 }, 'raw'] },
    { type: 'tool_result', tool_use_id: 'nope', content: { weird: ['obj'] } },
    { type: 'image', source: {} }, { type: 'text', text: '补一句' }, 'not-a-block'] } },
  { type: 'assistant', timestamp: ts(4), message: { model: 'claude-opus-5', usage: { input_tokens: 500 }, content: [{ type: 'thinking', text: '只有 text 字段的思考' }, { type: 'text', text: big }] } },
  { type: 'system', subtype: 'compact_boundary', timestamp: ts(5), content: '上下文已压缩' },
  { type: 'system', subtype: '', timestamp: ts(6), uuid: 'u', parentUuid: 'p', sessionId: 's', level: 'info', data: { k: '中文', n: [1, 2] } },
  { type: 'cost-state', totalCostUsd: 1.25, costUsd: 2.5 },
  { type: 'assistant', timestamp: ts(7), message: { content: 'not-a-list', usage: {} } },
]);
const dirA = path.join(FIX, T.encodeCwd(CWD_A));
const dirB = path.join(FIX, 'weird-name-not-matching');
fs.mkdirSync(dirA, { recursive: true });
fs.mkdirSync(dirB, { recursive: true });
fs.writeFileSync(path.join(dirA, 'aaaa-new.jsonl'), sessionA);
fs.writeFileSync(path.join(dirA, 'bbbb-old.jsonl'), jl([{ type: 'user', message: { content: [{ type: 'text', text: '旧会话' }] }, timestamp: ts(9) }]));
fs.writeFileSync(path.join(dirA, 'empty.jsonl'), '');
fs.utimesSync(path.join(dirA, 'bbbb-old.jsonl'), new Date('2026-01-01'), new Date('2026-01-01'));
fs.utimesSync(path.join(dirA, 'empty.jsonl'), new Date('2025-01-01'), new Date('2025-01-01'));
fs.writeFileSync(path.join(dirB, 'cccc.jsonl'), jl([{ type: 'mode' }, { type: 'queue-operation' }, { type: 'user', cwd: 'C:/Work/中文目录/', message: { content: 'hi' } }]));

// 真实数据：本机这个仓库的会话记录。正在写入的文件（2 分钟内改过）两边读到的行数会不同，排除
const realDir = path.join(REAL_PROJECTS, T.encodeCwd(process.cwd()));
const realFiles = fs.existsSync(realDir) ? fs.readdirSync(realDir).filter((f) => f.endsWith('.jsonl'))
  .map((f) => path.join(realDir, f)).filter((f) => Date.now() - fs.statSync(f).mtimeMs > 120000) : [];

function runPython() {
  const orch = orchestratorRoot();
  if (!fs.existsSync(path.join(orch, 'transcript.py'))) return null;
  const out = path.join(FIX, 'py-out.json');
  const code = `
import sys, json
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(orch)})
import transcript as T
T.PROJECTS = Path(${JSON.stringify(FIX)})
dir_a = Path(${JSON.stringify(dirA)})
res = {
  'findA': str(T.find_project_dir(${JSON.stringify(CWD_A)})),
  'findB': str(T.find_project_dir(${JSON.stringify(CWD_B)})),
  'findNone': str(T.find_project_dir('/没有/这个')),
  'list': T.list_sessions(dir_a),
  'parse': {f.name: T.parse(f) for f in sorted(dir_a.glob('*.jsonl'))},
  'real': [T._summarize(Path(f)) for f in ${JSON.stringify(realFiles)}],
}
json.dump(res, open(${JSON.stringify(out)}, 'w', encoding='utf-8'), ensure_ascii=False)
`;
  const r = spawnSync('python3', ['-c', code], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.error || r.status !== 0) throw new Error(`python 失败: ${r.error?.message || r.stderr}`);
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

function diff(a, b, p = '$') {
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || (a === null) !== (b === null)) {
    return `${p}: node=${JSON.stringify(a)?.slice(0, 200)} py=${JSON.stringify(b)?.slice(0, 200)}`;
  }
  if (a && typeof a === 'object') {
    if (Array.isArray(a) && a.length !== b.length) return `${p}.length: node=${a.length} py=${b.length}`;
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = diff(a[k], b[k], `${p}.${k}`); if (d) return d; }
    return '';
  }
  return a === b ? '' : `${p}: node=${JSON.stringify(a)?.slice(0, 300)} py=${JSON.stringify(b)?.slice(0, 300)}`;
}

const py = runPython();
const skip = () => { console.log('   ⊘ 无原版可对拍'); };

await test('目录定位：精确匹配、按真实 cwd 反查兜底（斜杠/大小写/尾分隔符）、找不到', () => {
  if (!py) return skip();
  assert(T.findProjectDir(CWD_A) === py.findA && py.findA === dirA, `A: node=${T.findProjectDir(CWD_A)} py=${py.findA}`);
  assert(T.findProjectDir(CWD_B) === py.findB && py.findB === dirB, `B: node=${T.findProjectDir(CWD_B)} py=${py.findB}`);
  assert(T.findProjectDir('/没有/这个') === null && py.findNone === 'None');
});

await test('会话列表：按修改时间倒序，摘要逐字段一致（含空文件）', () => {
  if (!py) return skip();
  const d = diff(T.listSessions(dirA), py.list, 'list');
  assert(!d, d);
});

await test('解析：每个会话的条目与统计逐字段一致', () => {
  if (!py) return skip();
  for (const name of Object.keys(py.parse)) {
    const d = diff(T.parse(path.join(dirA, name)), py.parse[name], name);
    assert(!d, d);
  }
  const a = T.parse(path.join(dirA, 'aaaa-new.jsonl'));
  assert(a.entries.some((e) => e.body.includes('已截断')) && a.summary.peak_tokens === 1015, '夹具要真的触发截断与峰值');
});

await test(`真实数据：本机 ${realFiles.length} 个会话记录的摘要与原版一致`, () => {
  if (!py) return skip();
  assert(realFiles.length > 0, '本机没有可比的真实会话记录');
  const d = diff(realFiles.map((f) => T.summarize(f)), py.real, 'real');
  assert(!d, d);
});

await test('接口：越界与伪装路径拒绝、非 jsonl 拒绝、缺目录与空目录报错', () => {
  assert(T.apiSession('/etc/passwd').error.includes('已拒绝'));
  assert(T.apiSession(path.join(FIX, '..', 'escape.jsonl')).error.includes('已拒绝'), '.. 越界');
  fs.writeFileSync(path.join(dirA, 'notes.txt'), 'x');
  assert(T.apiSession(path.join(dirA, 'notes.txt')).error.startsWith('不是可读的 .jsonl 文件'));
  assert(T.apiSession(path.join(dirA, 'missing.jsonl')).error.startsWith('不是可读的 .jsonl 文件'), '不存在的文件不是越界');
  assert(T.apiSession(path.join(dirA, 'aaaa-new.jsonl')).entries.length > 5);
  assert(T.apiSessions('  ').error === '没给目录');
  assert(T.apiSessions('/没有/这个').error.includes('子目录里跑的会话不算在父目录下'));
  assert(T.apiSessions(CWD_A).sessions.length === 3);
});

fs.rmSync(FIX, { recursive: true, force: true });
console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

/**
 * 长程编排：事后回放（原版 view.py）—— 回归测试
 *
 * 看板状态本身已与原版逐条对拍（test-longrun-board）。这里测回放特有的：坏行跳过计数、
 * 三种"回放不出来"的区分文案、回放标记与事件区间耗时、需求全文取自第一条"需求"类 send、
 * 事件文件名限制（远程可访问时不能当任意文件读取口）。
 *
 * 运行: node tests/test-longrun-replay.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'longrun_replay_')));
process.env.LONGRUN_SANDBOX_BASE = BASE;
// 新项目默认建在项目根（真实 ~/Documents/ClaudeCode），测试必须同样指到临时目录
process.env.LONGRUN_PROJECTS_ROOT = process.env.LONGRUN_SANDBOX_BASE;
const { replay, loadEvents } = await import('../server/services/LongRunReplay.js');

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
async function test(name, fn) {
  try { await fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}

function sandbox(name, lines) {
  const run = path.join(BASE, name, '.run');
  fs.mkdirSync(run, { recursive: true });
  if (lines) fs.writeFileSync(path.join(run, 'orchestrator.jsonl'), lines.join('\n') + '\n');
  return run;
}
const ev = (kind, at, data = {}) => JSON.stringify({ ...data, kind, at });

await test('坏行跳过并计数：截断的最后一行、非对象、缺 kind 都算坏行', () => {
  const run = sandbox('bad', [ev('log', 1, { message: 'a' }), '', '[1,2]', '{"at":3}', '"str"', '{"kind":"log","at":4,"mess']);
  const { events, bad } = loadEvents(path.join(run, 'orchestrator.jsonl'));
  assert(events.length === 1 && bad === 4, `events=${events.length} bad=${bad}`);
  const r = replay({ sandboxName: 'bad' });
  assert(r.ok && r.bad === 4 && r.notices[0].includes('跳过 4 行'), JSON.stringify(r.notices));
});

await test('回放标记、耗时取事件区间（不按现在算）、需求取第一条"需求"类 send', () => {
  sandbox('ok', [
    ev('send', 1000, { label: '初始化提示词', text: '初始化', resume: false, leg: 1 }),
    ev('send', 1100, { label: '需求文档', text: '# 做个待办', resume: true, leg: 2 }),
    ev('send', 1200, { label: '新需求文档', text: '别的', resume: true, leg: 3 }),
    ev('finished', 1000 + 45 * 60, { stop: 'project_done', legs: 3, handoffs: 0, maintenances: 0, decisions: 0, elapsed_s: 2700, cost_usd: 1 }),
  ]);
  const r = replay({ sandboxName: 'ok' });
  assert(r.ok && r.snapshot.replay === true && r.snapshot.elapsed_s === 2700, JSON.stringify({ ok: r.ok, e: r.snapshot?.elapsed_s }));
  assert(r.snapshot.requirement === '# 做个待办' && r.count === 4 && r.spanMinutes === 45, r.snapshot.requirement);
  assert(r.snapshot.finished.stop === 'project_done' && r.snapshot.title === '回放 ok' && r.sandboxRoot === path.join(BASE, 'ok'));
});

await test('回放不出来要说清原因：太老（有无 CLI 原始事件）、名字写错、文件为空', () => {
  const run = sandbox('old');
  fs.mkdirSync(path.join(run, 'events'));
  fs.writeFileSync(path.join(run, 'events', 'a.jsonl'), '{}');
  fs.writeFileSync(path.join(run, 'events', 'b.jsonl'), '{}');
  const old = replay({ sandboxName: 'old' });
  assert(!old.ok && old.error.includes('2026-09-08 之前') && old.error.includes('只剩 2 个 CLI 原始事件文件'), old.error);
  const typo = replay({ sandboxName: 'typo' });
  assert(!typo.ok && typo.error.includes('沙箱目录也不存在'), typo.error);
  sandbox('empty', ['', 'garbage']);
  const empty = replay({ sandboxName: 'empty' });
  assert(!empty.ok && empty.error.startsWith('事件文件里没有可回放的事件'), empty.error);
  assert(replay({}).error.includes('要么给项目目录'));
});

await test('直接给文件：只认 orchestrator.jsonl（远程可访问，不能当任意文件读取口）；沙箱名不能越界', () => {
  const r = replay({ file: path.join(BASE, 'ok', '.run', 'orchestrator.jsonl') });
  assert(r.ok && r.sandboxRoot === path.join(BASE, 'ok'), r.error);
  assert(replay({ file: '/etc/passwd' }).error.includes('只能回放'));
  const bad = replay({ sandboxName: '../../etc' });
  assert(!bad.ok && /不合法/.test(bad.error), '名字带路径分隔符应拒绝');
  const byRoot = replay({ projectRoot: path.join(BASE, 'ok') });
  assert(byRoot.ok && byRoot.count === 4, '按项目绝对路径回放');
  const outside = replay({ projectRoot: '/etc' });
  assert(!outside.ok && /白名单/.test(outside.error), '允许的根之外的目录不能回放');
});

fs.rmSync(BASE, { recursive: true, force: true });
console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const x of results.errors) console.log(`  • ${x.name}\n    ${x.error}`);
process.exitCode = results.failed ? 1 : 0;

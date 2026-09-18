/**
 * 长程收尾的成果摘要 —— 回归测试（临时 git 仓库，不碰真实项目）
 *
 * 要害：统计只是给界面看的锦上添花，**绝不能让收尾失败** —— 收尾失败等于这一轮白跑
 * （快照没打、report.json 没落盘）。所以统计整段包在 try 里，失败就不给 outcome。
 *
 * 运行: node tests/test-longrun-outcome.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { LongRunLoop } from '../server/services/LongRunLoop.js';

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function test(name, fn) {
  try { fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lr_outcome_'));
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });

/** 造一个带初始提交的项目，返回一个只借用 collectOutcome 的最小 loop 壳 */
function project(name) {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, '.memory'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a.py'), 'print(1)\n');
  fs.writeFileSync(path.join(root, '.memory', 'MEMORY.md'), '- [进度](p.md)\n');
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@local');
  git(root, 'config', 'user.name', 'test');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  const loop = Object.create(LongRunLoop.prototype);
  loop.spec = { root, runDir: path.join(root, '.run'), memoryDir: path.join(root, '.memory') };
  loop.log = () => {};
  loop.startCommit = git(root, 'rev-parse', '--short', 'HEAD').trim();
  return { root, loop };
}

test('正常收尾：给出快照 commit、改动文件与增删行、记忆条数', () => {
  const { root, loop } = project('ok');
  fs.writeFileSync(path.join(root, 'a.py'), 'print(1)\nprint(2)\n');     // 改 1 行
  fs.writeFileSync(path.join(root, 'b.py'), 'print(3)\n');               // 新增文件
  fs.writeFileSync(path.join(root, '.memory', 'p.md'), '- 做完了 X\n');   // 新增记忆
  const out = loop.collectOutcome('project_done');
  assert(out && out.commit && out.commit.length >= 7, JSON.stringify(out));
  assert(out.fileCount === 3 && out.files.includes('b.py'), JSON.stringify(out));
  assert(out.insertions === 3 && out.deletions === 0, JSON.stringify(out));
  assert(out.memoryCount === 2, `记忆应为 2（MEMORY.md + p.md），实际 ${out.memoryCount}`);
  assert(git(root, 'status', '--porcelain').trim() === '', '收尾必须把工作区都提交进快照，否则成果留在工作区里丢了');
});

test('没有改动时如实给 0，不编造文件', () => {
  const { loop } = project('clean');
  const out = loop.collectOutcome('interrupted');
  assert(out && out.fileCount === 0 && out.files.length === 0, JSON.stringify(out));
});

test('git 出问题时收尾照常完成：返回 null，不抛错', () => {
  const { loop } = project('broken');
  loop._git = () => { throw new Error('git 炸了'); };
  let logged = '';
  loop.log = (m) => { logged += m; };
  const out = loop.collectOutcome('error');
  assert(out === null, `统计失败必须返回 null 而不是抛错：${JSON.stringify(out)}`);
  assert(/成果摘要统计失败/.test(logged), '要在编排日志里留一行，便于排查：' + logged);
});

test('已打过收尾快照后又有改动：照样收进去，不会把最后一段工作丢在工作区', () => {
  const { root, loop } = project('after_snapshot');
  fs.writeFileSync(path.join(root, 'a.py'), 'print(9)\n');
  loop.finishCommit = loop.snapshotCommit('project done');
  fs.writeFileSync(path.join(root, 'c.py'), 'print(10)\n');       // 快照之后又落了一个文件
  const out = loop.collectOutcome('project_done');
  assert(git(root, 'status', '--porcelain').trim() === '', '工作区必须干净：剩下的就是丢了');
  assert(out.files.includes('c.py') && out.commit !== loop.finishCommit, JSON.stringify(out));
  const clean = project('after_snapshot_clean');
  clean.loop.finishCommit = clean.loop.snapshotCommit('project done');
  const n = git(clean.root, 'rev-list', '--count', 'HEAD').trim();
  clean.loop.collectOutcome('project_done');
  assert(git(clean.root, 'rev-list', '--count', 'HEAD').trim() === n, '没有改动时不该多出空提交');
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

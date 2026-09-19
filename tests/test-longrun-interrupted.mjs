/**
 * 「上一轮被中断」的识别。
 *
 * 为什么需要：JobGuard 是有意设计的 —— WebTmux 一死，执行者整组跟着死，
 * 防它无人监管继续改代码（原版实测过编排器被杀后执行者又跑了 30 分钟）。
 * 代价是重启服务/关机/崩溃都会终止长程，而任务只在内存 Map 里，
 * **重启后那条任务在面板上凭空消失，人不知道发生了什么、也不知道可以续跑**。
 *
 * 2026-09-19 用这个判据扫真实项目，当场发现 ERP 那轮跑了 12 发、花了 $141.16
 * 从未正常收工，而此前界面上一直没有任何提示。
 *
 * 判据：session_state.json 有进度（legs>0）却没有 report.json（收工必写）。
 *
 * 运行: node tests/test-longrun-interrupted.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { interruptedRun } from '../server/services/LongRunLaunch.js';

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function test(name, fn) {
  try { fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}

/** 造一个临时项目目录（绝不碰真实的 ~/Documents/ClaudeCode） */
function mk(state, report) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-int-'));
  const dir = path.join(root, '.run');
  fs.mkdirSync(dir, { recursive: true });
  if (state) fs.writeFileSync(path.join(dir, 'session_state.json'), JSON.stringify(state), 'utf8');
  if (report) fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report), 'utf8');
  return root;
}
const cleanup = [];
const tmp = (...a) => { const r = mk(...a); cleanup.push(r); return r; };

test('有进度、没收工报告 → 判为被中断，并给出跑了多少、花了多少', () => {
  const root = tmp({ legs: 12, spent_usd: 141.16, updated_at: 1789738027 });
  const r = interruptedRun(root);
  assert(r?.interrupted === true, '应判为被中断');
  assert(r.legs === 12, `发数错：${r.legs}`);
  assert(Math.abs(r.spentUsd - 141.16) < 0.01, `花费错：${r.spentUsd}`);
  assert(r.at === 1789738027, `时间错：${r.at}`);
});

test('有收工报告 → 正常结束，不许报成中断（否则每个跑完的项目都挂个告警）', () => {
  const root = tmp({ legs: 8, spent_usd: 20 }, { stop: 'project_done', legs: 8 });
  assert(interruptedRun(root) === null, '有报告还判成中断，界面会对所有正常项目误报');
});

test('一发都没跑过 → 没什么可续的，不报', () => {
  assert(interruptedRun(tmp({ legs: 0, spent_usd: 0 })) === null, 'legs=0 不该报');
  assert(interruptedRun(tmp({ spent_usd: 0 })) === null, '没有 legs 字段不该报');
});

test('没有 .run、状态文件损坏、目录不存在 → 一律返回 null，不炸也不猜', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-int-'));
  cleanup.push(empty);
  assert(interruptedRun(empty) === null, '没有 .run 目录');
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-int-'));
  cleanup.push(broken);
  fs.mkdirSync(path.join(broken, '.run'));
  fs.writeFileSync(path.join(broken, '.run', 'session_state.json'), '{坏JSON', 'utf8');
  assert(interruptedRun(broken) === null, '坏 JSON 要吞掉，不能让整个列表接口挂掉');
  assert(interruptedRun('/tmp/definitely-not-here-xyz') === null, '不存在的目录');
  assert(interruptedRun('') === null && interruptedRun(null) === null, '空参数');
});

test('主动切回终端留下的标记 → 不算被中断（否则每次正常往返都挂告警）', () => {
  const root = tmp({ legs: 5, spent_usd: 12.3, updated_at: 1789800000 });
  assert(interruptedRun(root)?.interrupted === true, '前提：没标记时应判为中断');
  fs.writeFileSync(path.join(root, '.run', 'switched.json'),
    JSON.stringify({ at: 1789800001, mode: 'resume' }), 'utf8');
  assert(interruptedRun(root) === null, '有切出标记还报中断 —— 正常往返会被误报');
});

test('标记文件名由 SWITCHED_FILE 导出，写入方与判定方用同一个常量', async () => {
  const { SWITCHED_FILE } = await import('../server/services/LongRunLaunch.js');
  assert(SWITCHED_FILE === 'switched.json', `常量变了：${SWITCHED_FILE}`);
  const svc = fs.readFileSync(new URL('../server/services/LongRunService.js', import.meta.url), 'utf8');
  assert(/SWITCHED_FILE/.test(svc), '写入方硬编码了文件名 —— 两边会漂移');
});

// ── 接线守卫 ──────────────────────────────────────────────────────
const SVC = fs.readFileSync(new URL('../server/services/LongRunService.js', import.meta.url), 'utf8');
const UI = fs.readFileSync(new URL('../src/components/longrun/LongRunNewTask.jsx', import.meta.url), 'utf8');

test('守卫：项目列表与项目现状两个接口都要带这个字段', () => {
  const hits = SVC.split('interruptedRun(root)').length - 1;
  assert(hits >= 3, `只接了 ${hits} 处 —— 列表(1)与 projectState 的两条返回路径(2)都要带，否则某些入口看不到提示`);
});

test('守卫：切出时写标记、切回时清标记（漏一边就会误报或漏报）', () => {
  const IDX = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  assert(/markSwitchedOut\(/.test(IDX), '转终端路径没写标记 —— 正常往返会被误报成被中断');
  // 只查**调用点**：方法定义本身也含这个名字，光匹配名字删掉调用也照样通过
  assert(/this\.clearSwitchedOut\(/.test(SVC), '重新开跑没清标记 —— 之后真被中断也不会报');
});

test('守卫：界面要说清「记忆还在、续跑能接上」，不能只报警不给出路', () => {
  assert(/interrupted\?\.interrupted/.test(UI), '界面没读这个字段');
  assert(/没有正常收工/.test(UI), '没说清发生了什么');
  assert(/续跑能接上|记忆与 git 快照/.test(UI), '只报警不告诉人怎么办，等于制造焦虑');
});

for (const d of cleanup) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ } }

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

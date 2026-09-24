/**
 * 手机上看、答、管长程。
 *
 * 由来（2026-09-24 审查）：移动版完全不认长程。长程本来就是你不在电脑前时跑的，
 * 它停下来等你回答时，手机是你唯一的入口，而手机上看不到也答不了。
 *
 * 界面行为靠预览桩验过；这里钉住不能退化的几条接线。
 *
 * 运行: node tests/test-mobile-longrun.mjs
 */

import fs from 'fs';

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function test(name, fn) {
  try { fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const DETAIL = read('../src/mobile/SessionDetail.jsx');
const CARD = read('../src/mobile/LongRunMobile.jsx');
const ACTS = read('../src/mobile/LongRunMobileActions.jsx');
const HOOK = read('../src/mobile/useLongRunBrief.js');
const SESS = read('../src/mobile/useSessions.js');
const LIST = read('../src/mobile/SessionList.jsx');
const SCARD = read('../src/mobile/SessionCard.jsx');
const APP = read('../src/mobile/MobileApp.jsx');

test('详情页：长程条目走长程卡片，且不附着终端（tmux 里只有空 shell，附着只会白拉快照）', () => {
  assert(/if \(isLongRun\)[\s\S]{0,300}<LongRunMobile/.test(DETAIL), '长程条目没走长程卡片');
  assert(/useScreen\(isLongRun \? null : session\?\.id\)/.test(DETAIL), '长程条目还在附着终端');
  assert(/longRunTasks=\{sessionsData\.longRunTasks\}/.test(APP), 'MobileApp 没把长程任务传进详情页');
});

test('问题卡：在等你时显示问题原文，回答走 longrun:answer 并带 taskId', () => {
  assert(/b\.needHuman && \(/.test(CARD), '没有问题卡');
  assert(/b\.needHuman\.question/.test(CARD), '问题原文没显示 —— 只看到"在等你"却不知道等什么');
  assert(/socket\.emit\('longrun:answer', \{ taskId: task\.id, text \}/.test(CARD), '回答没走 longrun:answer');
});

test('危险操作要点两次：不回答停机、停下当前这发、终止（手机误触代价是整轮停掉）', () => {
  assert(/<ConfirmButton label="不回答，停机"[\s\S]{0,200}onConfirm=\{\(\) => send\(''\)\}/.test(CARD),
    '「不回答，停机」没走两次确认');
  assert(/<ConfirmButton label="终止"[\s\S]{0,200}longrun:terminate/.test(ACTS), '「终止」没走两次确认');
  assert(/<ConfirmButton label="停下当前这发"[\s\S]{0,200}longrun:stop/.test(ACTS), '「停下当前这发」没走两次确认');
  // 暂停/继续可逆，一次点击即可 —— 不要把所有按钮都做成两次确认，那会让人习惯性连点。
  // 看「触发 longrun:pause 的那个元素」本身，而不是搜"暂停"二字：
  // 「停下当前这发」的确认文案是"打断并暂停"，按文字搜会误报（写这条时就误报过一次）
  const at = ACTS.indexOf("'longrun:pause'");
  assert(at > 0, '没有暂停操作');
  const before = ACTS.slice(0, at);
  const tagStart = Math.max(before.lastIndexOf('<button'), before.lastIndexOf('<ConfirmButton'));
  assert(ACTS.startsWith('<button', tagStart), '暂停被做成了两次确认');
});

test('两次确认不用 window.confirm（主屏幕打开的网页里可能被系统拦掉，变成"点了没反应"）', () => {
  // 先剥注释：解释"为什么不用 window.confirm"的注释本身就含这个词（写这条时就误报过一次）
  const code = (ACTS + CARD).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  assert(!/window\.confirm|\bconfirm\(/.test(code), '用了原生确认框');
  assert(/ARM_MS/.test(ACTS) && /setTimeout\(\(\) => setArmed\(false\), ARM_MS\)/.test(ACTS), '待确认态没有超时复位');
});

test('快照 hook：等人状态翻转时不被节流吞掉（那是最要紧的变化）', () => {
  assert(/flipped \|\| wait <= 0\) fetchNow\(\)/.test(HOOK), '等人翻转没有立即拉取');
  assert(/timer\.current = setTimeout\(fetchNow, wait\)/.test(HOOK), '节流期内没补拉，会丢最后一次变化');
  assert(/longrun:brief/.test(HOOK) && !/longrun:subscribe/.test(HOOK), '不该订阅看板房间（几百 KB）');
});

test('列表：收长程任务摘要，长程等你算需操作，卡片不再显示「等待分析」', () => {
  assert(/socket\.on\('longrun:task'/.test(SESS), '没收长程任务广播');
  assert(/socket\.emit\('longrun:status'/.test(SESS), '首屏没拉长程任务');
  assert(/needsActionIds\(sessions, aiStatusMap, longRunTasks\)/.test(LIST), '排序没算上长程等你');
  assert(/isLongRun \? longRunText\(lrTask\)/.test(SCARD), '长程条目仍在显示 AI 监控状态（永远是「等待分析」）');
});

test('收工结论复用共享的 longrunAdvice（与电脑上同一套说法）', () => {
  assert(/from '\.\.\/components\/longrun\/longrunAdvice\.js'/.test(CARD), '手机自己另写了一套结论文案');
});

test('新文件都不超过 100 行（项目规矩）', () => {
  for (const f of ['LongRunMobile.jsx', 'LongRunMobileActions.jsx', 'useLongRunBrief.js']) {
    const n = read(`../src/mobile/${f}`).split('\n').length;
    assert(n <= 101, `${f} 有 ${n} 行`);
  }
});

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

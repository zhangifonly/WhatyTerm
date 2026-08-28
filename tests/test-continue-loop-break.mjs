/**
 * 「机械继续」熔断后的交接 —— 回归测试
 *
 * 症状：面板显示「需要操作 / 建议操作：继续 / 后台自动操作已开启，将自动执行」，
 * 自动模式也是开的，但「最近操作：无」—— 一个字都没发出去，而且永远不会发。
 *
 * 真因是两个机制互相卡死：
 *   1. 自动操作循环发现连续 4 次「继续」都没推动屏幕 → 熔断，把 preResult 置空，
 *      日志写「交给AI判断」
 *   2. 后台 AI 分析循环有一条短路：「内容无变化 + 有缓存结果 → 跳过分析」
 *
 * 而熔断恰恰是"屏幕一直没变"才触发的 —— 两个条件同时成立，AI 永远不会真的分析。
 * 机械继续停了、AI 也没接手，会话就此挂死；更糟的是 AI 循环跳过时会把**旧状态**
 * 原样重播，面板一直显示"将自动执行"，而实际上什么都不会发生。
 *
 * 本测试锁住熔断分支必须做的两件事：作废内容哈希、把状态改成实情。
 *
 * 运行：node tests/test-continue-loop-break.mjs
 */

import fs from 'fs';
import path from 'path';

const results = { passed: 0, failed: 0, errors: [] };

function test(name, fn) {
  try {
    fn();
    results.passed++;
    console.log(`✅ ${name}`);
  } catch (err) {
    results.failed++;
    results.errors.push({ name, error: err.message });
    console.log(`❌ ${name}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }

const SRC = fs.readFileSync(path.join(process.cwd(), 'server/index.js'), 'utf8');

/** 取「循环检测」熔断分支的代码块 */
function loopBreakBlock() {
  const i = SRC.indexOf('停止机械继续，交给AI判断');
  assert(i > 0, '未找到循环检测熔断分支');
  return SRC.slice(i, i + 2000);
}

/** 取后台 AI 分析里「内容无变化」短路的代码块 */
function aiSkipBlock() {
  const i = SRC.indexOf('内容无变化，跳过分析');
  assert(i > 0, '未找到 AI 分析跳过分支');
  return SRC.slice(Math.max(0, i - 600), i + 600);
}

test('熔断时作废内容哈希 —— 否则"交给 AI"根本交不出去', () => {
  const block = loopBreakBlock();
  assert(/aiContentHashCache\.delete\(/.test(block),
    '未作废内容哈希：AI 循环的「内容无变化就跳过」会让这次交接落空，会话挂死');
});

test('熔断时把缓存状态改成实情，不再声称"将自动执行"', () => {
  const block = loopBreakBlock();
  assert(/aiStatusCache\.set\(/.test(block),
    '未更新缓存状态：AI 循环跳过时会原样重播旧状态，面板继续显示"将自动执行"');
  assert(/needsAction:\s*false/.test(block), '熔断后仍标 needsAction:true，界面会误导');
  assert(/suggestedAction:\s*null/.test(block),
    '熔断后仍留着「继续」作为建议操作，用户手点就会发出去');
});

test('熔断状态会推给前端（只写缓存不广播的话，面板要等下一轮才更新）', () => {
  const block = loopBreakBlock();
  assert(/emit\('ai:status'/.test(block), '未广播熔断后的状态');
});

test('熔断状态带来源标记，便于排查', () => {
  assert(/_source: 'continue_loop_break'/.test(loopBreakBlock()), '缺少 _source 标记');
});

test('AI 跳过短路的两个条件都还在（这是熔断必须作废哈希的前提）', () => {
  const block = aiSkipBlock();
  assert(/lastHash === contentHash && cachedStatus/.test(block),
    '跳过条件变了，请重新核对熔断分支的作废逻辑是否仍然必要');
});

test('AI 跳过时重播缓存 —— 所以缓存内容必须是可信的', () => {
  const block = aiSkipBlock();
  assert(/emit\('ai:status'/.test(block) && /\.\.\.cachedStatus/.test(block),
    '重播逻辑变了，请重新核对熔断分支写入的状态是否仍会被正确展示');
});

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exit(results.failed ? 1 : 0);

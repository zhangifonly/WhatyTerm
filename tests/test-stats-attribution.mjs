/**
 * 判定统计归因 —— 回归测试
 *
 * 症状：面板显示「成功 37736 / 失败 340」与「程序判断 37736 / AI 判断 340」，
 * 两组数一模一样，读起来就是"AI 判断全错"。
 *
 * 根因是归因写死了：updateAiHealthState 的第三个参数原本是布尔 isPreAnalyzed，
 * 只有"规则/非规则"两档。于是监控循环里**任何**异常（抓屏失败、tmux 出错、插件 bug）
 * 都被归到"AI 判断"名下，且必然 success=false —— 两个维度被绑死成了同一个数。
 *
 * 本测试锁住：来源分四档、循环异常不算 AI、失败与来源相互独立。
 *
 * 运行：node tests/test-stats-attribution.mjs
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
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || '不相等'}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}

const SRC = fs.readFileSync(path.join(process.cwd(), 'server/index.js'), 'utf8');
const SM = fs.readFileSync(path.join(process.cwd(), 'server/services/SessionManager.js'), 'utf8');

// ============ 归因：来源必须分档，且与成败正交 ============

test('updateAiHealthState 按来源分四档，不再是"规则/非规则"二选一', () => {
  for (const src of ["'rule'", "'hook'", "'error'"]) {
    assert(SRC.includes(`src === ${src}`), `缺少来源分档 ${src}`);
  }
  assert(/aiOperationStats\.loopErrors\+\+/.test(SRC), '缺少 loopErrors 计数');
  assert(/aiOperationStats\.hookFallback\+\+/.test(SRC), '缺少 hookFallback 计数');
});

test('监控循环异常归为 error，不再算到「AI 判断」头上', () => {
  const calls = [...SRC.matchAll(/updateAiHealthState\(false,\s*err,\s*([^,]+),/g)].map(m => m[1].trim());
  assert(calls.length >= 2, `未找到错误路径的调用，实际 ${calls.length} 处`);
  for (const c of calls) {
    eq(c, "'error'", `错误路径的来源应为 'error'，实际 ${c}`);
  }
});

test('AI 判定失败单独计数（面板才能把「AI 判断」和「失败」分开显示）', () => {
  assert(/aiFailed:\s*0/.test(SRC), '统计对象缺少 aiFailed');
  assert(/if \(!success\) aiOperationStats\.aiFailed\+\+/.test(SRC),
    'AI 失败未单独累加');
});

test('AI 分析返回 null 不算成功（什么都没判出来）', () => {
  assert(/updateAiHealthState\(!!status,/.test(SRC),
    'status 为 null 时仍被记成功，会虚高成功率');
});

test('Hook 兜底单独归档，不混进「规则判断」充业绩', () => {
  assert(/updateAiHealthState\(true,\s*null,\s*'hook'/.test(SRC),
    'Hook 兜底未单独归档 —— 它既不读屏也不操作');
});

test('规则层预判断记 rule', () => {
  assert(/updateAiHealthState\(true,\s*null,\s*'rule'/.test(SRC), '规则层未记为 rule');
});

test('兼容旧的布尔传参（true=规则，false=AI）', () => {
  assert(/typeof source === 'boolean' \? \(source \? 'rule' : 'ai'\)/.test(SRC),
    '去掉了布尔兼容，历史调用方会静默错档');
});

// ============ 持久化：新增字段要真能存下来 ============

test('会话表补齐 stats_ai_failed / stats_hook_fallback 两列', () => {
  assert(/ADD COLUMN stats_ai_failed INTEGER/.test(SM), '缺少 stats_ai_failed 列');
  assert(/ADD COLUMN stats_hook_fallback INTEGER/.test(SM), '缺少 stats_hook_fallback 列');
});

test('INSERT 语句的列数与占位符数一致（漏改必然写错列）', () => {
  const m = SM.match(/INSERT OR REPLACE INTO sessions\s*\n\s*\(([^)]*)\)\s*\n\s*VALUES \(([^)]*)\)/);
  assert(m, '未找到 INSERT 语句');
  const cols = m[1].split(',').length;
  const holders = m[2].split(',').length;
  eq(holders, cols, `列数与占位符数不一致（列 ${cols} / 占位 ${holders}）`);
  assert(m[1].includes('stats_ai_failed'), '新列未写入 INSERT');
});

test('读库时映射新字段', () => {
  const n = (SM.match(/aiFailed: row\.stats_ai_failed/g) || []).length;
  assert(n >= 2, `读库映射应覆盖全部恢复路径，实际 ${n} 处`);
});

// ============ 面板口径 ============

test('面板不再把判定轮次叫作「操作次数」', () => {
  const zh = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'src/i18n/locales/zh-CN.json'), 'utf8'));
  assert(!/操作次数/.test(zh.stats.totalOps),
    `自动模式关着时一次操作都没发，却显示几万次"操作"：${zh.stats.totalOps}`);
  assert(zh.stats.statsNote && /判定轮次/.test(zh.stats.statsNote), '缺少口径说明');
});

test('三种语言的新文案齐全（缺键会渲染成裸 key）', () => {
  for (const f of ['zh-CN.json', 'en.json', 'ja.json']) {
    const d = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'src/i18n/locales', f), 'utf8'));
    for (const k of ['totalOps', 'aiDecision', 'programDecision', 'hookFallback', 'aiFailedSuffix', 'statsNote']) {
      assert(d.stats[k], `${f} 缺少 stats.${k}`);
    }
  }
});

test('v1.2.92 上游限流不算判定出错（当本轮跳过）', () => {
  assert(/function isUpstreamThrottle/.test(SRC), '缺少 isUpstreamThrottle 分类器');
  assert(/all available accounts/.test(SRC), '应识别 crs 网关的账号池限流文案');
  assert(/429|502|503/.test(SRC), '应识别 429/502/503');
  // 限流分支必须在 updateAiHealthState('error') 之前 continue 掉
  const gate = SRC.indexOf('isUpstreamThrottle(err)');
  const errAcct = SRC.lastIndexOf("updateAiHealthState(false, err, 'error'");
  assert(gate > 0 && errAcct > 0 && gate < errAcct, '限流拦截必须早于本循环的 error 记账');
  assert(SRC.slice(gate, errAcct).includes('continue'), '限流分支必须 continue 掉，不落到 error 记账');
});

test('v1.2.92 hook 在跑时跳过 API 判状态（省 API、避开限流）', () => {
  assert(/hookState === 'working' && hookAge < 8000 && !hasConfirmMenuOnScreen/.test(SRC),
    'AI 分析循环应在 hook 明确在跑且无确认菜单时短路');
  assert(/updateAiHealthState\(true, null, 'hook'/.test(SRC), 'hook 短路应记为 hook 来源');
});

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exit(results.failed ? 1 : 0);

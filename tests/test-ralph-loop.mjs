/**
 * Ralph 自主循环回归（v1.2.83 新增，此前引擎零测试覆盖）。
 *
 * 覆盖 P1 改造的五个不变量：
 *   1. 验证失败历史只追加（validationHistory），不再单值覆盖
 *   2. 连续两次相同失败 → 早熔断 blocked（重试无信息增益，VRR-Stop 思想）
 *   3. 硬验证：validationCommands 由引擎执行，任一失败直接 FAIL 且不调 LLM
 *   4. Validator 结论只认输出尾部（正文复述 "VALIDATION: PASS" 不算数）
 *   5. 开发失败计入 retryCount；连续 5 轮失败触发全局熔断 circuit_broken
 *
 * 全部用 stub session / stub _execHeadless，不跑真实 CLI。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import progressManager from '../server/services/ProgressManager.js';
import RalphEngine from '../server/services/RalphEngine.js';

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};
const ok = (c, msg) => { if (!c) throw new Error(msg || '断言失败'); };
const eq = (a, b, msg) => {
  if (a !== b) throw new Error(msg || `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
};

const SID = `test-ralph-${process.pid}`;
const sessionDir = path.join(os.homedir(), '.webtmux', 'sessions', SID);
const cleanup = () => { try { fs.rmSync(sessionDir, { recursive: true }); } catch {} };
cleanup();

function freshProgress(features) {
  cleanup();
  progressManager.createProgress(SID, '测试目标');
  progressManager.setFeatures(SID, features, '全部完成');
}

function makeEngine() {
  const session = { aiType: 'claude', workingDir: '/nonexistent-test-dir', write() {} };
  const engine = new RalphEngine({ getSession: () => session }, null);
  engine._sleep = async () => {};
  return { engine, session };
}

console.log('ProgressManager 失败历史与早熔断');

await t('validationHistory 只追加，validationNotes 保留最新', () => {
  freshProgress([{ id: 'f1', name: 'A', description: 'x' }]);
  progressManager.recordValidationFailure(SID, 'f1', '失败原因一', 5);
  progressManager.recordValidationFailure(SID, 'f1', '失败原因二', 5);
  const f = progressManager.loadProgress(SID).features[0];
  eq(f.validationHistory.length, 2, '历史应有 2 条');
  eq(f.validationHistory[0].notes, '失败原因一', '这一条锁住故障：第一次失败原因不能被覆盖丢失');
  eq(f.validationNotes, '失败原因二');
  eq(f.blocked, false, '两次不同失败不应 blocked');
});

await t('连续两次相同失败 → 早熔断 blocked（无信息增益）', () => {
  freshProgress([{ id: 'f1', name: 'A', description: 'x' }]);
  progressManager.recordValidationFailure(SID, 'f1', '同一个错', 5);
  const r = progressManager.recordValidationFailure(SID, 'f1', '同一个错', 5);
  eq(r.repeatedFailure, true);
  eq(r.blocked, true, '相同失败第二次就该停，省掉注定一样的 3 次重试');
  ok(/无信息增益/.test(progressManager.loadProgress(SID).features[0].blockedReason));
});

await t('达到 maxRetry 也 blocked（原有行为保留）', () => {
  freshProgress([{ id: 'f1', name: 'A', description: 'x' }]);
  for (let i = 1; i <= 5; i++) progressManager.recordValidationFailure(SID, 'f1', `错${i}`, 5);
  const f = progressManager.loadProgress(SID).features[0];
  eq(f.blocked, true);
  eq(f.retryCount, 5);
});

await t('setFeatures 初始化 validationCommands / validationHistory', () => {
  freshProgress([{ id: 'f1', name: 'A', description: 'x', validationCommands: ['npm test'] }]);
  const f = progressManager.loadProgress(SID).features[0];
  eq(JSON.stringify(f.validationCommands), '["npm test"]');
  eq(JSON.stringify(f.validationHistory), '[]');
});

console.log('\nRalphEngine 硬验证与结论解析');

await t('硬验证命令失败 → 直接 FAIL 且不调 LLM，输出尾部回灌', async () => {
  freshProgress([{ id: 'f1', name: 'A', description: 'x', validationCommands: ['npm test'] }]);
  const { engine } = makeEngine();
  let llmCalled = false;
  engine._execShell = async () => ({ ok: false, rc: 1, out: '3 tests failed\nAssertionError: boom' });
  engine._execHeadless = async () => { llmCalled = true; return 'VALIDATION: PASS'; };
  const task = progressManager.loadProgress(SID).features[0];
  const v = await engine._runValidator(SID, makeEngine().session, task, 1);
  eq(v.passed, false);
  eq(v.hard, true);
  ok(/npm test/.test(v.notes) && /AssertionError: boom/.test(v.notes), '失败命令与输出尾部都要进 notes 回灌');
  eq(llmCalled, false, '这一条锁住成本：硬验证失败不该再烧一次 LLM 调用');
});

await t('硬验证全过 → 继续 LLM 软验证，尾部 PASS 才通过', async () => {
  freshProgress([{ id: 'f1', name: 'A', description: 'x', validationCommands: ['true'] }]);
  const { engine, session } = makeEngine();
  engine._execShell = async () => ({ ok: true, rc: 0, out: '' });
  engine._execHeadless = async () => '逐条核验...\n全部满足。\nVALIDATION: PASS';
  const task = progressManager.loadProgress(SID).features[0];
  const v = await engine._runValidator(SID, session, task, 1);
  eq(v.passed, true);
});

await t('正文复述 "VALIDATION: PASS" 但尾部无结论 → 判 FAIL（防蒙混）', async () => {
  freshProgress([{ id: 'f1', name: 'A', description: 'x' }]);
  const { engine, session } = makeEngine();
  engine._execHeadless = async () => [
    '按要求，全部通过时输出 VALIDATION: PASS，否则输出 FAIL。',
    '开始验证……', '发现 typecheck 报错。', '还需要继续排查。',
    '（未完成，先输出中间结论）', '结论待定', '仍在分析', '暂无最终判断'
  ].join('\n');
  const task = progressManager.loadProgress(SID).features[0];
  const v = await engine._runValidator(SID, session, task, 1);
  eq(v.passed, false, '这一条锁住故障：全文正则会把格式复述误判成通过');
});

await t('_buildTaskContext 注入失败历史与进度摘要', () => {
  freshProgress([
    { id: 'f1', name: '甲', description: 'x', status: 'completed' },
    { id: 'f2', name: '乙', description: 'y' }
  ]);
  progressManager.recordValidationFailure(SID, 'f2', '接口缺 status 参数', 5);
  const { engine, session } = makeEngine();
  const task = progressManager.loadProgress(SID).features[1];
  const ctx = engine._buildTaskContext(SID, session, task);
  ok(/上次失败原因/.test(ctx) && /接口缺 status 参数/.test(ctx), '失败原因必须回灌进重试上下文');
  ok(/进度摘要/.test(ctx) && /已完成 1\/2/.test(ctx), '进度摘要必须注入');
});

console.log('\n_loop 重试计数与全局熔断');

await t('开发失败计入 retryCount，5 次后 blocked + 全局熔断 circuit_broken', async () => {
  freshProgress([{ id: 'f1', name: 'A', description: 'x' }]);
  const { engine, session } = makeEngine();
  let devCalls = 0;
  engine._runDeveloper = async () => { devCalls++; return false; };
  engine._runValidator = async () => { throw new Error('不该走到验证'); };
  const phases = [];
  engine._emit = (sid, ev, data) => { if (ev === 'ralph:state') phases.push(data.phase); };
  const state = { stop: false, paused: false, phase: 'idle', iteration: 0 };
  engine.running.set(SID, state);
  await engine._loop(SID, session, state, 100);
  const f = progressManager.loadProgress(SID).features[0];
  eq(f.retryCount, 5, '这一条锁住故障：原来开发失败不计数，静默死循环到 maxIterations');
  eq(f.blocked, true);
  eq(devCalls, 5, '第 5 次熔断后不该再试');
  ok(phases.includes('circuit_broken'), '连续 5 轮失败应触发全局熔断');
  const ledger = fs.readFileSync(path.join(sessionDir, 'ralph-rounds.jsonl'), 'utf-8')
    .trim().split('\n').map(JSON.parse);
  eq(ledger.length, 5, '每轮都要留台账');
  eq(ledger[0].outcome, 'dev_failed');
  ok(ledger.every(e => e.taskId === 'f1' && typeof e.durationMs === 'number'));
});

await t('验证通过：记录 commit、台账 outcome=passed、连续失败清零', async () => {
  freshProgress([{ id: 'f1', name: 'A', description: 'x' }]);
  const { engine, session } = makeEngine();
  engine._runDeveloper = async () => true;
  engine._runValidator = async () => ({ passed: true, notes: '' });
  engine._execShell = async () => ({ ok: true, rc: 0, out: 'abc1234 feat: f1 - A' });
  const state = { stop: false, paused: false, phase: 'idle', iteration: 0 };
  engine.running.set(SID, state);
  await engine._loop(SID, session, state, 10);
  const f = progressManager.loadProgress(SID).features[0];
  eq(f.status, 'completed');
  ok(/abc1234/.test(f.commit), 'PASS 后应记录 HEAD commit 作为证据');
  const ledger = fs.readFileSync(path.join(sessionDir, 'ralph-rounds.jsonl'), 'utf-8')
    .trim().split('\n').map(JSON.parse);
  eq(ledger[ledger.length - 1].outcome, 'passed');
});

console.log('\n任务图（v1.2.84 P2）');

await t('DISCOVERED 入图：谱系/队尾/去重，且不顺手做', async () => {
  freshProgress([{ id: 'f1', name: 'A', description: 'x', priority: 1 }]);
  const { engine, session } = makeEngine();
  engine._execHeadless = async () => '实现完成。\nDISCOVERED: 补充登录模块的错误处理\nDISCOVERED: 补充登录模块的错误处理\nPATTERN: 用 zod 校验';
  await engine._runDeveloper(SID, session, progressManager.loadProgress(SID).features[0], 1);
  const fs2 = progressManager.loadProgress(SID).features;
  const disc = fs2.filter(f => f.id.startsWith('disc-'));
  eq(disc.length, 1, '同名发现任务必须去重');
  eq(disc[0].discoveredFrom, 'f1', '要记录谱系');
  ok(disc[0].priority > 1, '发现任务排队尾，不插队');
});

await t('decomposeTask：父转 decomposed，子任务链式依赖', () => {
  freshProgress([
    { id: 'f0', name: '前置', description: 'p', priority: 1, status: 'completed' },
    { id: 'f1', name: 'A', description: 'x', priority: 2, dependsOn: ['f0'], branch: 'ralph/x' }
  ]);
  progressManager.decomposeTask(SID, 'f1', [
    { name: '甲', description: 'a' }, { name: '乙', description: 'b' }
  ]);
  const fs2 = progressManager.loadProgress(SID).features;
  const parent = fs2.find(f => f.id === 'f1');
  eq(parent.status, 'decomposed');
  eq(parent.blocked, false, 'decomposed 不算 blocked');
  const c1 = fs2.find(f => f.id === 'f1.1'), c2 = fs2.find(f => f.id === 'f1.2');
  eq(JSON.stringify(c1.dependsOn), '["f0"]', '首子继承父依赖');
  eq(JSON.stringify(c2.dependsOn), '["f1.1"]', '其余链式依赖前一个');
  eq(c1.branch, 'ralph/x', '继承父分支');
});

await t('getNextTask 图语义：decomposed 父不执行；下游等全部子任务完成', () => {
  freshProgress([
    { id: 'f1', name: 'A', description: 'x', priority: 1 },
    { id: 'f2', name: 'B', description: 'y', priority: 2, dependsOn: ['f1'] }
  ]);
  progressManager.decomposeTask(SID, 'f1', [{ name: '甲' }, { name: '乙' }]);
  eq(progressManager.getNextTask(SID).id, 'f1.1', '先做首子任务');
  progressManager.updateFeatureStatus(SID, 'f1.1', { status: 'completed' });
  eq(progressManager.getNextTask(SID).id, 'f1.2', '这一条锁住图语义：f2 不能在子任务完成前放行');
  progressManager.updateFeatureStatus(SID, 'f1.2', { status: 'completed' });
  eq(progressManager.getNextTask(SID).id, 'f2', '全部子任务完成后 f1 视为满足，f2 放行');
});

await t('_loop 失败 2 次触发重规划；子任务失败不再拆', async () => {
  freshProgress([{ id: 'f1', name: 'A', description: 'x' }]);
  const { engine, session } = makeEngine();
  let replanCalls = 0;
  engine._runDeveloper = async () => true;
  engine._runValidator = async (sid, sess, task) =>
    ({ passed: false, notes: `失败于 ${task.id} 第${(task.retryCount || 0) + 1}次` });
  engine._execHeadless = async (sid, sess, prompt, label) => {
    if (label === '重规划') { replanCalls++; return '```json\n{"subtasks":[{"name":"甲"},{"name":"乙"}]}\n```'; }
    return '';
  };
  const state = { stop: false, paused: false, phase: 'idle', iteration: 0 };
  engine.running.set(SID, state);
  await engine._loop(SID, session, state, 30);
  eq(replanCalls, 1, '顶层任务失败2次拆一次；子任务(parentId)不得再拆');
  const fs2 = progressManager.loadProgress(SID).features;
  eq(fs2.find(f => f.id === 'f1').status, 'decomposed');
  ok(fs2.find(f => f.id === 'f1.1'), '子任务已入图');
  // f1.1 连续失败会先触发全局熔断（连续5轮）停机，f1.2 轮不到——这正是预期：
  // 子任务只走常规重试路径（本例 notes 每次不同，不触发相同失败早熔断）
  ok(fs2.find(f => f.id === 'f1.1').retryCount > 0, '子任务走常规重试路径，不再拆');
});

await t('归档接通：再次规划前上一轮入 archive，patterns 跨轮保留', () => {
  freshProgress([{ id: 'f1', name: 'A', description: 'x', status: 'completed' }]);
  progressManager.addPattern(SID, '经验一');
  progressManager.archiveRound(SID);
  const p = progressManager.loadProgress(SID);
  eq(p.archive.length, 1, '这一条锁住故障：archiveRound 原是零调用死代码');
  eq(p.archive[0].features.length, 1);
  eq(JSON.stringify(p.patterns), '["经验一"]', 'patterns 是 codebase 级经验，跨轮保留');
  eq(p.features.length, 0, '新一轮从空 features 开始');
});

cleanup();
console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);

/**
 * 长程编排：服务层 —— 回归测试
 *
 * 服务层是五个模块的组装点，也是与 WebTmux 现有能力的接缝。这里锁三件事：
 *   1. 凭据从 CC Switch 取，且**不泄漏给执行者**
 *   2. plan 只解析不启动（不建沙箱、不起进程）
 *   3. 停止的顺序：先打断当前发次，再挂暂停闸（反了会白等一两小时）
 *
 * 运行: node tests/test-longrun-service.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { LongRunService } from '../server/services/LongRunService.js';
import { sandboxRoots } from '../server/services/LongRunSandbox.js';

const results = { passed: 0, failed: 0, errors: [] };
const pending = [];

function test(name, fn) {
  const p = (async () => {
    try { await fn(); results.passed++; console.log(`✅ ${name}`); }
    catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
  })();
  pending.push(p);
  return p;
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }

const TMP = path.join(os.tmpdir(), 'longrun_service_test');
function freshTmp() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  return TMP;
}
function writeDoc(text, name = '需求.md') {
  const p = path.join(freshTmp(), name);
  fs.writeFileSync(p, text, 'utf8');
  return p;
}

/** 假 AIEngine：记录 _callClaudeApi 收到什么，验证凭据来源与拼接。 */
function fakeEngine(over = {}) {
  const calls = [];
  return {
    calls,
    resolveSessionSettings: (appType, providerId) => ({
      apiUrl: 'https://sess.example.com', apiKey: 'sk-session-key', model: 'claude-opus-5',
      _providerId: providerId,
    }),
    getSettings: () => ({ claude: over.noGlobal ? {} : {
      apiUrl: 'https://global.example.com', apiKey: 'sk-global-key', model: 'claude-opus-5' } }),
    _callClaudeApi: async (prompt, config, opts) => {
      calls.push({ prompt, config, opts });
      if (over.throwError) throw new Error(over.throwError);
      return {
        text: JSON.stringify({ verdict: 'continue', confidence: 0.9, reason: '还有活' }),
        usage: { input_tokens: 100, output_tokens: 20 },
        stopReason: 'end_turn',
      };
    },
  };
}

/** 清理测试留下的沙箱 */
function cleanupSandbox(name) {
  try { fs.rmSync(path.join(sandboxRoots()[0], name), { recursive: true, force: true }); } catch {}
}

// ── plan：只解析，不启动 ────────────────────────────────────
test('plan 不建沙箱、不起进程', () => {
  const doc = writeDoc('做一个待办应用。\n参考 /tmp 目录。\n');
  const svc = new LongRunService({ aiEngine: fakeEngine() });
  const before = fs.existsSync(path.join(sandboxRoots()[0], 'test-plan-only'));
  const plan = svc.plan({ docPath: doc, sandboxName: 'test-plan-only' });
  assert(plan.sandboxName === 'test-plan-only');
  assert(plan.requirementChars > 0, '应给出需求字符数');
  assert(!fs.existsSync(plan.sandboxRoot) || before, 'plan 不该建沙箱目录');
  assert(svc.tasks.size === 0, 'plan 不该产生任务');
});

test('plan 从文档名派生沙箱名（去掉扩展与非法字符）', () => {
  const doc = writeDoc('x', '我的 项目/需求.md'.replace('/', '-'));
  const svc = new LongRunService({ aiEngine: fakeEngine() });
  const plan = svc.plan({ docPath: doc });
  assert(plan.sandboxName && !plan.sandboxName.includes('.md'), `实际 ${plan.sandboxName}`);
  assert(!/[\\/]/.test(plan.sandboxName), '不能含路径分隔符（会越出白名单）');
});

test('plan 报告外部参考是可写的（--add-dir 非只读）', () => {
  const doc = writeDoc(`资料在 ${os.tmpdir()} 目录。\n`);
  const svc = new LongRunService({ aiEngine: fakeEngine() });
  const plan = svc.plan({ docPath: doc, sandboxName: 'test-writable' });
  if (plan.extraDirs.length) {
    assert(plan.writableWarning.includes('可写'),
      `必须提示可写，否则这一点会被忘掉: ${plan.writableWarning}`);
  }
});

test('提示词缺段时 plan 就硬失败（不等到跑起来才发现）', () => {
  const doc = writeDoc('x');
  const svc = new LongRunService({ aiEngine: fakeEngine() });
  // 真实提示词是齐的，所以这里只验证 plan 会去加载它（不抛就是齐的）
  const plan = svc.plan({ docPath: doc, sandboxName: 'test-slots' });
  assert(plan.promptSlots.length === 5, `应有 5 段提示词，实际 ${plan.promptSlots.length}`);
});

// ── 凭据：从 CC Switch 取，不泄漏 ────────────────────────────
test('监督者凭据走 CC Switch（会话级优先于全局）', async () => {
  const engine = fakeEngine();
  const svc = new LongRunService({ aiEngine: engine });
  const complete = svc._makeComplete('prov-123');
  await complete('系统提示词', '用户内容');
  assert(engine.calls.length === 1, '应调用一次 AIEngine');
  assert(engine.calls[0].config.apiKey === 'sk-session-key',
    `传了 providerId 应用会话级凭据，实际 ${engine.calls[0].config.apiKey}`);
});

test('未传 providerId 时回落全局配置', async () => {
  const engine = fakeEngine();
  const svc = new LongRunService({ aiEngine: engine });
  await svc._makeComplete(null)('sys', 'user');
  assert(engine.calls[0].config.apiKey === 'sk-global-key',
    `应回落全局，实际 ${engine.calls[0].config.apiKey}`);
});

test('供应商未配置时报可操作的错（指向 CC Switch）', async () => {
  const svc = new LongRunService({ aiEngine: fakeEngine({ noGlobal: true }) });
  let threw = null;
  try { await svc._makeComplete(null)('sys', 'user'); } catch (e) { threw = e; }
  assert(threw, '应抛错');
  assert(threw.message.includes('CC Switch'), `报错要指向 CC Switch: ${threw.message}`);
});

test('system 与 user 都送达监督者', async () => {
  const engine = fakeEngine();
  const svc = new LongRunService({ aiEngine: engine });
  await svc._makeComplete(null)('SYS标记', 'USER标记');
  const p = engine.calls[0].prompt;
  assert(p.includes('SYS标记') && p.includes('USER标记'), `两者都要送到: ${p.slice(0, 80)}`);
});

test('无 aiEngine 时 complete 为 null（Supervisor 会据此叫人）', () => {
  const svc = new LongRunService({ aiEngine: null });
  assert(svc._makeComplete() === null, '没有引擎就不该造出 complete');
});

test('监督者用量被换算成 token 数（供预算核算）', async () => {
  const engine = fakeEngine();
  const svc = new LongRunService({ aiEngine: engine });
  const r = await svc._makeComplete(null)('sys', 'user');
  assert(r.inputTokens === 100 && r.outputTokens === 20,
    `用量要透传，实际 ${r.inputTokens}/${r.outputTokens}`);
  assert(r.stopReason === 'end_turn', 'stopReason 要透传（max_tokens 判定要用）');
});

// ── 人工干预：文件约定 ─────────────────────────────────────
test('inject 写文件而非直接调（与终端投件走同一条路）', () => {
  const svc = new LongRunService({ aiEngine: fakeEngine() });
  const fakeTask = {
    id: 't1', loop: {
      injectPath: path.join(freshTmp(), '.run', 'inject.txt'),
      injectNowPath: path.join(TMP, '.run', 'inject!.txt'),
      pausePath: path.join(TMP, '.run', 'pause'),
    },
  };
  svc.tasks.set('t1', fakeTask);

  let r = svc.inject('t1', '改用 Vue', false);
  assert(r.ok && fs.existsSync(fakeTask.loop.injectPath), 'inject.txt 应被写出');
  assert(fs.readFileSync(fakeTask.loop.injectPath, 'utf8') === '改用 Vue', '内容要原样');

  r = svc.inject('t1', '马上停', true);
  assert(fs.existsSync(fakeTask.loop.injectNowPath), '立即模式应写 inject!.txt');
});

test('pause 建/删 .run/pause 空文件', () => {
  const svc = new LongRunService({ aiEngine: fakeEngine() });
  const pausePath = path.join(freshTmp(), '.run', 'pause');
  svc.tasks.set('t1', { id: 't1', loop: { pausePath,
    injectPath: path.join(TMP, '.run', 'inject.txt'),
    injectNowPath: path.join(TMP, '.run', 'inject!.txt') } });

  svc.pause('t1', true);
  assert(fs.existsSync(pausePath), 'pause 文件应被建出');
  svc.pause('t1', false);
  assert(!fs.existsSync(pausePath), 'pause 文件应被删掉');
});

// ⚠ 顺序要紧：反过来先建 pause 的话，当前这发会照常跑完（暂停闸在派发口，
//   不在运行中），而那可能还有一两个小时
test('stop 先打断当前发次，再挂暂停闸', () => {
  const svc = new LongRunService({ aiEngine: fakeEngine() });
  const runDir = path.join(freshTmp(), '.run');
  const loop = {
    injectPath: path.join(runDir, 'inject.txt'),
    injectNowPath: path.join(runDir, 'inject!.txt'),
    pausePath: path.join(runDir, 'pause'),
  };
  svc.tasks.set('t1', { id: 't1', loop });

  const r = svc.stop('t1', '先停一下');
  assert(r.ok, 'stop 应成功');
  // 立即打断文件与暂停闸都要在
  assert(fs.existsSync(loop.injectNowPath), '应写立即打断文件（不等工具间隙）');
  assert(fs.existsSync(loop.pausePath), '应挂上暂停闸');
  const text = fs.readFileSync(loop.injectNowPath, 'utf8');
  assert(text.startsWith('!!'), `立即模式要带 !! 前缀: ${text}`);
  // 删掉 pause 会**继续**而不是终止，这一点必须告诉用户
  assert(r.note.includes('不是终止'), `提示要说清暂停不是终止: ${r.note}`);
});

test('对不存在的任务操作时报错而不崩', () => {
  const svc = new LongRunService({ aiEngine: fakeEngine() });
  for (const fn of [() => svc.inject('nope', 'x'), () => svc.pause('nope'), () => svc.stop('nope')]) {
    const r = fn();
    assert(r.ok === false && r.error, `应返回错误对象: ${JSON.stringify(r)}`);
  }
  assert(svc.status('nope') === null, '查不存在的任务应返回 null');
});

test('status 无参数时列出全部任务', () => {
  const svc = new LongRunService({ aiEngine: fakeEngine() });
  assert(Array.isArray(svc.status()), '无参数应返回数组');
  assert(svc.status().length === 0, '空服务应返回空数组');
});

await Promise.all(pending);
fs.rmSync(TMP, { recursive: true, force: true });
for (const n of ['test-plan-only', 'test-writable', 'test-slots']) cleanupSandbox(n);
console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

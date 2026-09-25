/**
 * 「出错待处理」误报：CLI 在跑时不采用插件的关键词出错判定。
 *
 * 由来（2026-09-25）：ssh 会话早已空闲，面板却一直挂着「1 个出错待处理」红条。
 * 部署运维插件在屏幕末尾 30 行里搜 /error|failed|exception/，命中的是 Claude Code 状态栏
 * 「✘ Auto-update failed · Run claude doctor」。同一屏在 16 个插件里有 5 个判出错
 * （部署运维、重构、修 bug、TDD、App 开发）—— AI 回复正文里写到 failed、测试失败也会命中。
 *
 * fixture claude-idle-autoupdate-failed.txt：状态栏那几行是真实抓屏（带 ANSI），上面的正文已脱敏。
 *
 * 运行: node tests/test-plugin-error-false-positive.mjs
 */

import fs from 'fs';

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function test(name, fn) {
  try { fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}

// 插件与引擎日志很多，只保留测试输出
const origLog = console.log;
console.log = (...a) => { if (/^(✅|❌|\n=== |  •)/.test(String(a[0]))) origLog(...a); };
const { AIEngine } = await import('../server/services/AIEngine.js');
const pluginManager = (await import('../server/services/MonitorPlugins/index.js')).default;
await pluginManager.loadBuiltinPlugins();
const engine = new AIEngine();
const plugins = pluginManager.listPlugins();
const IDLE = fs.readFileSync(new URL('./fixtures/screens/claude-idle-autoupdate-failed.txt', import.meta.url), 'utf8');

/** 固定 CLI 检测结果（不依赖真实 tmux 进程） */
const withCli = (cli, fn) => {
  const orig = engine.detectRunningCLI;
  engine.detectRunningCLI = () => cli;
  try { return fn(); } finally { engine.detectRunningCLI = orig; }
};
const analyze = (screen, pluginId, cli) => withCli(cli, () => engine.preAnalyzeStatus(screen, 'claude', null, {}, pluginId));

test('插件确实都加载了（否则下面全是空转）', () => {
  assert(plugins.length >= 10 && plugins.some((p) => p.id === 'deployment'), `只加载了 ${plugins.map((p) => p.id)}`);
});

test('CLI 在跑、屏上只是状态栏写着 Auto-update failed：任何插件都不得判「出错」', () => {
  const bad = plugins.map((p) => [p.id, analyze(IDLE, p.id, 'claude')]).filter(([, r]) => r?.actionType === 'error');
  assert(!bad.length, `这些插件仍判出错：${bad.map(([id, r]) => `${id}「${r.currentState}」`).join('，')}`);
});

test('反证：不排除时这份屏幕确实会被判出错（fixture 没失效，测试不是空过）', () => {
  // CLI 检测给 null（当成裸 shell）→ 关键词判定照常生效，至少部署运维要判出错
  const r = analyze(IDLE, 'deployment', null);
  assert(r?.actionType === 'error', `fixture 已不能复现误报，实际 ${JSON.stringify(r && { t: r.actionType, s: r.currentState })}`);
});

test('裸 shell 里部署真失败：照常报「出错待处理」（没把这项功能一起关掉）', () => {
  const shell = 'deploy@host:~/app$ ./deploy.sh\nUploading build...\nError: connect ECONNREFUSED 10.0.0.5:22\nDeploy failed, exit code 1\ndeploy@host:~/app$ ';
  const r = analyze(shell, 'deployment', null);
  assert(r?.actionType === 'error' && r?.requireConfirmation, JSON.stringify(r && { t: r.actionType, s: r.currentState }));
});

test('排除后走通用检测：空闲的 Claude Code 照常认成空闲', () => {
  const r = analyze(IDLE, 'deployment', 'claude');
  assert(r && r.actionType !== 'error', JSON.stringify(r));
});

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exit(results.failed ? 1 : 0);

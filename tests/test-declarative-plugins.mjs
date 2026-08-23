/**
 * 声明式插件 —— 回归测试
 *
 * 背景（P3）：7 个插件（前端设计/安全审计/计划执行/API集成/文档处理/科研/TDD）
 * 逐字复制了同一套骨架，1300 多行里真正不同的只有正则和文案，骨架级修复得改 7 遍。
 * 现已收敛为 DeclarativePlugin + 各自的数据定义（改写时用 3017 项逐方法比对确认等价）。
 *
 * 本测试锁住：定义完整性、阶段识别顺序、警告/完成/空闲三条分支的形状。
 *
 * 运行：node tests/test-declarative-plugins.mjs
 */

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

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || '不相等'}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

const DIR = '../server/services/MonitorPlugins/plugins/';
const NAMES = ['FrontendDesignPlugin', 'SecurityAuditPlugin', 'PlanExecutionPlugin',
  'APIIntegrationPlugin', 'DocumentProcessingPlugin', 'ScientificResearchPlugin',
  'TDDDevelopmentPlugin'];

const plugins = {};
for (const n of NAMES) {
  const { default: Cls } = await import(DIR + n + '.js');
  plugins[n] = new Cls();
}

test('7 个插件都有完整定义且 id 唯一', () => {
  const ids = new Set();
  for (const [n, p] of Object.entries(plugins)) {
    assert(p.id && p.name && p.description, `${n} 缺少基础字段`);
    assert(Array.isArray(p.phases) && p.phases.length > 0, `${n} 无阶段定义`);
    assert(Array.isArray(p.projectPatterns) && p.projectPatterns.length > 0, `${n} 无匹配规则`);
    assert(!ids.has(p.id), `id 重复: ${p.id}`);
    ids.add(p.id);
  }
  eq(ids.size, 7, '插件数量');
});

test('每个阶段都有对应的 phaseConfig（不会静默回落到默认阶段）', () => {
  for (const [n, p] of Object.entries(plugins)) {
    for (const ph of p.phases) {
      const c = p.getPhaseConfig(ph.id);
      assert(c && Array.isArray(c.autoActions) && c.autoActions.length,
        `${n} 阶段 ${ph.id} 缺少 autoActions`);
      assert(typeof c.promptTemplate === 'string', `${n} 阶段 ${ph.id} 无提示词字段`);
    }
  }
});

test('未知阶段回落到 defaultPhase 的配置', () => {
  const tdd = plugins.TDDDevelopmentPlugin;
  eq(JSON.stringify(tdd.getPhaseConfig('不存在的阶段').autoActions),
     JSON.stringify(tdd.getPhaseConfig('write_test').autoActions));
});

test('阶段识别按规则顺序命中（TDD 的红绿重构循环）', () => {
  const tdd = plugins.TDDDevelopmentPlugin;
  eq(tdd.detectPhase('refactor 重构中', {}), 'refactor');
  eq(tdd.detectPhase('all specs passed ✓', {}), 'run_pass');
  eq(tdd.detectPhase('test failed ✗', {}), 'run_fail');
  eq(tdd.detectPhase('随便什么内容', {}), 'write_test', '未命中应回落默认阶段');
});

test('带 all 条件的规则必须两个都满足', () => {
  const tdd = plugins.TDDDevelopmentPlugin;
  // "passed" 命中 any，但没有 test/spec 关键词 → 不该判成 run_pass
  assert(tdd.detectPhase('deployment passed', {}) !== 'run_pass', 'all 条件未生效');
});

test('matches 只在项目上下文命中关键词时认领', () => {
  eq(plugins.TDDDevelopmentPlugin.matches({ goal: 'jest 单元测试' }), true);
  eq(plugins.TDDDevelopmentPlugin.matches({ goal: '写一篇公众号文章' }), false);
  eq(plugins.FrontendDesignPlugin.matches({ projectDesc: 'tailwind 组件库' }), true);
});

test('完成信号返回 success 且不需要操作', () => {
  const r = plugins.TDDDevelopmentPlugin.analyzeStatus('all tests pass', 'run_pass', {});
  eq(r.actionType, 'success');
  eq(r.needsAction, false);
  eq(r.message, 'TDD 循环完成');
});

test('警告分支带上 phase / phaseConfig（原实现的字段不能丢）', () => {
  const r = plugins.TDDDevelopmentPlugin.analyzeStatus('test failed error', 'refactor', {});
  assert(r, '应返回警告状态');
  eq(r.phase, 'refactor');
  assert(r.phaseConfig && r.phaseConfig.autoActions, 'phaseConfig 丢失');
  eq(r.requireConfirmation, true, '错误分支应要求人工确认');
});

test('空闲时发出第一条 autoAction，且仅在该阶段允许自动操作时', () => {
  const idle = plugins.TDDDevelopmentPlugin.analyzeStatus('> ', 'write_test', {});
  eq(idle?.actionType, 'text_input', 'write_test 允许自动操作');
  eq(idle.suggestedAction, '继续');
  // run_pass 配的是 autoActionEnabled:false → 不该主动发指令
  eq(plugins.TDDDevelopmentPlugin.analyzeStatus('> ', 'run_pass', {}), null);
});

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) {
  for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
}
process.exit(results.failed ? 1 : 0);

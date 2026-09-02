/**
 * 声明式早期规则表回归（v1.2.88，P3-13 第一阶段）。
 * 锁三件事：① 迁移的两条规则行为与原 if 分支一致（状态串逐字相同）
 *           ② 规则 id 穿进判定结果 _rule（台账归因的前提）
 *           ③ 单条规则异常不拖垮整表
 * 全屏级行为回归由 test-ai-status-parse 的 16 份真实 fixture 承担，这里测规则单元。
 */
import { EARLY_RULES, evalEarlyRules } from '../server/services/aiRules/earlyRules.js';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};
const ok = (c, m) => { if (!c) throw new Error(m || '断言失败'); };
const eq = (a, b, m) => { if (a !== b) throw new Error(m || `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); };

// 与 AIEngine.detectOptionMenu 行为对齐的最小 stub（items/hasYes/hasEscHint/title）
const menuStub = (ret) => ({ detectOptionMenu: () => ret });

t('cli-dialog-esc：/status 面板命中，动作 Esc', () => {
  const hit = evalEarlyRules({
    tail: ' Settings  Status  Config\n Version: 2.0\n Esc to cancel',
    helpers: menuStub(null)
  });
  eq(hit?.rule.id, 'cli-dialog-esc');
  eq(hit.rule.action.key, 'Escape');
  eq(hit.rule.state, 'CLI 设置对话框开着（/status 等），屏幕被面板占满无法判断工作状态', '状态串必须与迁移前逐字一致');
});

t('cli-dialog-esc：确认菜单带 Esc 提示不得误吞（另有 select 分支处理）', () => {
  const hit = evalEarlyRules({
    tail: ' Do you want to proceed?\n ❯ 1. Yes\n   2. No\n Esc to cancel',
    helpers: menuStub(null)
  });
  ok(!hit || hit.rule.id !== 'cli-dialog-esc', '这一条锁住边界：确认菜单不能被当成设置面板按 Esc 关掉');
});

t('cli-dialog-esc：白名单外面板靠结构兜底（编号项 + Esc 提示）', () => {
  const hit = evalEarlyRules({
    tail: ' Agents\n 1. code-reviewer\n 2. doc-writer\n Esc to cancel',
    helpers: menuStub({ items: 2, hasYes: false, hasEscHint: true, title: 'Agents' })
  });
  eq(hit?.rule.id, 'cli-dialog-esc');
  ok(/未知选项面板/.test(hit.extras.log || ''), '兜底命中要留结构识别日志');
});

t('panel-no-escape：无脱身方式的面板转 warning + 交 AI', () => {
  const hit = evalEarlyRules({
    tail: ' Pick one\n 1. a\n 2. b',
    helpers: menuStub({ items: 2, hasYes: false, hasEscHint: false, title: 'Pick one' })
  });
  eq(hit?.rule.id, 'panel-no-escape');
  const f = hit.rule.fields(hit.extras);
  eq(f.actionType, 'warning');
  eq(f.requireConfirmation, true);
  eq(f._needsAiJudgement, true);
  ok(/Pick one/.test(f.currentState));
});

t('普通屏幕：不命中任何规则', () => {
  eq(evalEarlyRules({ tail: '❯ \n  auto mode on', helpers: menuStub(null) }), null);
});

t('单条规则 match 抛异常不拖垮整表', () => {
  const rules = EARLY_RULES;
  const boom = { id: 'boom', match() { throw new Error('x'); } };
  rules.unshift(boom);
  try {
    const hit = evalEarlyRules({
      tail: ' Settings  Status  Config\n Esc to cancel',
      helpers: menuStub(null)
    });
    eq(hit?.rule.id, 'cli-dialog-esc', '异常规则之后的规则仍要被求值');
  } finally {
    rules.shift();
  }
});

t('每条规则都有稳定 id（台账归因前提）', () => {
  ok(EARLY_RULES.every(r => typeof r.id === 'string' && r.id.length > 2));
  eq(new Set(EARLY_RULES.map(r => r.id)).size, EARLY_RULES.length, 'id 不得重复');
});

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);

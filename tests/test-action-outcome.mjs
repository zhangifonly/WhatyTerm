/**
 * 自动操作效果台账 —— 回归测试
 *
 * 背景：监控每天发出成千上万次操作（历史日志里「等待接受编辑 → 发继续」一项就 3271 次），
 * 但此前唯一的验证是「2 秒后有没有 Interrupted」，且把「没被打断」记作 success ——
 * 往一个根本不理会的会话里发「继续」也算成功。于是没人答得上来监控到底有没有用。
 *
 * 本测试锁住三件事：
 *   1. 屏幕比对要抹掉走秒/token/spinner 这类噪音，否则「屏幕变了」恒真、统计失去意义
 *   2. 成功判据按操作类型区分，且 no_effect 必须能被识别出来（这是最该看的那个数）
 *   3. 聚合出的 noEffectRate 能指认出空转的判定
 *
 * 运行：node tests/test-action-outcome.mjs
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

function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || '不相等'}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}

const mod = await import('../server/services/ActionOutcome.js');
const { normalize, hash } = mod;
const ledger = mod.default;

// 台账默认会往 ~/.webtmux 落盘；测试里只走内存，避免污染真实数据
ledger._append = () => {};

/** 造一个假会话：getScreenContent 每次返回 screens 里的下一屏 */
function fakeSession(screens) {
  let i = 0;
  return {
    id: 's1', name: '测试会话',
    getScreenContent: () => screens[Math.min(i++, screens.length - 1)]
  };
}

function verify(before, after, info = {}) {
  const session = fakeSession([before, after]);
  const entry = {
    id: 'x', at: '', sessionId: 's1', sessionName: '测试会话',
    state: info.state || '测试判定',
    actionType: info.actionType || 'text_input',
    action: info.action || '继续',
    source: 'rule',
    beforeHash: hash(before),
    hadConfirmMenu: info.hadConfirmMenu || false
  };
  session.getScreenContent();          // 消耗 before
  ledger._verify(session, entry);
  return ledger.recent[ledger.recent.length - 1];
}

// ============ 1. 噪音归一化 ============

test('走秒计时器不算屏幕变化（否则运行中的会话每次都判"变了"）', () => {
  eq(hash('Sautéing… (12s · esc to interrupt)'), hash('Sautéing… (45s · esc to interrupt)'));
});

test('token 计数与 spinner 不算变化', () => {
  eq(hash('⠋ 思考中 1.2k tokens'), hash('⠹ 思考中 3.4k tokens'));
});

test('真正的内容变化仍能识别', () => {
  assert(hash('正在写 a.js') !== hash('正在写 b.js'), '内容变化被抹掉了');
});

test('normalize 抹掉 ANSI 序列', () => {
  eq(normalize('\x1b[32m完成\x1b[0m'), '完成');
});

// ============ 2. 成功判据 ============

test('发了等于没发 → no_effect（关键：不能记成成功）', () => {
  const scr = '❯ \n  accept edits on';
  eq(verify(scr, scr).outcome, 'no_effect');
});

test('CLI 真动起来了 → advanced', () => {
  eq(verify('❯ ', 'Brewing… (3s · esc to interrupt)').outcome, 'advanced');
});

test('被打断 → interrupted（即使屏幕有变化也是坏结果）', () => {
  const r = verify('Sautéing… (5s · esc to interrupt)',
                   'Interrupted · What should Claude do instead?');
  eq(r.outcome, 'interrupted');
  eq(r.interrupted, true);
});

test('屏幕变了但看不出在干活 → changed（弱成功）', () => {
  eq(verify('❯ ', '❯ 已写入 3 个文件').outcome, 'changed');
});

test('确认菜单按了选项后菜单消失 → advanced', () => {
  const before = 'Do you want to proceed?\n❯ 1. Yes\n  2. No';
  const r = verify(before, '❯ 已执行', { actionType: 'select', action: '1', hadConfirmMenu: true });
  eq(r.outcome, 'advanced');
});

test('按了选项菜单还在 → no_effect（按键没被 Ink 收到）', () => {
  const before = 'Do you want to proceed?\n❯ 1. Yes\n  2. No';
  const r = verify(before, before, { actionType: 'select', action: '1', hadConfirmMenu: true });
  eq(r.outcome, 'no_effect');
});

// ============ 3. 聚合 ============

test('按判定类型聚合，能指认出空转的策略', () => {
  ledger.recent.length = 0;   // 只统计本用例造的记录
  const idle = '❯ \n  accept edits on';
  for (let i = 0; i < 3; i++) verify(idle, idle, { state: '等待接受编辑' });
  verify('❯ ', 'Brewing… (3s · esc to interrupt)', { state: '空闲' });
  ledger._load = (n) => ledger.recent.slice(-n);

  const s = ledger.stats();
  eq(s.sampled, 4, '样本数');
  const waiting = s.byState.find(g => g.state === '等待接受编辑');
  eq(waiting.total, 3);
  eq(waiting.noEffectRate, 100, '三次全空转应报 100%');
  eq(waiting.effectiveRate, 0);
  const idleGroup = s.byState.find(g => g.state === '空闲');
  eq(idleGroup.effectiveRate, 100);
  eq(s.byState[0].state, '等待接受编辑', '应按次数降序，最频繁的排最前');
});

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exit(results.failed ? 1 : 0);

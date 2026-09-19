/**
 * 机械「继续」的两道新闸 —— 都来自 2026-09-18 tableCard 实测事故：
 * 机械「继续」连发到 15 万余次、烧掉 $1519，而 CLI 早就停在一个四选一的问题上，
 * 甚至写下「我一直在等指令，你一直发『继续』」。三道老闸一次都没触发。
 *
 * 老闸判的是「发了继续但回复正文没变」。这次每轮 CLI 都真回了话（`（等）`、
 * `Cooked for 14s`），正文每轮都不同 → 计数每轮归零。所以补两条正交判据：
 *   ① 问号右侧是选项清单时，那是在等人选，不是自问自答（pendingQuestion）
 *   ② CLI 抱怨我们复读，或连发次数本身到顶（continueStreak）
 *
 * 运行: node tests/test-continue-streak.mjs
 */

import { shouldStopMechanicalContinue, nextStreak, MECHANICAL_CONTINUE_LIMIT } from '../server/services/continueStreak.js';
import { hasPendingQuestion } from '../server/services/pendingQuestion.js';

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function test(name, fn) {
  try { fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}

// 事故现场原文（照截图逐字抄；每轮 CLI 都有新回复，所以老闸的"屏幕没变"判据失效）
const REAL_SCREEN = [
  '❯ 继续',
  '● （等）',
  '✱ Cooked for 14s · done 3:07',
  '● 我一直在等指令，你一直发「继续」。这说明我们在不同的频道上——所以我换个做法：不再猜，直接问。',
  '● User declined to answer questions',
  '  └ · 我理解不了「继续」指什么——今天的活已收口、5.19.110 已上传，剩下的都要你先做一个决定。你想要哪个？（你自己挑一件做 / 撤回广联达旧包 / 我已经发布了 / 别做了，就此停下）',
  '✳ Cogitated for 23s · done 3:09',
  '❯ ',
  '▸▸ auto mode on (shift+tab to cycle) · ← 6 agents      ✓ Update installed · Restart to update',
].join('\n');

test('事故现场：必须判成「CLI 在等人决策」（老闸判成自问自答，是全部损失的起点）', () => {
  assert(hasPendingQuestion(REAL_SCREEN) === true, '再判成 false 就会继续机械催下去');
  // 两条判据要各自独立成立：去掉 declined 那行（CLI 并非每次提问都拒答过），
  // 仅凭「问号右侧是选项清单」也必须拦住 —— 否则变异测试会被另一条掩盖。
  const noDeclined = REAL_SCREEN.split('\n').filter((l) => !/User declined/.test(l)).join('\n');
  assert(hasPendingQuestion(noDeclined) === true, '没有 declined 标记时，选项清单这条判据必须自己站住');
});

test('CLI 印出「没人答我」时直接停手，不依赖能否解析出问题形态', () => {
  // AskUserQuestion 被拒答时 Claude Code 会打印这行。它是 CLI 的原话，
  // 比任何句式推断都硬；问题正文可能在滚动区之外或措辞刁钻，解析不出也照停。
  const screen = '● User declined to answer questions\n✱ Cogitated for 23s · done 3:09\n❯ ';
  assert(hasPendingQuestion(screen) === true, '仅凭 declined 标记也必须判成在等人');
});

test('问号右侧是选项清单 → 在等人选，不是自答', () => {
  assert(hasPendingQuestion('你想要哪个？（自己挑一件做 / 撤回旧包 / 别做了，就此停下）\n❯ ') === true, '中文斜杠清单');
  assert(hasPendingQuestion('Which should I do first? (revert the package / publish as-is / stop here)\n> ') === true, '英文括号清单');
  assert(hasPendingQuestion('你想怎么处理？先删旧包、或者直接发布\n❯ ') === true, '「或者」也是分隔符');
});

test('真正的自问自答不能被误拦（老闸存在的理由，不许回归）', () => {
  assert(hasPendingQuestion('是否需要重启？不需要，热更新已经生效，服务端已经读到了新配置。\n❯ ') === false,
    '自答被判成提问 → 正常节奏被打断，v1.2.59 就因误熔断挂死过');
  assert(hasPendingQuestion('要不要加测试？我已经加好了，三个用例全部通过，覆盖了边界情况。\n❯ ') === false, '自答且成句');
});

test('编号确认菜单仍归 select 分支，不被当成开放提问', () => {
  assert(hasPendingQuestion('Do you want to proceed?\n❯ 1. Yes\n  2. No') === false);
});

test('计时行动词是随机轮换的，噪音过滤不能靠枚举', () => {
  // 实测同一屏出现 Cooked/Brewed/Baked/Cogitated 四种。漏掉任一种，紧跟提问的计时行
  // 就会留在正文里，把「问号右侧是选项清单」算歪 —— 事故现场正是这样漏掉的。
  for (const verb of ['Cooked', 'Brewed', 'Baked', 'Cogitated', 'Simmered', 'Churned', 'Noodled']) {
    const screen = `你想要哪个？（自己挑一件 / 撤回旧包 / 就此停下）\n✱ ${verb} for 12s · done 3:07\n❯ `;
    assert(hasPendingQuestion(screen) === true, `动词 ${verb} 的计时行没被滤掉`);
  }
});

test('CLI 抱怨我们复读 → 立刻停手（最强信号，不等次数）', () => {
  const cases = [
    '我一直在等指令，你一直发「继续」。这说明我们在不同的频道上',
    '我理解不了「继续」指什么——今天的活已收口',
    '请不要再发「继续」了，我需要你做一个决定',
    'You keep saying 继续 but I need a decision',
  ];
  for (const reply of cases) {
    const v = shouldStopMechanicalContinue({ streak: 1, lastReply: reply });
    assert(v.stop === true, `没识别出抱怨：「${reply.slice(0, 20)}」`);
    assert(v.reason.includes('继续'), v.reason);
  }
});

test('正常回复不因次数之外的原因停手（不许误伤正常节奏）', () => {
  const normal = '我已经把权限矩阵改好了，新增了越信用额度审批权限，现在继续修手机端布局。';
  assert(shouldStopMechanicalContinue({ streak: 3, lastReply: normal }).stop === false, '正常干活时不该停');
  assert(shouldStopMechanicalContinue({ streak: 0, lastReply: '' }).stop === false, '空回复+零次数不该停');
});

test('次数到顶兜底：屏幕一直在变也照样停（本次事故的正交判据）', () => {
  const normal = '我已经改好了权限矩阵，接着修手机端布局。';
  assert(shouldStopMechanicalContinue({ streak: MECHANICAL_CONTINUE_LIMIT - 1, lastReply: normal }).stop === false, '到顶前不停');
  const v = shouldStopMechanicalContinue({ streak: MECHANICAL_CONTINUE_LIMIT, lastReply: normal });
  assert(v.stop === true, `连发 ${MECHANICAL_CONTINUE_LIMIT} 次必须停`);
  assert(/屏幕虽在变但工作没往前走/.test(v.reason), v.reason);
  assert(MECHANICAL_CONTINUE_LIMIT >= 5, `上限 ${MECHANICAL_CONTINUE_LIMIT} 太小会误伤正常节奏（v1.2.59 的 4 就误伤过）`);
});

test('连发计数：只要还是「继续」就累加，换动作归零', () => {
  assert(nextStreak(undefined, '继续') === 1, '首次');
  assert(nextStreak(7, '继续') === 8, '累加');
  assert(nextStreak(7, '2') === 0, '换成菜单选择 → 归零');
  assert(nextStreak(7, null) === 0, '无动作 → 归零');
  assert(nextStreak(3, '继续完成剩下的') === 4, '以「继续」开头的变体也算');
});

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

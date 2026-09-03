/**
 * 回归：确认界面自动选择必须先「验活」——屏上真有等待选择的菜单才发键。
 *
 * 故障现象（v1.2.81 修复前，node scripts/monitor-effectiveness.mjs 实测）：
 *   「Claude Code确认界面」914 次 / 空转率 99.5%
 *   「检测到确认界面，自动选择选项 1」221 次 / 空转率 100%
 *   台账 1142 条记录里 1138 条落账时 hadConfirmMenu=false。
 * 原因：检测只做关键词匹配（最后 5000 字符找 "Do you want to…/1. Yes"），
 * 对话正文里的问句+编号列表照样命中，Enter/方向键落在空输入框上纹丝不动。
 * 活菜单铁证（fixture confirm-proceed-eca0a648.txt）：
 *   ❯ 指针行 + 底部 "Esc to cancel · Tab to amend" 快捷键提示，且贴屏幕底。
 * 修复约束：Codex 同路径实测 84.3% 有效，非 Claude 不得收紧。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isLiveConfirmMenu, isCodexLiveConfirm } from '../server/services/liveMenu.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { AIEngine } = await import('../server/services/AIEngine.js');
const engine = new AIEngine();

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};
const ok = (c, msg) => { if (!c) throw new Error(msg || '断言失败'); };

const LIVE_MENU = [
  ' sed command contains operations that require explicit approval',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No',
  '',
  ' Esc to cancel · Tab to amend · ctrl+e to explain'
].join('\n');

// 对话正文误报样本：AI 输出里复述了确认问句和编号列表，但没有活菜单
const PROSE = [
  '⏺ 我分析了这个部署脚本的风险。',
  '  Do you want to proceed? 这个提示出现时你有两个选择：',
  '  1. Yes —— 直接执行',
  '  2. No —— 取消操作',
  '  建议在生产环境先跑 dry-run。',
  '',
  '╭──────────────────────────────╮',
  '│ >                            │',
  '╰──────────────────────────────╯',
  '  ? for shortcuts'
].join('\n');

console.log('liveMenu 探针');

t('真实活菜单（fixture 形态）判定为活', () => {
  ok(isLiveConfirmMenu(LIVE_MENU), '❯ 指针 + Esc 提示必须判活');
});

t('正文里的问句+编号列表判定为不活', () => {
  ok(!isLiveConfirmMenu(PROSE), '这一条锁住故障：无 ❯ 指针不得判活');
});

t('只有 ❯ 没有底部快捷键提示：不活（输入框提示符不算菜单）', () => {
  ok(!isLiveConfirmMenu('❯ 1. 先做数据迁移\n  2. 再切流量\n以上是我的计划。'));
});

t('转录引用行 "> 1. Yes" 不算指针（防把历史消息认成菜单）', () => {
  ok(!isLiveConfirmMenu('> 1. Yes\n  2. No\n Esc to cancel'));
});

t('菜单在 scrollback 深处（尾部 1200 字符之外）：不活', () => {
  const scrolled = LIVE_MENU + '\n' + '后续输出\n'.repeat(300);
  ok(!isLiveConfirmMenu(scrolled), '已滚走的旧菜单不得再触发按键');
});

t('带边框的旧版菜单（│ ❯ 1. Yes）也判活', () => {
  ok(isLiveConfirmMenu('│ Do you want to proceed? │\n│ ❯ 1. Yes │\n│   2. No │\n Esc to cancel'),
    '行首边框字符不得挡住指针识别（test-confirm-guard 的 confirmBox 即此样式）');
});

t('trust 对话框变体（Enter to confirm · Esc to exit）也判活', () => {
  ok(isLiveConfirmMenu(' Do you trust the files in this folder?\n ❯ 1. Yes, proceed\n   2. No, exit\n\n Enter to confirm · Esc to exit'));
});

console.log('\npreAnalyzeStatus 集成');

t('claude 正文误报：不得返回确认界面/select', () => {
  const r = engine.preAnalyzeStatus(PROSE, 'claude');
  ok(!(r && r.actionType === 'select'), `这一条锁住故障：实际返回 ${JSON.stringify(r && { state: r.currentState, actionType: r.actionType, action: r.suggestedAction })}`);
});

t('claude 真实活菜单：照常返回 select', () => {
  const r = engine.preAnalyzeStatus(LIVE_MENU, 'claude');
  ok(r && r.actionType === 'select', `活菜单必须继续自动处理，实际 ${JSON.stringify(r && { state: r.currentState, actionType: r.actionType })}`);
});

t('codex 不受验活闸影响（同关键词无 ❯ 仍按原逻辑处理）', () => {
  const codexScreen = ' Do you want to proceed?\n 1. Yes\n 2. No\n';
  const r = engine.preAnalyzeStatus(codexScreen, 'codex');
  ok(r && r.actionType === 'select', `Codex 路径实测 84.3% 有效，不得被收紧，实际 ${JSON.stringify(r && { state: r.currentState, actionType: r.actionType })}`);
});

console.log('\nv1.2.90 Codex 长命令活菜单（结构判据）');

t('真实抓屏：长命令确认菜单（问句-选项距离 430>400）仍判活并 select', () => {
  const screen = fs.readFileSync(path.join(__dirname, 'fixtures/screens/codex-confirm-long-cmd.txt'), 'utf8');
  const r = engine.preAnalyzeStatus(screen, 'codex');
  ok(r && r.actionType === 'select',
    `这一条锁住 v1.2.89 回归：长命令把距离撑破 400，真菜单被误杀。实际 ${JSON.stringify(r && { state: r.currentState, actionType: r.actionType })}`);
});

t('isCodexLiveConfirm：有底部提示行+编号选项判活', () => {
  ok(isCodexLiveConfirm(' Reason: x\n › 1. Yes, proceed (y)\n   2. No (esc)\n\n Press enter to confirm or esc to cancel'));
});

t('isCodexLiveConfirm：旧菜单（尾部无提示行）不判活', () => {
  const stale = ' › 1. Yes, proceed\n Press enter to confirm or esc to cancel\n' + '后续执行输出\n'.repeat(30);
  ok(!isCodexLiveConfirm(stale), '答完后提示行被推离尾部，不得再判活');
});

t('真实抓屏：选项2回显整条命令（1.Yes 距底 727>700）仍判活并 select', () => {
  const screen = fs.readFileSync(path.join(__dirname, 'fixtures/screens/codex-confirm-long-option.txt'), 'utf8');
  const r = engine.preAnalyzeStatus(screen, 'codex');
  ok(r && r.actionType === 'select',
    `锁住第二次回归：超长选项块把选项行挤出 700 窗口，靠 footer 紧贴底部兜住。实际 ${JSON.stringify(r && { state: r.currentState, actionType: r.actionType })}`);
});

console.log('\nv1.2.89 Codex 验活闸与排队消息守卫');

t('codex：scrollback 旧菜单（问句与选项相距>400字符）不发键', () => {
  const stale = ' Do you want to proceed?\n' + '中间隔着大段执行输出……\n'.repeat(40) + ' 正在编译 module_x …\n';
  const r = engine.preAnalyzeStatus(stale, 'codex');
  ok(!(r && r.actionType === 'select'),
    `这一条锁住故障：Codex 族 470 次空转全是这种旧菜单，实际 ${JSON.stringify(r && { state: r.currentState, actionType: r.actionType })}`);
});

t('codex：活菜单（问句紧邻选项）照常 select（84% 有效路径不受损）', () => {
  const r = engine.preAnalyzeStatus(' Do you want to proceed?\n 1. Yes\n 2. No\n', 'codex');
  ok(r && r.actionType === 'select');
});

t('排队消息 + 正常运行：不发 Escape（排队合法，Esc 会打断并丢指令）', () => {
  const screen = '✳ Cooking… (2m 10s · esc to interrupt)\nPress up to edit queued messages\n❯ ';
  const r = engine.preAnalyzeStatus(screen, 'claude');
  ok(r && r.needsAction === false && r.suggestedAction === null,
    `台账实测 3 次有 2 次 Interrupted，实际 ${JSON.stringify(r && { state: r.currentState, action: r.suggestedAction })}`);
  ok(r._rule === 'queued-msgs-wait', '规则 id 要进台账归因');
});

t('排队消息 + Compacting：仍发 Escape 清无效队（原设计意图保留）', () => {
  const screen = '✻ Compacting conversation…\nPress up to edit queued messages\n';
  const r = engine.preAnalyzeStatus(screen, 'claude');
  ok(r && r.suggestedAction === 'Escape' && r._rule === 'queued-msgs-clear',
    `实际 ${JSON.stringify(r && { state: r.currentState, action: r.suggestedAction })}`);
});

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);

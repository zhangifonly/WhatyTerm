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
import { isLiveConfirmMenu } from '../server/services/liveMenu.js';

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

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);

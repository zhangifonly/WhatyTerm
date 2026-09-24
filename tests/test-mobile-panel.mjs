/**
 * 手机上操作终端里的「选项面板」。
 *
 * 由来（截图反馈）：这类面板靠 ↑↓ 移光标、空格勾选、Tab 切分栏，
 * 而移动版只有 1/2/3 按钮 —— 那只对编号菜单有用，对勾选框完全无效，面板根本没法操作。
 *
 * 两条样本都来自实测：single 是真机抓的（已脱敏），multi 照截图逐行复刻。
 *
 * 运行: node tests/test-mobile-panel.mjs
 */

import fs from 'fs';
import { parsePanel, keysForOption, stripAnsi } from '../src/mobile/panelParse.js';

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function test(name, fn) {
  try { fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}
const fx = (n) => fs.readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const SINGLE = fx('panel-single.txt');
const MULTI = fx('panel-multi.txt');

test('单选面板（真机样本）：选项数、光标、问题、每项说明都对', () => {
  const p = parsePanel(SINGLE);
  assert(p.isPanel && p.kind === 'single', JSON.stringify({ isPanel: p.isPanel, kind: p.kind }));
  assert(p.options.length === 5, `选项数 ${p.options.length}`);
  assert(p.options[0].cursor === true && p.options[1].cursor === false, '光标位置错');
  assert(/如何处理这批客户项目遗留文件/.test(p.question), `问题抽错：${p.question}`);
  assert(p.options[0].detail.includes('README.md'), '说明没抽到：' + p.options[0].detail);
  assert(p.options[3].detail === '', '第 4 项本无说明，不该编一个出来');
});

test('多选面板（截图样本）：勾选状态、分栏、无框项都要分清', () => {
  const p = parsePanel(MULTI);
  assert(p.kind === 'multi', p.kind);
  assert(p.hasTabBar === true, '没认出顶部分栏 —— 那样就不会给「切换分栏」按钮');
  assert(p.question === '上架 Google 主要想解决什么？', p.question);
  assert(p.options.length === 6, `选项数 ${p.options.length}`);
  assert(p.options[2].checked === true, '第 3 项 [x] 没识别成已勾选');
  assert(p.options[0].checked === false && p.options[0].hasBox === true, '第 1 项应为未勾选的框');
  // 末尾「Chat about this」没有勾选框，画成 ☐ 会让人以为能勾
  assert(p.options[5].hasBox === false, '无框项被当成勾选框了');
});

test('单选点击 = 直接发编号（不靠光标位置，那一帧可能已经变了）', () => {
  const p = parsePanel(SINGLE);
  assert(JSON.stringify(keysForOption(p, 3)) === JSON.stringify([{ input: '3', label: '选 3' }]),
    JSON.stringify(keysForOption(p, 3)));
});

test('多选点击 = 按光标差值走 ↓/↑ 再空格；已勾选的标注为取消', () => {
  const p = parsePanel(MULTI);   // 光标在第 1 项
  const k3 = keysForOption(p, 3);
  assert(k3.length === 3 && k3[0].input === '\x1b[B' && k3[1].input === '\x1b[B', JSON.stringify(k3));
  assert(k3[2].input === ' ' && k3[2].label === '取消勾选', '第 3 项已勾选，应标注取消：' + JSON.stringify(k3[2]));
  const k4 = keysForOption(p, 4);
  assert(k4.length === 4 && k4[3].label === '勾选', JSON.stringify(k4));
  // 点光标所在那项：不用移动，直接空格
  assert(keysForOption(p, 1).length === 1 && keysForOption(p, 1)[0].input === ' ', JSON.stringify(keysForOption(p, 1)));
});

test('多选里的无框项按编号直接选，不发空格', () => {
  const p = parsePanel(MULTI);
  const k = keysForOption(p, 6);
  assert(k.length === 1 && k[0].input === '6', JSON.stringify(k));
});

test('⚠ 带 ANSI 的屏幕必须照样能认 —— 服务端抓屏用的就是 capture-pane -e', () => {
  // 这是本仓库踩过三次的坑（确认探针/水位/压缩判据）：单测全喂纯文本所以一路绿灯，
  // 真机拿到的却带色码。所以剥离放在模块内部，调用方不可能忘。
  assert(parsePanel(MULTI).isPanel === true, '纯文本要认得出');

  // 色码插在关键词中间（实测 tmux -e 就是这么插的）
  const inWord = MULTI.replace('to navigate', 'to \x1b[2mnavi\x1b[0mgate');
  assert(parsePanel(inWord).isPanel === true, '色码插在提示词中间时失配 —— 真机上就是这种形态');

  // 选项行、勾选框里也可能夹色码
  const inOpts = MULTI
    .replace('❯ 1. [ ]', '\x1b[1m❯\x1b[0m 1. [\x1b[2m \x1b[0m]')
    .replace('3. [x]', '3. [\x1b[32mx\x1b[0m]');
  const p = parsePanel(inOpts);
  assert(p.isPanel && p.options.length === 6, `选项行带色码时解析不出：${p.options.length}`);
  assert(p.options[0].cursor === true, '色码包裹的 ❯ 没认出来');
  assert(p.options[2].checked === true, '色码包裹的 [x] 没认出来');
});

test('stripAnsi 覆盖常见序列，且不吞可见字符', () => {
  assert(stripAnsi('\x1b[31m红\x1b[0m') === '红');
  assert(stripAnsi('\x1b]0;标题\x07正文') === '正文', 'OSC 没剥掉');
  assert(stripAnsi('a\rb') === 'ab', '裸 CR 应去掉（覆写行）');
  assert(stripAnsi('第1行\n第2行') === '第1行\n第2行', '换行不能动，逐行解析依赖它');
  assert(stripAnsi(null) === '' && stripAnsi(undefined) === '', '空值不炸');
});

test('普通屏幕不能误判成面板（否则平白多出一块假面板）', () => {
  const cases = [
    '', '   \n  \n',
    '● 已完成：三个用例全部通过。\n❯ ',
    // 有编号列表但没有面板提示行 —— 那只是它在讲话
    '接下来我会做三件事：\n1. 补测试\n2. 改文档\n3. 提交\n❯ ',
  ];
  for (const c of cases) {
    assert(parsePanel(c).isPanel === false, `误判成面板：${JSON.stringify(c.slice(0, 40))}`);
  }
});

test('只看屏幕尾部：更早的历史面板不该被当成当前面板', () => {
  const old = `${MULTI}\n\n● 好的，已记录。\n❯ \n`.repeat(1);
  // 提示行后面又有新对话 → 那个面板已经答过了。这里放 60 行把它顶出窗口
  const pushedOut = `${MULTI}\n${'● 干活中…\n'.repeat(60)}❯ `;
  assert(parsePanel(pushedOut).isPanel === false, '历史面板被当成当前面板 —— 点了会发错键');
  assert(typeof parsePanel(old).isPanel === 'boolean', '不该抛异常');
});

test('取不到光标位置时不猜（宁可让人用方向键，也不要盲发一串 ↓ 勾错项）', () => {
  const noCursor = MULTI.replace('❯ 1.', '  1.');
  const p = parsePanel(noCursor);
  assert(p.isPanel && p.kind === 'multi', '面板本身还该认出来');
  assert(keysForOption(p, 3).length === 0, '没有光标基准就不该给按键序列');
});

test('空参数与异常输入不炸', () => {
  for (const v of [undefined, null, '', 123, {}]) {
    const p = parsePanel(v);
    assert(p.isPanel === false && Array.isArray(p.options), `炸了或返回怪东西：${JSON.stringify(v)}`);
  }
  assert(keysForOption(null, 1).length === 0 && keysForOption({ isPanel: true, options: [] }, 9).length === 0);
});

// ── 界面守卫 ──────────────────────────────────────────────────────
const PICKER = fs.readFileSync(new URL('../src/mobile/PanelPicker.jsx', import.meta.url), 'utf8');
const QA = fs.readFileSync(new URL('../src/mobile/QuickActions.jsx', import.meta.url), 'utf8');
const DETAIL = fs.readFileSync(new URL('../src/mobile/SessionDetail.jsx', import.meta.url), 'utf8');

test('守卫：认不出面板就整块不渲染（解析是加分项，不能是唯一通路）', () => {
  assert(/if \(!panel\.isPanel\) return null/.test(PICKER), '没有这条早退 —— 会渲染出一块空面板');
});

test('守卫：方向键与空格必须留着当保底通路', () => {
  for (const [k, re] of [['↑', /\\x1b\[A/], ['↓', /\\x1b\[B/], ['空格', /sendRaw\(' ', '空格'\)/]]) {
    assert(re.test(QA), `快捷键条缺 ${k} —— PanelPicker 认不出面板时就彻底没法操作了`);
  }
});

test('守卫：多选面板要给「提交」，分栏面板要给「切换分栏」', () => {
  assert(/kind === 'multi'[\s\S]{0,200}\\r/.test(PICKER), '多选没给回车提交 —— 勾完了交不出去');
  assert(/hasTabBar[\s\S]{0,200}\\t/.test(PICKER), '分栏面板没给 Tab');
});

test('守卫：连发按键之间要有间隔（连发太快 Ink 会并成一次处理，光标走不到位）', () => {
  assert(/KEY_GAP_MS/.test(PICKER) && /setTimeout\(r, KEY_GAP_MS\)/.test(PICKER), '没有按键间隔');
});

test('守卫：PanelPicker 接在详情页里，且拿到 screen', () => {
  assert(/<PanelPicker[^>]*screen=\{screen\}/.test(DETAIL), '没接进详情页或没传屏幕内容');
});

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

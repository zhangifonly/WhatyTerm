/**
 * 自动发送要确认落进输入框；没落进就重试，再不行就标「发送未生效」让人看见。
 *
 * 由来（2026-09-25 WebOffice）：监控发了 12 次「继续」，tmux 全部送达，CLI 一次都没收进去；
 * 熔断后静默停手，界面仍写「发送继续」，停了 4 个多小时没人发现。
 *
 * 运行: node tests/test-input-landing.mjs
 */

import fs from 'fs';
import { pendingCount, landed, sendTextVerified } from '../server/services/inputLanding.js';
import { InputStuckTracker } from '../server/services/inputStuck.js';
import { needsActionIds } from '../src/utils/sessionSort.js';

let pass = 0, fail = 0;
const queue = [];
const test = (name, fn) => queue.push([name, fn]);
const assert = (c, m) => { if (!c) throw new Error(m || '断言失败'); };

const BAR = '──────────\n  ⏵⏵ auto mode on · ← 6 agents\n';
const screen = (input) => `✻ Churned for 5m 34s\n──────────\n❯ ${input}\n${BAR}`;
const DIM = (t) => `\x1b[2m${t}\x1b[0m`;

test('计数：暗色建议文字不算；真打进去的算；认不出提示符返回 -1', () => {
  assert(pendingCount(screen(DIM('继续做家长端')), '继续') === 0, '暗色建议被当成了已输入');
  assert(pendingCount(screen('继续'), '继续') === 1);
  assert(pendingCount(screen('继续继续'), '继续') === 2);
  assert(pendingCount('› 在 codex 里\n', '继续') === -1, 'Codex 提示符不该被认成 Claude 输入框');
});

test('落地判定按「次数变多」：原本就有同样字样的草稿，不能当成这次落地了', () => {
  assert(landed(screen(''), screen('继续'), '继续'));
  assert(!landed(screen('继续'), screen('继续'), '继续'), '草稿里本来就有「继续」，打字没落地却判成落地');
  assert(landed(screen(DIM('继续')), screen('继续'), '继续'), '建议文字恰好是「继续」、打进去替换了它 —— 应判落地');
});

/** 假终端：typeText 按计划决定这次打字有没有落进输入框 */
function fakeTerm(plan, start = '') {
  let input = start;
  const log = [];
  let n = 0;
  return {
    log,
    typeText: (t) => { log.push(`type:${t}`); if (plan[n++]) input = input.replace(/\x1b\[[0-9;]*m/g, '').replace(/^继续做家长端$/, '') + t; },
    pressEnter: () => { log.push('enter'); },
    capture: async () => screen(input),
    sleep: async () => {},
  };
}

test('第一次就落地：只打一次字、按一次回车', async () => {
  const t = fakeTerm([true]);
  const r = await sendTextVerified({ text: '继续', ...t });
  assert(r.landed === true && r.attempts === 1 && t.log.join() === 'type:继续,enter', t.log.join());
});

test('第一次没落地、重打一次落地了：按回车，记 2 次', async () => {
  const t = fakeTerm([false, true]);
  const r = await sendTextVerified({ text: '继续', ...t });
  assert(r.landed === true && r.attempts === 2 && t.log.join() === 'type:继续,type:继续,enter', t.log.join());
});

test('两次都没落地：绝不按回车，返回未落地（WebOffice 的情形）', async () => {
  const t = fakeTerm([false, false]);
  const r = await sendTextVerified({ text: '继续', ...t });
  assert(r.landed === false && r.attempts === 2 && !t.log.includes('enter'), t.log.join());
});

test('认不出输入框（Codex/Grok）：照旧打字后回车，不能因为核对不了就卡死', async () => {
  const log = [];
  const r = await sendTextVerified({ text: '继续', typeText: () => log.push('type'), pressEnter: () => log.push('enter'),
    capture: async () => '› codex\n', sleep: async () => {} });
  assert(r.landed === null && log.join() === 'type,enter', log.join());
});

test('标记表：同原因不重复广播、since 保留首次；CLI 跑起来才解除，屏幕哈希变了不解除', () => {
  const emitted = [];
  let now = 1000;
  const tr = new InputStuckTracker({ onChange: (a) => emitted.push(a), now: () => now });
  tr.set('s1', '没进输入框');
  now = 5000; tr.set('s1', '没进输入框');
  assert(emitted.length === 1, '同样的原因重复广播');
  tr.set('s1', '台账连续无效果', 'ledger');
  assert(tr.all().s1.since === 1000 && emitted.length === 2, 'since 应保留第一次标记的时间');
  tr.refresh('s1', screen('') + '状态栏数字变了 7 agents');
  assert(tr.has('s1'), '只是屏幕变了（状态栏跳动）就解除了 —— 标记会一闪就没');
  tr.refresh('s1', '✻ Working… (3s · esc to interrupt)');
  assert(!tr.has('s1') && emitted.length === 3, 'CLI 跑起来了应解除并广播');
});

test('发送未生效算「需要你看一眼」，哪怕 AI 状态写着一切正常、自动操作开着', () => {
  const sessions = [{ id: 'W', autoActionEnabled: true }, { id: 'X', autoActionEnabled: true }];
  const st = { W: { needsAction: true, actionType: 'text_input', currentState: '检测到等待输入状态，发送"继续"指令' }, X: {} };
  const n = needsActionIds(sessions, st, [], { W: { reason: '没进输入框' } });
  assert(n.has('W') && !n.has('X'), [...n].join());
  assert(needsActionIds(sessions, st).size === 0, '不传标记表时行为不变');
});

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const SRV = strip(fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8'));
test('接线：两条文本发送路径都走核对发送；台账停手时也标记；每轮抓屏检查解除；连上即推', () => {
  // 规则路径、AI 缓存路径、AI 分析路径三处文本发送
  assert((SRV.match(/sendTextWithLanding\(session, action\)/g) || []).length === 3, '有文本发送路径没走核对');
  assert(!/session\.sendInput\(action, \{ submit: true \}\)/.test(SRV), '还有不核对的直接发送');
  assert(/if \(paused\) \{\s*inputStuck\.set\(sessionId, paused, 'ledger'\)/.test(SRV), '台账停手没标记，又会静默停住');
  assert(/inputStuck\.refresh\(sessionData\.id, quickContent\)/.test(SRV), '每轮没检查解除');
  assert(/socket\.emit\('sessions:inputStuck', inputStuck\.all\(\)\)/.test(SRV), '新连上的客户端看不到已有标记');
  assert(/capture-pane -e -p/.test(SRV.slice(SRV.indexOf('function captureNow'))), '核对抓屏没带颜色码，分不出暗色建议文字');
});

test('界面：桌面有「发送未生效」提示条和面板说明，手机卡片与排序同样认', () => {
  const app = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert(/个发送未生效/.test(app) && /inputStuckMap\[currentSession\.id\] \?/.test(app), '桌面没显示');
  const list = fs.readFileSync(new URL('../src/mobile/SessionList.jsx', import.meta.url), 'utf8');
  assert(/needsActionIds\(sessions, aiStatusMap, longRunTasks, inputStuck\)/.test(list) && /stuck=\{inputStuck\[s\.id\]/.test(list), '手机没接');
});

for (const [name, fn] of queue) {
  try { await fn(); pass++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n    ${e.message}`); }
}
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);

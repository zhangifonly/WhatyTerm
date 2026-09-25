/**
 * 会话列表排序 —— 桌面与移动**共用**的那一份纯逻辑。
 *
 * 为什么抽出来：两端各写一份的实测后果（2026-09-21 检查发现）——
 * 桌面是「置顶 → 排序模式 → 门牌号」三层，移动版只有「needsAction」一层，
 * 且那一层的口径只覆盖三类中的一类（漏了"屏上挂确认菜单"和"任务报错"，
 * 恰恰是最该先看的两类）。同一批会话在手机与电脑上顺序完全不同。
 *
 * 运行: node tests/test-session-sort.mjs
 */

import fs from 'fs';
import {
  SORT_MODES, SORT_LABELS, DEFAULT_SORT, nextSortMode, sessionNumbers, needsActionIds, orderSessions, longRunWaitingIds, autoRunIds,
} from '../src/utils/sessionSort.js';
import { SORT_MODES as SERVER_SORT_MODES, normalizePrefs } from '../server/services/uiPrefs.js';

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function test(name, fn) {
  try { fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}

// 创建顺序 a→b→c→d，活跃顺序 d→c→b→a（刻意相反，能区分两种模式）
const S = [
  { id: 'a', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-04T00:00:00Z' },
  { id: 'b', createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-03T00:00:00Z' },
  { id: 'c', createdAt: '2026-01-03T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' },
  { id: 'd', createdAt: '2026-01-04T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
];
const ids = (list) => list.map((s) => s.id).join('');

test('门牌号按创建时间升序，1 起；创建时间相同用 id 兜底', () => {
  const n = sessionNumbers(S);
  assert(n.a === 1 && n.b === 2 && n.c === 3 && n.d === 4, JSON.stringify(n));
  const same = [{ id: 'z', createdAt: 'x' }, { id: 'y', createdAt: 'x' }];
  const n2 = sessionNumbers(same);
  assert(n2.y === 1 && n2.z === 2, '创建时间相同要按 id 定序，否则列表会随推送跳动');
});

test('固定顺序 = 门牌号顺序（默认模式）', () => {
  assert(DEFAULT_SORT === 'fixed', DEFAULT_SORT);
  assert(ids(orderSessions({ sessions: [...S].reverse(), sortMode: 'fixed' })) === 'abcd', '应回到创建顺序');
});

test('最近活跃：新的在前', () => {
  assert(ids(orderSessions({ sessions: S, sortMode: 'active' })) === 'abcd', 'a 的 updatedAt 最新');
  const shuffled = [S[2], S[0], S[3], S[1]];
  assert(ids(orderSessions({ sessions: shuffled, sortMode: 'active' })) === 'abcd', '与输入顺序无关');
});

test('待处理优先：需操作的在前，同档内仍按门牌号', () => {
  const need = new Set(['c', 'd']);
  assert(ids(orderSessions({ sessions: S, sortMode: 'pending', needIds: need })) === 'cdab', 'cd 应置前且保持门牌序');
});

test('置顶永远在最前，压过任何排序模式', () => {
  for (const mode of SORT_MODES) {
    const out = ids(orderSessions({ sessions: S, sortMode: mode, pinnedIds: ['d'], needIds: new Set(['a']) }));
    assert(out[0] === 'd', `${mode} 模式下置顶没排最前：${out}`);
  }
  // 多个置顶之间仍按门牌号，保证确定
  const out = ids(orderSessions({ sessions: S, pinnedIds: ['d', 'b'], sortMode: 'fixed' }));
  assert(out.startsWith('bd'), `多个置顶应按门牌号：${out}`);
});

test('同档内一律按门牌号兜底 —— 没有它列表会随增量推送无规律跳动', () => {
  // 三条都不需操作、活跃时间相同：只能靠门牌号定序
  const same = S.map((s) => ({ ...s, updatedAt: '2026-01-09T00:00:00Z' }));
  for (const mode of SORT_MODES) {
    assert(ids(orderSessions({ sessions: [...same].reverse(), sortMode: mode })) === 'abcd', `${mode} 没有确定性兜底`);
  }
});

test('needsAction 三类合一：等确认 / 报错 / 空闲等继续，与桌面红点同源', () => {
  const sessions = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const st = {
    a: { actionType: 'select' },                                  // 屏上挂确认菜单
    b: { actionType: 'error' },                                   // 任务报错
    c: { needsAction: true, actionType: 'text_input' },            // 空闲等继续
    d: { needsAction: false },                                     // 没事
  };
  const n = needsActionIds(sessions, st);
  assert(n.has('a') && n.has('b') && n.has('c'), `三类都要算：${[...n]}`);
  assert(!n.has('d'), '没事的不该算');
});

test('自动操作开着的「空闲等继续」不算需操作（它自己会处理）', () => {
  const sessions = [{ id: 'a', autoActionEnabled: true }, { id: 'b', autoActionEnabled: false }];
  const st = { a: { needsAction: true }, b: { needsAction: true } };
  const n = needsActionIds(sessions, st);
  assert(!n.has('a') && n.has('b'), `自动操作开着的不该置前：${[...n]}`);
});

test('等确认与报错**不受**自动操作开关影响（屏上真挂着东西要人看）', () => {
  const sessions = [{ id: 'a', autoActionEnabled: true }, { id: 'b', autoActionEnabled: true }];
  const st = { a: { actionType: 'select' }, b: { actionType: 'error' } };
  const n = needsActionIds(sessions, st);
  assert(n.has('a') && n.has('b'), '这两类与自动操作无关，漏了就在手机上看不到最该看的会话');
});

test('长程在等你算需操作 —— 长程条目不经过 AI 监控，只看 aiStatusMap 它是隐形的', () => {
  const sessions = [
    { id: 'L', runMode: 'longrun' },     // 长程，等你
    { id: 'R', runMode: 'longrun' },     // 长程，在跑但没等你
    { id: 'D', runMode: 'longrun' },     // 长程，已收工
    { id: 'T', runMode: 'terminal' },    // 普通会话
  ];
  const tasks = [
    { sessionId: 'L', state: 'running', awaitingHuman: true },
    { sessionId: 'R', state: 'running', awaitingHuman: false },
    { sessionId: 'D', state: 'done', awaitingHuman: true },      // 收工后残留的标志不该算
    { sessionId: 'T', state: 'running', awaitingHuman: true },   // 条目不是长程模式，不该算
  ];
  const w = longRunWaitingIds(sessions, tasks);
  assert([...w].join() === 'L', `只有 L 在等你：${[...w]}`);
  const n = needsActionIds(sessions, {}, tasks);
  assert(n.has('L'), 'aiStatusMap 为空时长程等你也必须算进去');
  // 待处理优先下它要排到最前
  const order = orderSessions({ sessions, sortMode: 'pending', needIds: n }).map((x) => x.id);
  assert(order[0] === 'L', `长程等你没排最前：${order}`);
});

test('自动运行的判定：自动操作开着，或长程正在跑；长程收工后不算', () => {
  const sessions = [
    { id: 'A', autoActionEnabled: true },                  // 终端会话，自动操作开
    { id: 'M' },                                           // 终端会话，自动操作关
    { id: 'L', runMode: 'longrun' },                       // 长程在跑
    { id: 'D', runMode: 'longrun', autoActionEnabled: true },  // 长程已收工：开关残留也不算
  ];
  const tasks = [{ sessionId: 'L', state: 'running' }, { sessionId: 'D', state: 'done' }];
  assert([...autoRunIds(sessions, tasks)].sort().join() === 'A,L', [...autoRunIds(sessions, tasks)].join());
  assert(autoRunIds(null, null).size === 0, '空参数不炸');
});

test('自动运行优先：自动运行的在前、其余在后，两组内各按门牌号；置顶仍压过一切', () => {
  const autoIds = new Set(['d', 'b']);
  assert(ids(orderSessions({ sessions: S, sortMode: 'auto', autoIds })) === 'bdac', ids(orderSessions({ sessions: S, sortMode: 'auto', autoIds })));
  assert(ids(orderSessions({ sessions: S, sortMode: 'auto', autoIds, pinnedIds: ['c'] })) === 'cbda', '置顶要在最前');
  // 不传 autoIds 时按会话自带的开关现算（老调用方/测试桩不用额外准备）
  const withFlag = S.map((x) => ({ ...x, autoActionEnabled: x.id === 'c' }));
  assert(ids(orderSessions({ sessions: withFlag, sortMode: 'auto' })) === 'cabd', '缺省应按 autoActionEnabled 分组');
});

test('新模式能存进偏好：服务端的模式清单与前端一致（否则刷新就被打回固定顺序）', () => {
  assert(JSON.stringify(SERVER_SORT_MODES) === JSON.stringify(SORT_MODES), `前端 ${SORT_MODES} / 服务端 ${SERVER_SORT_MODES}`);
  assert(normalizePrefs({ sessionSort: 'auto' }).sessionSort === 'auto', '服务端把 auto 当非法值丢掉了');
  for (const m of SORT_MODES) assert(SORT_LABELS[m], `模式 ${m} 没有显示文字`);
});

test('不传长程任务时行为不变（老调用方不受影响）', () => {
  assert(needsActionIds([{ id: 'a' }], { a: { needsAction: true } }).has('a'));
  assert(longRunWaitingIds().size === 0 && longRunWaitingIds(null, null).size === 0, '空参数不炸');
});

test('模式循环：固定 → 活跃 → 待处理 → 自动运行 → 固定；非法值回到固定', () => {
  assert(nextSortMode('fixed') === 'active' && nextSortMode('active') === 'pending'
    && nextSortMode('pending') === 'auto' && nextSortMode('auto') === 'fixed', '循环顺序错');
  assert(nextSortMode('乱写') === 'fixed' && nextSortMode(undefined) === 'fixed', '非法值要有兜底');
});

test('空输入不炸（首屏 sessions 还没到时会以空数组调用）', () => {
  assert(orderSessions().length === 0 && orderSessions({ sessions: null }).length === 0);
  assert(Object.keys(sessionNumbers()).length === 0 && needsActionIds().size === 0);
  assert(needsActionIds([{ id: 'a' }], null).size === 0, 'aiStatusMap 为空时不该算需操作');
});

test('不改动入参数组（React 里就地排序会让 memo 判不出变化）', () => {
  const input = [...S];
  const snapshot = ids(input);
  orderSessions({ sessions: input, sortMode: 'active' });
  assert(ids(input) === snapshot, '原数组被就地排序了');
});

// ── 接线守卫：两端都必须用这一份 ──────────────────────────────────
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

test('守卫：桌面的「待处理优先」与「长程等你摘要条」都用共享的 longRunWaitingIds', () => {
  const app = read('../src/App.jsx');
  const uses = app.split('longRunWaitingIds(').length - 1;
  assert(uses >= 2, `桌面只有 ${uses} 处用了共享判定 —— 排序与摘要条应各一处，否则两处定义会分叉`);
  assert(!/x\.runMode === 'longrun'\s*\n?\s*&& longRun\.taskForSession/.test(app), '摘要条又在自己写判定');
});

test('守卫：两端都把长程任务交给 autoRunIds、按钮文字取共享 SORT_LABELS', () => {
  const app = read('../src/App.jsx');
  const list = read('../src/mobile/SessionList.jsx');
  assert(/autoIds: autoRunIds\(sessions, longRun\.tasks\)/.test(app), '桌面没算自动运行集合（长程会被当成不自动运行）');
  assert(/autoIds: autoRunIds\(sessions, longRunTasks\)/.test(list), '移动版没算自动运行集合');
  assert(/SORT_LABELS\[sortMode\]/.test(app) && !/sortMode === 'fixed' \? '固定顺序'/.test(app), '桌面按钮文字又自己写了一份');
});

test('守卫：桌面与移动都从共享模块取排序，不各写一份', () => {
  const app = read('../src/App.jsx');
  const list = read('../src/mobile/SessionList.jsx');
  for (const [name, src] of [['桌面 App.jsx', app], ['移动 SessionList.jsx', list]]) {
    assert(/sessionSort/.test(src), `${name} 没用共享排序模块 —— 两端会再次漂移`);
  }
  // 移动版不许再留自己那套一层排序
  assert(!/const sorted = \[\.\.\.sessions\]\.sort\(/.test(list),
    '移动版仍在本地 sort —— 那正是两端顺序对不上的原因');
});

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

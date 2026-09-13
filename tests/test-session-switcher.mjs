/**
 * 会话快速切换测试（序号 + ⌘K 搜索 + 待处理跳转）
 *
 * 背景：35 个活跃会话，侧栏 280px 每项约 70px → 一屏只放得下 8~9 个，靠滚找不现实。
 * 「门牌号」的核心约束：序号钉在会话上，切换显示排序时跟着会话走、不重排 ——
 * 否则 ⌘1 今天是 A 明天是 B，肌肉记忆无法积累。
 */
import fs from 'node:fs';
import PinyinMatch from 'pinyin-match';

const results = { passed: 0, failed: 0, errors: [] };
const pending = [];
function test(name, fn) {
  const p = (async () => {
    try { await fn(); results.passed++; console.log(`✅ ${name}`); }
    catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
  })();
  pending.push(p);
  return p;
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }

const APP = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const SM = fs.readFileSync(new URL('../server/services/SessionManager.js', import.meta.url), 'utf8');

// ---------- ① 门牌号必须稳定：不随显示排序变 ----------
// 复刻 App.jsx 的两段逻辑（序号按 createdAt 编号；显示顺序另算）
const numbering = (sessions) => {
  const sorted = [...sessions].sort((a, b) => {
    const ta = new Date(a.createdAt || 0).getTime();
    const tb = new Date(b.createdAt || 0).getTime();
    if (ta !== tb) return ta - tb;
    return String(a.id).localeCompare(String(b.id));
  });
  const map = {};
  sorted.forEach((s, i) => { map[s.id] = i + 1; });
  return map;
};
const ordering = (sessions, { pinned = new Set(), mode = 'fixed', needs = new Set() } = {}) => {
  const num = numbering(sessions);
  return [...sessions].sort((a, b) => {
    const pa = pinned.has(a.id) ? 0 : 1, pb = pinned.has(b.id) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    if (mode === 'active') {
      const ta = new Date(a.updatedAt || a.createdAt || 0).getTime();
      const tb = new Date(b.updatedAt || b.createdAt || 0).getTime();
      if (ta !== tb) return tb - ta;
    } else if (mode === 'pending') {
      const na = needs.has(a.id) ? 0 : 1, nb = needs.has(b.id) ? 0 : 1;
      if (na !== nb) return na - nb;
    }
    return num[a.id] - num[b.id];
  });
};

const FIX = [
  { id: 'a', name: 'Alpha', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-09-04T10:00:00Z' },
  { id: 'b', name: 'Beta',  createdAt: '2026-08-02T00:00:00Z', updatedAt: '2026-09-04T12:00:00Z' },
  { id: 'c', name: 'Gamma', createdAt: '2026-08-03T00:00:00Z', updatedAt: '2026-09-04T08:00:00Z' },
];

test('门牌号按 createdAt 编号（1 号是最早创建的）', () => {
  const n = numbering(FIX);
  assert(n.a === 1 && n.b === 2 && n.c === 3, `编号错: ${JSON.stringify(n)}`);
});
test('门牌号不随输入数组顺序变（socket 增量更新会打乱顺序）', () => {
  const shuffled = [FIX[2], FIX[0], FIX[1]];
  const n1 = numbering(FIX), n2 = numbering(shuffled);
  assert(JSON.stringify(n1) === JSON.stringify(n2), '数组顺序变了编号就变，门牌号不稳定');
});
test('切到「最近活跃」排序：显示顺序变，门牌号不变', () => {
  const n = numbering(FIX);
  const shown = ordering(FIX, { mode: 'active' }).map(s => s.id);
  assert(shown.join('') === 'bac', `最近活跃顺序错: ${shown}`);
  const n2 = numbering(FIX);
  assert(n2.a === n.a && n2.b === n.b && n2.c === n.c, '排序模式改变了门牌号');
});
test('切到「待处理优先」：待办排前，门牌号仍不变', () => {
  const shown = ordering(FIX, { mode: 'pending', needs: new Set(['c']) }).map(s => s.id);
  assert(shown[0] === 'c', `待处理未排到最前: ${shown}`);
  assert(numbering(FIX).c === 3, '待处理排序改变了门牌号');
});
test('置顶：排到最前但保留自己的门牌号', () => {
  const shown = ordering(FIX, { pinned: new Set(['c']) }).map(s => s.id);
  assert(shown[0] === 'c', `置顶未排到最前: ${shown}`);
  assert(numbering(FIX).c === 3, '置顶改变了门牌号');
});
test('createdAt 相同时用 id 兜底，编号不抖', () => {
  const dup = [
    { id: 'z', createdAt: '2026-08-01T00:00:00Z' },
    { id: 'a', createdAt: '2026-08-01T00:00:00Z' },
  ];
  const n1 = numbering(dup), n2 = numbering([dup[1], dup[0]]);
  assert(JSON.stringify(n1) === JSON.stringify(n2), 'createdAt 相同时编号不确定');
  assert(n1.a === 1, 'id 兜底应按字典序');
});

// ---------- ② 模糊搜索：子序列匹配（输 wtx 命中 WebTmux）----------
const fuzzyScore = (text, query) => {
  if (!query) return 0;
  const t = String(text || '').toLowerCase(), q = query.toLowerCase();
  if (t.includes(q)) return 1000 - t.indexOf(q);
  let ti = 0, hits = 0, lastHit = -1, bonus = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return -1;
    if (lastHit >= 0 && found === lastHit + 1) bonus += 3;
    if (found === 0 || /[^a-z0-9]/.test(t[found - 1])) bonus += 5;
    lastHit = found; ti = found + 1; hits++;
  }
  return hits * 2 + bonus;
};

test('搜索：连续子串命中且分数最高（rust → RustCandance）', () => {
  assert(fuzzyScore('RustCandance', 'rust') > 0, 'rust 应命中 RustCandance');
  assert(fuzzyScore('RustCandance', 'rust') > fuzzyScore('RustCandance', 'rc'),
    '连续匹配应比缩写分数高');
});
test('搜索：首字母缩写命中（wtx → WebTmux，纯 includes 做不到）', () => {
  assert(fuzzyScore('WebTmux', 'wtx') > 0, 'wtx 应命中 WebTmux');
  assert(!'webtmux'.includes('wtx'), '前提：includes 确实匹配不上，所以必须子序列');
});
test('搜索：匹配不上的返回 -1（不能全部命中）', () => {
  assert(fuzzyScore('WebTmux', 'zzz') === -1, 'zzz 不该命中 WebTmux');
  assert(fuzzyScore('cadance', 'xyz') === -1);
});
test('搜索：真实会话名集合里能唯一定位', () => {
  const names = ['AIPsychology', 'AetherEDA', 'BiologyintheAIEra', 'ChemAIForge', 'GigaPlace_Engine',
    'MBTITest', 'MBTIWriter', 'RustCandance', 'WebOffice', 'WebTmux', 'cadance', 'mathviz', 'phyviz'];
  const top = (q) => names.map(n => ({ n, s: fuzzyScore(n, q) }))
    .filter(x => x.s > -1).sort((a, b) => b.s - a.s)[0]?.n;
  assert(top('cadance') === 'cadance', `cadance → ${top('cadance')}`);
  assert(top('phy') === 'phyviz', `phy → ${top('phy')}`);
  assert(top('giga') === 'GigaPlace_Engine', `giga → ${top('giga')}`);
});
test('搜索：MBTITest 与 MBTIWriter 能被后续字符区分', () => {
  assert(fuzzyScore('MBTITest', 'mbtit') > fuzzyScore('MBTIWriter', 'mbtit'), 'mbtit 应偏向 MBTITest');
  assert(fuzzyScore('MBTIWriter', 'mbtiw') > fuzzyScore('MBTITest', 'mbtiw'), 'mbtiw 应偏向 MBTIWriter');
});

// ---------- ③ 快捷键必须从 xterm 放行，否则会被当输入发给 CLI ----------
// ⌘1 若被 xterm 吞掉，等于往 Claude 输入框打个 "1" —— 那正好是确认菜单的选项 1。
test('xterm 按键处理器放行 ⌘K / ⌘↓ / ⌘1~9', () => {
  const i = APP.indexOf('attachCustomKeyEventHandler');
  assert(i > 0, '找不到 xterm 按键处理器');
  const block = APP.slice(i, i + 1200);
  assert(/metaKey \|\| e\.ctrlKey/.test(block), '未同时兼顾 mac 的 ⌘ 和 Win/Linux 的 Ctrl');
  assert(/ArrowDown/.test(block) && /\[1-9\]/.test(block) && /'k'/.test(block),
    '⌘K / ⌘↓ / ⌘1~9 未全部放行，会被当终端输入');
});
test('全局快捷键监听已注册并会 preventDefault', () => {
  assert(/window\.addEventListener\('keydown'/.test(APP), '缺少全局 keydown 监听');
  const i = APP.indexOf("window.addEventListener('keydown'");
  const block = APP.slice(Math.max(0, i - 1800), i);
  assert(/e\.preventDefault\(\)/.test(block), '快捷键未阻止默认行为（⌘1 会触发浏览器切标签页）');
});

// ---------- ④ 服务端排序：门牌号稳定的地基 ----------
test('服务端会话恢复带 ORDER BY created_at（否则重启后门牌号会变）', () => {
  assert(/FROM sessions WHERE status = \? ORDER BY created_at/.test(SM),
    '恢复查询缺 ORDER BY，listSessions 的 Map 插入顺序不稳定');
});


// ---------- ⑤ 双编号：门牌号按创建序钉死，快捷键位按置顶顺序单独发 ----------
// 实测动因：按创建序，⌘1~⌘9 全落在 2026-08-03 创建的老会话上（AetherEDA…），
// 而常用的 WebTmux / cadance 排 28 位之后，用门牌号绑快捷键等于浪费 9 个键位。
const slots = (pinnedOrder, sessions) => {
  const map = {};
  pinnedOrder.filter(id => sessions.some(s => s.id === id)).slice(0, 9)
    .forEach((id, i) => { map[id] = i + 1; });
  return map;
};

test('快捷键位：按置顶顺序发，先置顶的拿 ⌘1', () => {
  const sl = slots(['c', 'a'], FIX);
  assert(sl.c === 1 && sl.a === 2, `键位错: ${JSON.stringify(sl)}`);
  assert(sl.b === undefined, '未置顶的不该有键位');
});
test('快捷键位与门牌号互不影响（改置顶后门牌号不动）', () => {
  const before = numbering(FIX);
  const sl = slots(['c'], FIX);
  const after = numbering(FIX);
  assert(sl.c === 1, '置顶项应拿 ⌘1');
  assert(after.c === 3 && after.c === before.c, '置顶改变了门牌号');
});
test('快捷键位：已关闭的置顶项不占位', () => {
  const sl = slots(['gone', 'a'], FIX);
  assert(sl.a === 1, `已关闭会话占了位: ${JSON.stringify(sl)}`);
});
test('快捷键位最多 9 个（⌘1~⌘9）', () => {
  const many = Array.from({length:12},(_,i)=>({id:'s'+i,createdAt:'2026-08-0'+(i%9+1)+'T00:00:00Z'}));
  const sl = slots(many.map(s=>s.id), many);
  assert(Object.keys(sl).length === 9, `应只发 9 个键位，实际 ${Object.keys(sl).length}`);
});
test('实现里快捷键走 hotkeySlots 而非 sessionNumbers', () => {
  const i = APP.indexOf("if (/^[1-9]$/.test(e.key))");
  assert(i > 0, '找不到数字键处理');
  const block = APP.slice(i, i + 500);
  assert(/hotkeySlots/.test(block), '数字键仍绑门牌号，会浪费在从不切的老会话上');
  assert(!/sessionNumbers\[s\.id\] === Number/.test(block), '残留按门牌号匹配的旧逻辑');
});


// ---------- ⑥ 拼音搜索：中文首字母 / 全拼 ----------
// 动因：实测 35 个会话**名字全是英文**，但**目标与项目说明全含中文**
//（心镜 / 星鉴 / 可监可控 / 论文写作），那才是脑子里记住会话的方式。
// 上面的子序列匹配对汉字完全无能（汉字进不了 a-z 字符流）。
const pinyinHit = (text, query) => {
  if (!text || !query) return false;
  if (!/[一-龥]/.test(text)) return false;
  try { return !!PinyinMatch.match(text, query); } catch { return false; }
};

test('拼音：首字母命中（sxzm → 数学之美）', () => {
  assert(pinyinHit('数学之美 - 交互式数学可视化实验平台', 'sxzm'), 'sxzm 应命中数学之美');
  assert(pinyinHit('物理之美 - 交互式物理可视化实验平台', 'wlzm'), 'wlzm 应命中物理之美');
});
test('拼音：全拼命中（shuxue / xingjian）', () => {
  assert(pinyinHit('数学之美', 'shuxue'), '全拼应命中');
  assert(pinyinHit('✦ 星鉴 StellarForge - AI 原生的情报分析', 'xingjian'), '星鉴全拼应命中');
});
test('拼音：不该跨词误命中（sxzm 不命中物理之美）', () => {
  assert(!pinyinHit('物理之美', 'sxzm'), '物理之美不该被 sxzm 命中');
  assert(!pinyinHit('数学之美', 'wlzm'), '数学之美不该被 wlzm 命中');
});
test('拼音：中英混排里首字母跨英文也能命中（ymjs → 沂蒙精神AR…）', () => {
  assert(pinyinHit('沂蒙精神AR沉浸式大思政课堂', 'ymjs'), 'ymjs 应命中沂蒙精神');
});
test('拼音：纯英文文本直接跳过（省开销，且不与子序列冲突）', () => {
  assert(!pinyinHit('WebTmux', 'wtx'), '纯英文应交给子序列匹配，不走拼音');
  assert(fuzzyScore('WebTmux', 'wtx') > 0, '子序列仍要能命中 WebTmux');
});
test('拼音：空值不抛错', () => {
  assert(pinyinHit('', 'abc') === false);
  assert(pinyinHit('数学之美', '') === false);
  assert(pinyinHit(null, 'sx') === false);
});
test('搜索范围包含 goal 和 projectDesc（否则拼音没有可匹配文本）', () => {
  const i = APP.indexOf('const switcherResults');
  assert(i > 0, '找不到搜索逻辑');
  const block = APP.slice(i, i + 2200);
  assert(/s\.goal/.test(block), '搜索未覆盖 goal —— 中文关键词都在那里');
  assert(/s\.projectDesc/.test(block), '搜索未覆盖 projectDesc');
  assert(/pinyinHit/.test(block), '搜索未接入拼音匹配');
});
test('依赖已锁确切版本（pinyin-match，非 pinyin-pro）', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const v = pkg.dependencies['pinyin-match'];
  assert(v, '未声明 pinyin-match 依赖');
  assert(/^\d/.test(v), `版本应锁定不带范围符，实际 ${v}`);
  assert(!pkg.dependencies['pinyin-pro'], '不应同时引入 pinyin-pro（实测误命中更多、体积翻倍）');
});


// ---------- ⑦ 待办分类：needsAction ≠ 等确认 ----------
// 实测踩过的坑：拿 needsAction 当「N 个等确认」，实测 35 会话里 17 个 needsAction=true
// 而其中 **0 个**是确认界面（8×Claude空闲 / 6×发继续 / 2×Grok空闲 / 1×编译错误）。
// 用户点进去只是个空闲会话，什么都不用确认 —— 文案谎报，功能反而误导。
const classify = (sessions, statusMap) => {
  const conf = new Set(), err = new Set(), idle = new Set();
  for (const ses of sessions) {
    const st = statusMap[ses.id]; if (!st) continue;
    if (st.actionType === 'select' || st.actionType === 'confirm') conf.add(ses.id);
  }
  for (const ses of sessions) {
    const st = statusMap[ses.id]; if (!st || conf.has(ses.id)) continue;
    if (st.actionType === 'error' || (st.requireConfirmation && st.actionType !== 'text_input')) err.add(ses.id);
  }
  for (const ses of sessions) {
    const st = statusMap[ses.id];
    if (!st?.needsAction || ses.autoActionEnabled) continue;
    if (conf.has(ses.id) || err.has(ses.id)) continue;
    idle.add(ses.id);
  }
  return { conf, err, idle };
};

test('待办分类：空闲发「继续」不算等确认（这是原缺陷）', () => {
  const ses = [{ id: 'a', autoActionEnabled: false }];
  const sm = { a: { needsAction: true, actionType: 'text_input', suggestedAction: '继续', currentState: 'Claude Code空闲' } };
  const { conf, idle } = classify(ses, sm);
  assert(conf.size === 0, '空闲发继续被误判成等确认 —— 点进去无事可做');
  assert(idle.has('a'), '应归入待推进');
});
test('待办分类：选项面板才算等确认', () => {
  const ses = [{ id: 'a', autoActionEnabled: false }];
  const sm = { a: { needsAction: true, actionType: 'select', suggestedAction: '2' } };
  const { conf, idle } = classify(ses, sm);
  assert(conf.has('a'), '选项面板应算等确认');
  assert(!idle.has('a'), '不该重复计入待推进');
});
test('待办分类：报错单独一档，不并进等确认', () => {
  const ses = [{ id: 'a', autoActionEnabled: false }];
  const sm = { a: { needsAction: false, actionType: 'error', requireConfirmation: true } };
  const { conf, err } = classify(ses, sm);
  assert(!conf.has('a'), '报错不是「屏上有面板等按键」，不该混进等确认');
  assert(err.has('a'), '应归入出错待处理');
});
test('待办分类：自动操作开着的空闲会话不计入（它自己会处理）', () => {
  const ses = [{ id: 'a', autoActionEnabled: true }];
  const sm = { a: { needsAction: true, actionType: 'text_input', suggestedAction: '继续' } };
  const { conf, err, idle } = classify(ses, sm);
  assert(conf.size === 0 && err.size === 0 && idle.size === 0, '自动操作开着不该报待办');
});
test('待办分类：三档互斥，同一会话只进一档', () => {
  const ses = [{ id: 'a', autoActionEnabled: false }];
  const sm = { a: { needsAction: true, actionType: 'select', requireConfirmation: true } };
  const { conf, err, idle } = classify(ses, sm);
  const n = (conf.has('a') ? 1 : 0) + (err.has('a') ? 1 : 0) + (idle.has('a') ? 1 : 0);
  assert(n === 1, `同一会话进了 ${n} 档，计数会重复`);
});
test('实现里等确认判据不含裸 needsAction', () => {
  const i = APP.indexOf('const awaitingConfirmIds');
  assert(i > 0, '找不到等确认判据');
  const block = APP.slice(i, i + 600);
  assert(/actionType === 'select'/.test(block), '未按选项面板判定');
  assert(!/st\.needsAction/.test(block), '等确认判据仍在看 needsAction —— 会谎报');
});

await Promise.all(pending);
console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

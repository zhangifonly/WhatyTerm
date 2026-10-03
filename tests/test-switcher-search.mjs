/**
 * ⌘K 搜索：运行中的会话 + 历史（src/utils/switcherSearch.js）
 *   ① 历史命中也列出来，运行中的始终排前面——哪怕历史那条的匹配分更高
 *   ② 已经开着（同目录、同 CLI）的项目不在历史里重复；同目录不同 CLI 照列
 *   ③ 已关闭会话与历史项目指向同一处时只留已关闭会话
 *   ④ 不输入只列运行中的；门牌号只认运行中的
 *   ⑤ 中文拼音能搜到历史项目的说明；历史条数有上限，同分时最近用过的在前
 */
import { searchSwitcher, HISTORY_LIMIT } from '../src/utils/switcherSearch.js';

let pass = 0, fail = 0;
const test = (n, fn) => { try { fn(); pass++; console.log(`✅ ${n}`); } catch (e) { fail++; console.log(`❌ ${n}\n    ${e.message}`); } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); };
const label = (r) => r.map((x) => (x.kind === 'session' ? `S:${x.s.name}` : x.kind === 'project' ? `P:${x.p.name}:${x.p.aiType}` : `C:${x.c.name}`));

const sessions = [
  { id: 'a', name: 'WebTmuxNotes', workingDir: '/w/notes', aiType: 'claude' },
  { id: 'b', name: 'iSpring', workingDir: '/w/iSpring', aiType: 'codex', goal: '逆向课件格式' },
];
const numbers = { a: 1, b: 2 };
const projects = [
  { name: 'WebTmux', path: '/w/WebTmux', aiType: 'claude', description: '网梯终端 - AI 智能终端管理工具', lastUsed: 100 },
  { name: 'iSpring', path: '/w/iSpring', aiType: 'codex', lastUsed: 300 },          // 已开着 → 不重复
  { name: 'iSpring', path: '/w/iSpring', aiType: 'claude', lastUsed: 200 },          // 同目录不同 CLI → 照列
  { name: 'mathviz', path: '/w/mathviz', aiType: 'claude', description: '数学之美 - 交互式数学可视化实验平台', lastUsed: 50 },
  { name: 'phyviz', path: '/w/phyviz', aiType: 'claude', description: '物理之美', lastUsed: 60 },
];
const run = (query, extra = {}) => label(searchSwitcher({ query, sessions, sessionNumbers: numbers, projects, ...extra }));

test('① 运行中排前面：输 WebTmux，历史项目「WebTmux」完全命中也排在运行中的「WebTmuxNotes」之后', () => {
  eq(run('WebTmux'), ['S:WebTmuxNotes', 'P:WebTmux:claude'], '顺序');
});

test('② 已开着的同目录同 CLI 不重复；同目录另一种 CLI 照列', () => {
  eq(run('ispring'), ['S:iSpring', 'P:iSpring:claude'], 'iSpring');
});

test('③ 已关闭会话与历史项目同一处：只留已关闭会话', () => {
  const closed = [{ id: 'c1', name: 'mathviz', workDir: '/w/mathviz', aiType: 'claude', closedAt: 999 }];
  eq(run('mathviz', { closed }), ['C:mathviz'], '去重');
});

test('④ 不输入只列运行中的；门牌号只认运行中的', () => {
  eq(run(''), ['S:WebTmuxNotes', 'S:iSpring'], '空查询');
  eq(run('2'), ['S:iSpring'], '门牌号');
});

test('⑤ 中文拼音搜到历史项目说明（sxzm → 数学之美）；中文直接输入也行', () => {
  eq(run('sxzm'), ['P:mathviz:claude'], '拼音');
  eq(run('物理'), ['P:phyviz:claude'], '中文');
  eq(run('nxkj'), ['S:iSpring'], '运行中会话的中文目标照样能搜（逆向课件）');
});

test('⑤ 历史最多列 HISTORY_LIMIT 条，同分时最近用过的在前', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ name: `proj${i}`, path: `/w/p${i}`, aiType: 'claude', lastUsed: i }));
  const r = searchSwitcher({ query: 'proj', sessions: [], projects: many });
  eq(r.length, HISTORY_LIMIT, '上限');
  eq(r[0].p.name, 'proj19', '最近用过的在前');
});

test('⑥ 不输入：运行中的在前，最近关闭的跟在后面（最多 RECENT_CLOSED_LIMIT 个，保持服务端给的新→旧顺序）', () => {
  const closed = Array.from({ length: 7 }, (_, i) => ({ id: `x${i}`, name: `old${i}`, workingDir: `/w/old${i}`, aiType: 'claude', closedAt: 100 - i }));
  eq(run('', { closed }), ['S:WebTmuxNotes', 'S:iSpring', 'C:old0', 'C:old1', 'C:old2', 'C:old3', 'C:old4'], '空查询');
});

test('⑥ 有输入：最近关闭的会话按名字命中，排在运行中的之后；同一处的历史项目不再重复', () => {
  const closed = [{ id: 'm', name: 'mathviz', workingDir: '/w/mathviz', aiType: 'claude', closedAt: 5 }];
  eq(run('viz', { closed }), ['C:mathviz', 'P:phyviz:claude'], 'viz');
});

test('没有任何命中返回空', () => {
  eq(run('zzzqqq'), [], '空');
});

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);

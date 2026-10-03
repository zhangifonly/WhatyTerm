/**
 * ⌘K 搜索：运行中的会话 + 历史（v1.4.86 起历史项目、已关闭会话命中也列出来，运行中的始终排前面）。
 * 纯函数，从 App.jsx 抽出来便于测试。打分规则沿用原来那套（英文子序列 + 拼音 + 中文直接包含）。
 */
import PinyinMatch from 'pinyin-match';
import { findExistingSession, normalizePath } from './projectOpen.js';

// 子序列模糊匹配：输入 wtx 能命中 WebTmux。纯 includes 做不到，
// 而 35 个会话里靠首字母缩写定位是最省按键的方式。
export const fuzzyScore = (text, query) => {
  if (!query) return 0;
  const t = String(text || '').toLowerCase();
  const q = query.toLowerCase();
  if (t.includes(q)) return 1000 - t.indexOf(q);   // 连续匹配优先，越靠前越高
  let ti = 0, hits = 0, lastHit = -1, bonus = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return -1;                    // 有字符匹配不上 → 不命中
    if (lastHit >= 0 && found === lastHit + 1) bonus += 3;  // 相邻加分
    if (found === 0 || /[^a-z0-9]/.test(t[found - 1])) bonus += 5;  // 词首加分
    lastHit = found; ti = found + 1; hits++;
  }
  return hits * 2 + bonus;
};

// 拼音匹配：中文首字母 / 全拼 / 中英混排都支持（sxzm → 数学之美，kjkk → 可监可控）。
// 会话名几乎全是英文，中文只在目标和项目说明里，那才是脑子里记住一个项目的方式。
// 选 pinyin-match 而非 pinyin-pro：同一批真实数据误命中更少、体积更小。
// 它不做英文子序列，所以两套匹配并存：子序列管英文缩写，pinyin-match 管中文。
export const pinyinHit = (text, query) => {
  if (!text || !query) return false;
  if (!/[一-龥]/.test(text)) return false;          // 不含汉字直接跳过，省掉拼音解析
  try { return !!PinyinMatch.match(text, query); } catch { return false; }
};

/**
 * 一条记录的匹配分（-1 = 不命中）。名字 > 目标 > 说明 > 目录。
 * @param {{name?:string, altName?:string, dir?:string, goal?:string, desc?:string}} f
 */
export function scoreFields(f, q) {
  // 截断到 120 字：长说明拖慢匹配，命中价值也低
  const goal = String(f.goal || '').slice(0, 120);
  const desc = String(f.desc || '').slice(0, 120);
  let best = Math.max(
    fuzzyScore(f.name || '', q),
    f.altName ? fuzzyScore(f.altName, q) : -1,
    fuzzyScore(f.dir || '', q) - 200,               // 目录命中降权，重名时靠它区分
  );
  if (pinyinHit(f.name, q)) best = Math.max(best, 900);
  if (pinyinHit(goal, q)) best = Math.max(best, 700);
  if (pinyinHit(desc, q)) best = Math.max(best, 650);
  const ql = q.toLowerCase();                       // 中文直接输入（不转拼音）
  if (goal.toLowerCase().includes(ql)) best = Math.max(best, 720);
  if (desc.toLowerCase().includes(ql)) best = Math.max(best, 670);
  return best;
}

export const RUNNING_LIMIT = 12;
export const HISTORY_LIMIT = 8;

/**
 * @returns {Array<{kind:'session', s}|{kind:'project', p}|{kind:'closed', c}>} 运行中的在前，历史在后
 */
export function searchSwitcher({ query, sessions = [], orderedSessions = sessions, sessionNumbers = {}, projects = [], closed = [] }) {
  const q = String(query || '').trim();
  // 不输入时只列运行中的：历史一百多条，全倒出来就淹没了真正要切的会话
  if (!q) return orderedSessions.slice(0, RUNNING_LIMIT).map((s) => ({ kind: 'session', s }));
  // 纯数字按门牌号命中，只对运行中的会话有意义
  if (/^\d+$/.test(q)) {
    const hit = sessions.filter((s) => String(sessionNumbers[s.id]) === q);
    if (hit.length) return hit.map((s) => ({ kind: 'session', s }));
  }

  const running = sessions
    .map((s) => ({ s, score: scoreFields({ name: s.projectName || s.name, altName: s.name, dir: s.workingDir, goal: s.goal, desc: s.projectDesc }, q) }))
    .filter((x) => x.score > -1)
    .sort((a, b) => b.score - a.score || (sessionNumbers[a.s.id] || 0) - (sessionNumbers[b.s.id] || 0))
    .slice(0, RUNNING_LIMIT)
    .map(({ s }) => ({ kind: 'session', s }));

  // 历史：同一目录、同一种 CLI 已经开着的不再列（上面已有，点了也是切过去）；
  // 已关闭会话与历史项目指向同一个目录+CLI 时只留已关闭会话（恢复它能带回原来的目标、供应商等设置）
  const isRunning = (dir, aiType) => !!findExistingSession(sessions, { path: dir, aiType });
  const seen = new Set();
  const key = (dir, aiType) => `${aiType || 'claude'}:${normalizePath(dir)}`;
  const hist = [];
  for (const c of closed) {
    const dir = c.workingDir || c.workDir || '';
    if (dir && isRunning(dir, c.aiType)) continue;
    const score = scoreFields({ name: c.projectName || c.name, altName: c.name, dir, goal: c.goal, desc: c.projectDesc }, q);
    if (score < 0) continue;
    if (dir) seen.add(key(dir, c.aiType));
    hist.push({ item: { kind: 'closed', c }, score, at: c.closedAt || 0 });
  }
  for (const p of projects) {
    if (isRunning(p.path, p.aiType) || seen.has(key(p.path, p.aiType))) continue;
    const score = scoreFields({ name: p.name, dir: p.path, desc: p.description }, q);
    if (score < 0) continue;
    hist.push({ item: { kind: 'project', p }, score, at: p.lastUsed || 0 });
  }
  const history = hist
    .sort((a, b) => b.score - a.score || b.at - a.at)   // 同分时最近用过的在前
    .slice(0, HISTORY_LIMIT)
    .map((x) => x.item);

  return [...running, ...history];
}

/** 后端给的 {claude:[], codex:[], …} 拍平成一个数组 */
export const flattenProjects = (byCli) => Object.values(byCli || {}).flat().filter((p) => p?.path);

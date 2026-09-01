/**
 * 回归：点击历史项目时，「复用已有会话」的匹配必须同时比对 workingDir 和 aiType。
 *
 * 故障现象：点 codex 历史项目，启动的却是 claude。
 * 原因：旧逻辑只按 workingDir 匹配，同一目录下若已存在 claude 会话，
 * 点 codex 项目会命中它并直接切过去，永远走不到「按 resumeCommand 新建」分支。
 * 实测环境里 /Users/.../RustCandance 同时有 claude 与 codex 两个会话，必然触发。
 */

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};
const eq = (a, b, msg) => {
  if (a !== b) throw new Error(msg || `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
};

const normalizePath = (p) => (p ? p.replace(/\/+$/, '') : '');

/** 被测逻辑：与 src/App.jsx handleOpenRecentProject 中的匹配保持一致 */
function findExisting(sessions, project) {
  const projectPath = normalizePath(project.path);
  const wantType = project.aiType || 'claude';
  return sessions.find(s =>
    normalizePath(s.workingDir) === projectPath &&
    (s.aiType || 'claude') === wantType
  ) || null;
}

/** 创建去重键：同目录不同 CLI 不应互相阻塞 */
const creatingKey = (project) =>
  `${project.aiType || 'claude'}:${normalizePath(project.path)}`;

console.log('历史项目匹配 —— aiType 必须参与比对');

const DIR = '/Users/zhangzhen/Documents/ClaudeCode/RustCandance';
const sessions = [
  { id: 'c1', workingDir: DIR, aiType: 'claude' },
  { id: 'x1', workingDir: DIR, aiType: 'codex' },
  { id: 'g1', workingDir: '/tmp/other', aiType: 'gemini' }
];

t('点 codex 项目命中 codex 会话（不是同目录的 claude）', () => {
  const got = findExisting(sessions, { path: DIR, aiType: 'codex' });
  eq(got?.id, 'x1', '这一条锁住故障：绝不能返回 c1');
});

t('点 claude 项目命中 claude 会话', () => {
  eq(findExisting(sessions, { path: DIR, aiType: 'claude' })?.id, 'c1');
});

t('点 gemini 项目：同目录只有 claude/codex 时不复用，返回 null 走新建', () => {
  eq(findExisting(sessions, { path: DIR, aiType: 'gemini' }), null);
});

t('旧行为若忽略 aiType 会误命中 claude（复现故障，作为对照）', () => {
  const wrong = sessions.find(s => normalizePath(s.workingDir) === DIR);
  eq(wrong.id, 'c1', '证明只按目录匹配时先命中的是 claude');
});

t('aiType 缺省视为 claude', () => {
  const ss = [{ id: 'n1', workingDir: DIR }];
  eq(findExisting(ss, { path: DIR, aiType: 'claude' })?.id, 'n1');
  eq(findExisting(ss, { path: DIR, aiType: 'codex' }), null);
});

t('路径末尾斜杠不影响匹配', () => {
  eq(findExisting(sessions, { path: DIR + '/', aiType: 'codex' })?.id, 'x1');
});

t('不同目录同类型不误命中', () => {
  eq(findExisting(sessions, { path: '/tmp/nope', aiType: 'codex' }), null);
});

t('创建去重键含 aiType：同目录 codex 与 claude 互不阻塞', () => {
  const a = creatingKey({ path: DIR, aiType: 'codex' });
  const b = creatingKey({ path: DIR, aiType: 'claude' });
  if (a === b) throw new Error('键相同会导致第二次点击被当成重复点击吞掉');
  const inflight = new Set([a]);
  eq(inflight.has(b), false, 'claude 不应被 codex 的进行中标记挡住');
});

t('同目录同类型重复点击仍被去重', () => {
  const k = creatingKey({ path: DIR, aiType: 'codex' });
  eq(new Set([k]).has(creatingKey({ path: DIR + '/', aiType: 'codex' })), true);
});

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);

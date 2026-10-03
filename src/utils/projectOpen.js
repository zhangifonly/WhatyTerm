/**
 * 打开历史项目：桌面版与移动版共用（v1.4.83 起移动版也能从历史项目开工）。
 *
 * 规则（原写在桌面 App.jsx 里，抽出来防止两端各写一份后漂移——会话排序就漂过一次，见 sessionSort.js）：
 *   - 同目录、同类型 CLI 已有会话 → 直接切过去，不新建
 *   - 否则新建会话并发续接命令（claude -c / codex resume --last …），由服务端 session:createAndResume 处理
 *   - 键含 CLI 类型：同目录先点 Codex 再点 Claude 是两个不同的会话，不能当成重复点击吞掉
 */

export const normalizePath = (p) => (p ? String(p).replace(/\/+$/, '') : '');

/** 防重复点击的键 */
export const creatingKeyOf = (project) => `${project.aiType || 'claude'}:${normalizePath(project.path)}`;

/** 这个项目已经开着的同类型会话（没有返回 null） */
export function findExistingSession(sessions, project) {
  const want = project.aiType || 'claude';
  const p = normalizePath(project.path);
  return (sessions || []).find((s) => normalizePath(s.workingDir) === p && (s.aiType || 'claude') === want) || null;
}

/** 发给 session:createAndResume 的数据 */
export function resumePayload(project) {
  return {
    name: project.name,
    aiType: project.aiType || 'claude',
    workingDir: project.path,
    projectName: project.name,
    projectDesc: '',                 // 由服务端从项目文件提取
    resumeCommand: project.resumeCommand,
  };
}

export const CLI_TABS = [
  { key: 'claude', label: 'Claude' },
  { key: 'codex', label: 'Codex' },
  { key: 'gemini', label: 'Gemini' },
  { key: 'grok', label: 'Grok' },
];

/** 「3 分钟前」「2 天前」 */
export function timeAgo(ts, now = Date.now()) {
  const m = Math.floor((now - ts) / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

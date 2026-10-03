import React, { useEffect, useMemo, useState } from 'react';
import { socket } from './socket';
import { matchPinyin } from '../utils/pinyin';
import { CLI_TABS, creatingKeyOf, findExistingSession, resumePayload, timeAgo } from '../utils/projectOpen.js';

const SHOW_STEP = 30;   // 一次先渲染这么多条：单 Claude 就有 55+ 个历史项目，手机上一次全画会卡

/**
 * 移动版「历史项目」：选一个项目点一下就开工。规则与桌面版共用 src/utils/projectOpen.js：
 * 已有同类型会话就直接打开它，否则新建会话并发续接命令（claude -c 等），建好后自动进详情页。
 */
export default function ProjectPicker({ sessions, onOpen }) {
  const [projects, setProjects] = useState(null);
  const [tab, setTab] = useState('claude');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(SHOW_STEP);
  const [starting, setStarting] = useState(null);   // { key, name }
  const [error, setError] = useState('');

  useEffect(() => {
    const onList = (data) => {
      setProjects(data || {});
      // 默认停在第一个有项目的分类
      const first = CLI_TABS.find((t) => data?.[t.key]?.length);
      if (first) setTab((cur) => (data?.[cur]?.length ? cur : first.key));
    };
    socket.on('recentProjects:list', onList);
    socket.emit('recentProjects:get');
    return () => socket.off('recentProjects:list', onList);
  }, []);

  // 新建的会话：服务端只回发起方 session:created，拿到就进详情
  useEffect(() => {
    if (!starting) return undefined;
    const onCreated = (s) => { if (s?.id) { setStarting(null); onOpen(s.id); } };
    const onErr = (e) => { setStarting(null); setError(e?.message || '启动失败'); };
    socket.on('session:created', onCreated);
    socket.on('error', onErr);
    const timer = setTimeout(() => { setStarting(null); setError('20 秒还没建好，请到会话列表里看看是否已经出现'); }, 20000);
    return () => { socket.off('session:created', onCreated); socket.off('error', onErr); clearTimeout(timer); };
  }, [starting, onOpen]);

  const list = useMemo(() => {
    const all = projects?.[tab] || [];
    if (!query.trim()) return all;
    return all.filter((p) => matchPinyin(p.name, query) || matchPinyin(p.path, query) || matchPinyin(p.description, query));
  }, [projects, tab, query]);

  const open = (project) => {
    setError('');
    const existing = findExistingSession(sessions, project);
    if (existing) { onOpen(existing.id); return; }
    const key = creatingKeyOf(project);
    if (starting?.key === key) return;   // 重复点击
    setStarting({ key, name: project.name });
    socket.emit('session:createAndResume', resumePayload(project));
  };

  if (!projects) return <div className="m-empty">加载历史项目…</div>;

  return (
    <div className="m-projects">
      <div className="m-tabs" role="tablist">
        {CLI_TABS.filter((t) => projects[t.key]?.length).map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key}
            className={`m-tab${tab === t.key ? ' active' : ''}`} onClick={() => { setTab(t.key); setLimit(SHOW_STEP); }}>
            {t.label} <span className="m-tab-count">{projects[t.key].length}</span>
          </button>
        ))}
      </div>
      <input className="m-search" type="search" placeholder="搜索项目名、路径或拼音首字母" aria-label="搜索历史项目"
        value={query} onChange={(e) => { setQuery(e.target.value); setLimit(SHOW_STEP); }} />
      {starting && <div className="m-starting" role="status">正在启动「{starting.name}」…</div>}
      {error && <div className="m-error" role="alert">{error}</div>}
      {list.length === 0 && <div className="m-empty">{query ? '没有匹配的项目' : '这一类还没有历史项目'}</div>}
      {list.slice(0, limit).map((p) => {
        const running = findExistingSession(sessions, p);
        const key = creatingKeyOf(p);
        return (
          <button key={key} className="m-card m-project" disabled={!!starting} onClick={() => open(p)}>
            <div className="m-card-row">
              <span className="m-card-name">{p.name}</span>
              {running ? <span className="m-auto-tag">进行中 · 打开</span> : <span className="m-project-go">{starting?.key === key ? '启动中…' : '开始'}</span>}
            </div>
            {p.description && <div className="m-card-state">{p.description}</div>}
            <div className="m-card-meta">
              <span className="m-project-path">{p.path}</span>
              {p.lastUsed && <span>{timeAgo(p.lastUsed)}</span>}
            </div>
          </button>
        );
      })}
      {list.length > limit && (
        <button className="m-btn m-more" onClick={() => setLimit((n) => n + SHOW_STEP)}>再显示 {Math.min(SHOW_STEP, list.length - limit)} 个（共 {list.length}）</button>
      )}
    </div>
  );
}

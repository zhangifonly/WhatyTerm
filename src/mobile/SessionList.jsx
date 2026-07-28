import React from 'react';
import SessionCard from './SessionCard';

/** 会话列表页：needsAction 的会话置顶排序 */
export default function SessionList({ sessions, aiStatusMap, loadingMap, memoryMap, loaded, refresh, onOpen }) {
  const sorted = [...sessions].sort((a, b) => {
    const na = aiStatusMap[a.id]?.needsAction && !a.autoActionEnabled ? 1 : 0;
    const nb = aiStatusMap[b.id]?.needsAction && !b.autoActionEnabled ? 1 : 0;
    return nb - na;
  });

  const needCount = sorted.filter(
    (s) => aiStatusMap[s.id]?.needsAction && !s.autoActionEnabled
  ).length;

  return (
    <div className="m-list">
      <div className="m-list-header">
        <span>
          会话 {sessions.length} 个
          {needCount > 0 && <span className="m-need-count">🔴 {needCount} 个需操作</span>}
        </span>
        <button className="m-btn" onClick={refresh}>刷新</button>
      </div>
      {!loaded && <div className="m-empty">加载中…</div>}
      {loaded && sessions.length === 0 && (
        <div className="m-empty">暂无运行中的会话<br />请在电脑端创建会话后查看</div>
      )}
      {sorted.map((s) => (
        <SessionCard
          key={s.id}
          session={s}
          aiStatus={aiStatusMap[s.id]}
          loading={loadingMap[s.id]}
          memory={memoryMap[s.id]}
          onClick={() => onOpen(s.id)}
        />
      ))}
    </div>
  );
}

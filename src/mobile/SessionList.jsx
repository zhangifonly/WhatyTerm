import React from 'react';
import SessionCard from './SessionCard';
import { orderSessions, needsActionIds, nextSortMode, SORT_LABELS, DEFAULT_SORT } from '../utils/sessionSort.js';

/**
 * 会话列表页。
 *
 * ⚠ 排序**必须**用共享的 src/utils/sessionSort.js —— 与桌面版同一份。
 *   这里原来自己写了一层「needsAction 置顶」，而桌面是「置顶 → 排序模式 → 门牌号」三层，
 *   且 needsAction 的口径只覆盖三类中的一类（漏了屏上挂确认菜单、任务报错这两类，
 *   恰恰最该先看）。结果同一批会话在手机和电脑上顺序完全对不上号。
 */
export default function SessionList({
  sessions, aiStatusMap, loadingMap, memoryMap, loaded, refresh, onOpen,
  prefs, setSortMode, longRunTasks = [],
}) {
  const sortMode = prefs?.sessionSort || DEFAULT_SORT;
  const pinnedIds = new Set(prefs?.pinnedSessions || []);
  const needIds = needsActionIds(sessions, aiStatusMap, longRunTasks);   // 含「长程在等你」
  // 每个条目最新的那个长程任务（一个条目可能跑过好几轮）
  const lrOf = (sid) => longRunTasks.filter((t) => t.sessionId === sid)
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0] || null;
  const sorted = orderSessions({ sessions, pinnedIds, sortMode, needIds });
  const needCount = needIds.size;

  return (
    <div className="m-list">
      <div className="m-list-header">
        <span>
          会话 {sessions.length} 个
          {needCount > 0 && <span className="m-need-count">🔴 {needCount} 个需操作</span>}
        </span>
        <span className="m-list-actions">
          {/* 与桌面同一套模式与循环顺序；改了会同步到电脑端 */}
          <button className="m-btn" onClick={() => setSortMode?.(nextSortMode(sortMode))}>
            {SORT_LABELS[sortMode] || SORT_LABELS[DEFAULT_SORT]}
          </button>
          <button className="m-btn" onClick={refresh}>刷新</button>
        </span>
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
          pinned={pinnedIds.has(s.id)}
          lrTask={s.runMode === 'longrun' ? lrOf(s.id) : null}
          onClick={() => onOpen(s.id)}
        />
      ))}
    </div>
  );
}

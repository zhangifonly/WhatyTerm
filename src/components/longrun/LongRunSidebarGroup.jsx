import React, { useState } from 'react';
import { taskBadge, taskLine } from './longrunBoard.js';

const COLLAPSE_KEY = 'webtmux.longrun.groupCollapsed';
const readCollapsed = () => { try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; } };

/**
 * 会话列表顶部的「长程任务」分组。条目样式沿用会话条目（状态点、名字、第二行进度），
 * 没有任务也没有可回放的历史时整组不渲染，不占位置。
 *
 * 两类条目：
 *   · 本次服务进程里启动过的任务（实时，带徽标：等你回答 / 已暂停 / 运行中 / 停机原因）
 *   · 磁盘上有事件文件、但内存里没有任务的历史沙箱（灰色，点开是只读回放，可续跑）
 */
const LongRunSidebarGroup = ({ tasks, sandboxes, view, onOpen }) => {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const liveRoots = new Set(tasks.map((t) => t.sandboxRoot));
  const history = sandboxes.filter((s) => s.hasEvents && !liveRoots.has(s.root));
  const sorted = [...tasks].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  if (!sorted.length && !history.length) return null;

  const waiting = sorted.filter((t) => t.state === 'running' && t.awaitingHuman).length;
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try { localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0'); } catch { /* 隐私模式等 */ }
  };

  return (
    <div className="lr-group">
      <button className="lr-group-head" onClick={toggle} title="长程任务：执行者在沙箱里无人值守连续开发">
        <span className="lr-group-caret">{collapsed ? '▸' : '▾'}</span>
        长程任务
        <span className="lr-group-count">{sorted.length + history.length}</span>
        {waiting > 0 && <span className="lr-group-wait">✋ {waiting} 个等你</span>}
      </button>
      {!collapsed && (
        <>
          {sorted.map((t) => {
            const [tone, text] = taskBadge(t);
            const active = view?.kind === 'task' && view.id === t.id;
            return (
              <div key={t.id}
                className={`session-item lr-item ${active ? 'active' : ''} ${tone === 'wait' && t.awaitingHuman ? 'needs-action' : ''}`}
                onClick={() => onOpen({ kind: 'task', id: t.id })}
                title={`${t.sandboxRoot}\n${t.mode === 'resume' ? '续跑' : '新建'} · ${new Date(t.startedAt).toLocaleString()}`}>
                <div className="session-header">
                  <div className="session-name">
                    <span className={`lr-dot ${tone}`} />
                    {t.sandboxName}
                  </div>
                  <span className={`lr-badge ${tone}`}>{text}</span>
                </div>
                <div className="session-goal">{taskLine(t)}{t.lastLabel ? ` · ${t.lastLabel}` : ''}</div>
              </div>
            );
          })}
          {history.map((s) => {
            const active = view?.kind === 'replay' && view.sandboxName === s.name;
            const p = s.prior || {};
            return (
              <div key={s.root} className={`session-item lr-item lr-history ${active ? 'active' : ''}`}
                onClick={() => onOpen({ kind: 'replay', sandboxName: s.name })}
                title={`${s.root}\n只读回放上一轮（服务重启后内存里的任务会丢失，事件文件还在）`}>
                <div className="session-header">
                  <div className="session-name"><span className="lr-dot idle" />{s.name}</div>
                  <span className="lr-badge idle">回放</span>
                </div>
                <div className="session-goal">
                  {p.legs != null ? `第 ${p.legs} 发 · 交接 ${p.handoffs ?? 0} · $${Number(p.spentUsd || 0).toFixed(2)}` : '无运行记录'}
                  {s.resumable ? ' · 可续跑' : ''}
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
};

export default LongRunSidebarGroup;

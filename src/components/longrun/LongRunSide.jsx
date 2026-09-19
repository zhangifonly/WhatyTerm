import React, { useState, useEffect } from 'react';
import ServerStaleBanner from '../ServerStaleBanner.jsx';
import { HeaderStats, ProviderCards, WaterlineSection } from './LongRunSideCards.jsx';
import { StatusSection, VerdictSection } from './LongRunSideStatus.jsx';

/**
 * 右侧面板，外壳与版式照搬 AI 面板：头部（标题 · 健康点 · 状态 · 统计）→ 供应商卡 → 上下文水位 → 当前状态 →
 * 工作目录 → 监督者判定 → 底部按钮。只读；人要输入的（回答、投件、暂停、转终端）都在主区底部。
 */
const LongRunSide = ({ lr, serverStale, collapsed, onToggle }) => {
  const { board, meta, view } = lr;
  const [showCheck, setShowCheck] = useState(false);
  const [provider, setProvider] = useState(null);
  const task = meta.task;
  const live = view?.kind === 'task' && task?.state === 'running';
  const sup = board?.supervisor;
  const warns = (task?.selfCheck || []).filter((i) => i.level === 'warn').length;

  // 执行者用的是 CC Switch 当前全局配置：切条目时刷新一次（切供应商后下一发才生效，不必轮询）
  useEffect(() => {
    let alive = true;
    lr.call('longrun:provider', {}).then((r) => { if (alive && r.ok) setProvider(r.provider); });
    return () => { alive = false; };
  }, [view?.id, view?.sessionId]);   // eslint-disable-line react-hooks/exhaustive-deps

  const supDown = String(sup?.reason || '').startsWith('监督者不可用');
  const health = !task || task.supervisor?.status !== 'on' ? 'offline' : supDown ? 'failed' : 'healthy';
  const healthTitle = { healthy: '监督者正常', failed: `监督者调用失败：${sup?.reason || ''}`, offline: task ? '监督者未启用或不可用' : '只读回放' }[health];
  const status = board?.replay ? '只读回放' : live ? (task.awaitingHuman ? '等你回答' : task.halted ? '已暂停' : '运行中') : task ? '已结束' : '';

  return (
    <aside className={`ai-panel ${collapsed ? 'collapsed' : ''}`}>
      <button className="panel-toggle ai-panel-toggle" onClick={onToggle} title={collapsed ? '展开' : '收起'}>
        {collapsed ? '‹' : '›'}
      </button>
      <div className="ai-panel-header">
        <h3>长程任务</h3>
        <div className="lr-side-head">
          <span className={`ai-health-dot ${health}`} title={healthTitle} />
          <span className={`ai-status-indicator ${status === '等你回答' ? 'loading' : ''}`}>{status}</span>
          {board && <HeaderStats board={board} task={task} />}
        </div>
      </div>
      <div className="ai-panel-content">
        <ServerStaleBanner stale={serverStale} />
        <ProviderCards provider={provider} task={task} lr={lr} />
        {board && <WaterlineSection board={board} task={task} />}

        {board && <StatusSection board={board} report={meta.report || task?.report} />}

        <div className="ai-status-section">
          <h4>工作目录</h4>
          <p className="mono">{task?.sandboxRoot || board?.sandbox || '—'}</p>
        </div>

        {sup && <VerdictSection sup={sup} down={supDown} />}

        {showCheck && task?.selfCheck?.length > 0 && (
          <div className="ai-status-section">
            <h4>启动自检 <span className={warns ? 'lr-est' : 'lr-dim'}>{task.selfCheck.length} 项{warns ? `，${warns} 条提醒` : ''}</span></h4>
            {task.selfCheck.map((i, k) => <div key={k} className={`lr-check ${i.level}`}>{i.level === 'warn' ? '⚠ ' : ''}{i.text}</div>)}
          </div>
        )}
        {board?.requirement && (
          <div className="ai-status-section">
            <h4>需求</h4>
            <pre className="lr-req">{board.requirement}</pre>
          </div>
        )}
        {meta.file && <div className="lr-dim lr-small">回放自 {meta.file} · {meta.count} 条事件 · 跨度 {meta.spanMinutes} 分钟</div>}
      </div>
      <div className="ai-panel-footer">
        <button className={`btn btn-small ${lr.muted ? 'btn-secondary' : 'btn-primary'}`} onClick={() => lr.setMuted(!lr.muted)}
          title="执行者需要你拍板时响铃提醒">{lr.muted ? '🔕 提醒:关' : '🔔 提醒:开'}</button>
        {task?.selfCheck?.length > 0 && (
          <button className={`btn btn-small ${showCheck ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setShowCheck(!showCheck)}>
            📋 启动自检{warns ? `（${warns}）` : ''}
          </button>
        )}
      </div>
    </aside>
  );
};

export default LongRunSide;

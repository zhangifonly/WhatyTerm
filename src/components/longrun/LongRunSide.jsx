import React, { useState } from 'react';
import LongRunIntervene from './LongRunIntervene.jsx';
import { ctxView, verdictClass, STOP_LABEL, VERDICT_LABEL } from './longrunBoard.js';

/**
 * 右侧面板（沿用 AI 面板的外壳与卡片样式）：会话进度、监督者判定、人工干预、启动自检、需求。
 */
const LongRunSide = ({ lr, collapsed, onToggle, onResume, onHandover }) => {
  const { board, meta, view } = lr;
  const [showCheck, setShowCheck] = useState(false);
  const task = meta.task;
  const live = view?.kind === 'task' && task?.state === 'running';
  const ctx = ctxView(board?.context);
  const sup = board?.supervisor;
  const f = board?.finished;
  const warns = (task?.selfCheck || []).filter((i) => i.level === 'warn').length;

  return (
    <aside className={`ai-panel ${collapsed ? 'collapsed' : ''}`}>
      <button className="panel-toggle ai-panel-toggle" onClick={onToggle} title={collapsed ? '展开' : '收起'}>
        {collapsed ? '‹' : '›'}
      </button>
      <div className="ai-panel-header">
        <h3>长程任务</h3>
        <span className="lr-dim">{board?.replay ? '只读回放' : live ? '运行中' : task ? '已结束' : ''}</span>
      </div>
      <div className="ai-panel-content">
        {board && (
          <div className="ai-status-section">
            <h4>会话进度</h4>
            {f ? (
              <div>
                <span className={`lr-badge ${f.stop === 'project_done' ? 'ok' : 'wait'}`}>已停机</span> {STOP_LABEL[f.stop] || f.stop}
                {f.needs_from_human && <div className="lr-kv">需你提供：<b>{f.needs_from_human}</b></div>}
              </div>
            ) : (
              <div>{board.current_label ? <>正在跑 <b>{board.current_label}</b></> : <span className="lr-dim">等待启动…</span>}</div>
            )}
            <div className={`lr-bar ${ctx.hot ? 'hot' : ''}`}><i style={{ width: `${ctx.pct}%` }} /></div>
            <div className="lr-kv">{ctx.text}</div>
            {board.last_tool?.length > 0 && <div className="lr-kv">工具 <b>{board.last_tool.join(', ')}</b></div>}
            <div className="lr-kv">
              调用 <b>{board.legs || 0}</b> 次 · 交接 <b>{board.handoffs || 0}</b> 次 · 记忆维护 <b>{board.maintenances || 0}</b> 轮
              {/* 代答计数只在发生过时出现且高亮：代答不标注来源，这是发现"有 N 个决定不是我做的"的唯一入口 */}
              {board.decisions > 0 && <span className="lr-dec"> · 代你作答 <b>{board.decisions}</b> 次</span>}
            </div>
            {board.session_id && <div className="lr-kv">会话 <b>{String(board.session_id).slice(0, 8)}</b></div>}
          </div>
        )}

        {sup && (
          <div className="ai-status-section">
            <h4>监督者判定</h4>
            <div>
              <span className={`lr-badge ${verdictClass(sup.verdict)}`}>{VERDICT_LABEL[sup.verdict] || sup.verdict}</span>{' '}
              <span className="lr-dim">置信度 {(sup.confidence || 0).toFixed(2)}</span>
            </div>
            <div className="lr-kv">{sup.reason || ''}</div>
            {sup.needs_from_human ? <div className="lr-kv">需你提供：<b>{sup.needs_from_human}</b></div>
              : sup.reply ? <div className="lr-kv">代你答复：<b>{sup.reply}</b></div> : null}
          </div>
        )}

        {live && <LongRunIntervene lr={lr} task={task} />}

        {!live && view?.kind !== 'pending' && (
          <div className="ai-status-section">
            <h4>接着做</h4>
            <div className="lr-kv">项目与记忆（.memory）都在，两种方式任选：</div>
            <div className="lr-kv">· <b>转为终端</b>：同一条目切回终端，用交互式 claude 接着开发（按水位自动选续同一对话或开新对话）</div>
            <div className="lr-kv">· <b>续跑长程</b>：追加需求，执行者从记忆接上继续无人值守开发</div>
            <div className="lr-row">
              <button className="btn btn-primary btn-small" onClick={onHandover}>转为终端…</button>
              <button className="btn btn-secondary btn-small" onClick={onResume}>续跑长程…</button>
            </div>
          </div>
        )}

        {task?.selfCheck?.length > 0 && (
          <div className="ai-status-section">
            <h4 className="lr-clickable" onClick={() => setShowCheck(!showCheck)}>
              启动自检 {showCheck ? '▾' : '▸'} <span className={warns ? 'lr-est' : 'lr-dim'}>{task.selfCheck.length} 项{warns ? `，${warns} 条提醒` : ''}</span>
            </h4>
            {showCheck && task.selfCheck.map((i, k) => (
              <div key={k} className={`lr-check ${i.level}`}>{i.level === 'warn' ? '⚠ ' : ''}{i.text}</div>
            ))}
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
    </aside>
  );
};

export default LongRunSide;

import React from 'react';
import { verdictClass, STOP_LABEL, VERDICT_LABEL } from './longrunBoard.js';

/** 右侧面板「当前状态」（对应 AI 面板同名卡片）：正在跑哪一发 / 停机原因、最近工具、claude 会话 */
export const StatusSection = ({ board }) => {
  const f = board.finished;
  return (
    <div className="ai-status-section">
      <h4>当前状态</h4>
      {f ? (
        <p><span className={`lr-badge ${f.stop === 'project_done' ? 'ok' : 'wait'}`}>已停机</span> {STOP_LABEL[f.stop] || f.stop}</p>
      ) : <p>{board.current_label ? <>正在跑 <b>{board.current_label}</b></> : '等待启动…'}</p>}
      {f?.needs_from_human && <p className="lr-kv">需你提供：<b>{f.needs_from_human}</b></p>}
      {board.last_tool?.length > 0 && <p className="lr-kv">最近工具 <b>{board.last_tool.join(', ')}</b></p>}
      {board.session_id && <p className="lr-kv">claude 会话 <b className="mono">{String(board.session_id).slice(0, 8)}</b></p>}
    </div>
  );
};

/** 右侧面板「监督者判定」（对应 AI 面板「最近操作 / 需要操作」）：调用失败时整卡标红 */
export const VerdictSection = ({ sup, down }) => (
  <div className={`ai-status-section ${down ? 'action-needed' : ''}`}>
    <h4>监督者判定</h4>
    <p>
      <span className={`lr-badge ${verdictClass(sup.verdict)}`}>{VERDICT_LABEL[sup.verdict] || sup.verdict}</span>{' '}
      <span className="lr-dim">置信度 {(sup.confidence || 0).toFixed(2)}</span>
    </p>
    <p className="lr-kv">{sup.reason || ''}</p>
    {sup.needs_from_human ? <p className="lr-kv">需你提供：<b>{sup.needs_from_human}</b></p>
      : sup.reply ? <p className="lr-kv">代你答复：<b>{sup.reply}</b></p> : null}
  </div>
);

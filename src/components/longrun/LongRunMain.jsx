import React, { useState } from 'react';
import LongRunTimeline from './LongRunTimeline.jsx';
import LongRunLogs from './LongRunLogs.jsx';
import LongRunTranscript from './LongRunTranscript.jsx';
import LongRunComposer from './LongRunComposer.jsx';
import { fmtDur, INJECT_PHASE } from './longrunBoard.js';

const TABS = [['timeline', '对话与关键节点'], ['logs', '编排日志'], ['transcript', '对话记录']];

/**
 * 主区（原终端位置）：头部一行、状态横幅、三个标签页，底部是输入区（位置同 Claude Code 输入框）。
 * 等人回答、投件、暂停、转终端都在底部 —— 人要输入的地方只有一处，和终端会话的习惯一致。
 */
const LongRunMain = ({ lr, onResume, onHandover }) => {
  const { board, meta, view } = lr;
  const [tab, setTab] = useState('timeline');
  const viewKey = view ? `${view.kind}:${view.id || view.sessionId}` : '';

  if (meta.error) return <div className="lr-main"><div className="lr-err lr-pad">{meta.error}</div></div>;
  if (!board) return <div className="lr-main"><div className="lr-dim lr-pad">加载中…</div></div>;

  const task = meta.task;

  return (
    <div className="lr-main">
      <div className="lr-header">
        <b>{task?.sandboxName || board.title}</b>
        {board.replay && <span className="lr-badge wait">回放</span>}
        <span className="lr-meta lr-path" title={board.sandbox}>项目 <b>{board.sandbox || '—'}</b></span>
        <span className="lr-meta">进度 <b>第 {board.legs || 0} 次调用</b></span>
        <span className="lr-meta">费用 <b>${(board.spent_usd || 0).toFixed(4)}</b>
          {/* 已结算与进行中分开：一发能跑一两个小时，期间结算值不动，合成一个数会让人低估花费 */}
          {board.running_cost > 0 && <span className="lr-est"> ＋约 ${board.running_cost.toFixed(2)}（进行中）</span>}
        </span>
        <span className="lr-meta">耗时 <b>{fmtDur(board.elapsed_s)}</b></span>
        {meta.notices?.map((n) => <span key={n} className="lr-est">{n}</span>)}
      </div>

      {board.inject && (
        <div className="lr-card lr-banner">
          <b>人工打断</b> <span className="lr-est">{INJECT_PHASE[board.inject.phase] || board.inject.phase}</span>
          <pre>{board.inject.text || ''}</pre>
        </div>
      )}
      {board.paused && (
        <div className="lr-card lr-banner">
          <b>已暂停</b> 下一发「{board.paused.label || ''}」暂不派发。执行者已停在上一发结束处，不烧钱。
          <div className="lr-dim">点底部「继续」，或删掉 {board.paused.path || 'pause 文件'} 即继续</div>
        </div>
      )}

      <div className="lr-tabs">
        {TABS.map(([k, label]) => (
          <button key={k} className={`lr-tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      <div className="lr-tab-body">
        {tab === 'timeline' && <LongRunTimeline board={board} resetKey={viewKey} />}
        {tab === 'logs' && <LongRunLogs logs={board.logs} />}
        {tab === 'transcript' && <LongRunTranscript call={lr.call} defaultDir={task?.sandboxRoot || board.sandbox} />}
      </div>
      <LongRunComposer lr={lr} onResume={onResume} onHandover={onHandover} />
    </div>
  );
};

export default LongRunMain;

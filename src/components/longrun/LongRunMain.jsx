import React, { useState, useEffect } from 'react';
import LongRunTimeline from './LongRunTimeline.jsx';
import LongRunLogs from './LongRunLogs.jsx';
import LongRunTranscript from './LongRunTranscript.jsx';
import { fmtDur, INJECT_PHASE } from './longrunBoard.js';

const TABS = [['timeline', '对话与关键节点'], ['logs', '编排日志'], ['transcript', '对话记录']];

/**
 * 主区（原终端位置）：头部一行、三张状态横幅、三个标签页。
 * 横幅放主区而不是右侧：等人回答是最要紧的事，得在视线正中。
 */
const LongRunMain = ({ lr }) => {
  const { board, meta, view } = lr;
  const [tab, setTab] = useState('timeline');
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const viewKey = view ? `${view.kind}:${view.id || view.sandboxName}` : '';
  useEffect(() => { setAnswer(''); setMsg(''); }, [viewKey]);

  if (meta.error) return <div className="lr-main"><div className="lr-err lr-pad">{meta.error}</div></div>;
  if (!board) return <div className="lr-main"><div className="lr-dim lr-pad">加载中…</div></div>;

  const task = meta.task;
  const live = view?.kind === 'task' && task?.state === 'running';
  const nh = board.need_human;
  const sendAnswer = async () => {
    setBusy(true);
    const r = await lr.call('longrun:answer', { taskId: task.id, text: answer });
    setBusy(false);
    setMsg(r.ok ? '' : `失败：${r.error}`);
    if (r.ok) setAnswer('');
  };

  return (
    <div className="lr-main">
      <div className="lr-header">
        <b>{task?.sandboxName || board.title}</b>
        {board.replay && <span className="lr-badge wait">回放</span>}
        <span className="lr-meta lr-path" title={board.sandbox}>沙箱 <b>{board.sandbox || '—'}</b></span>
        <span className="lr-meta">进度 <b>第 {board.legs || 0} 次调用</b></span>
        <span className="lr-meta">费用 <b>${(board.spent_usd || 0).toFixed(4)}</b>
          {/* 已结算与进行中分开：一发能跑一两个小时，期间结算值不动，合成一个数会让人低估花费 */}
          {board.running_cost > 0 && <span className="lr-est"> ＋约 ${board.running_cost.toFixed(2)}（进行中）</span>}
        </span>
        <span className="lr-meta">耗时 <b>{fmtDur(board.elapsed_s)}</b></span>
        {meta.notices?.map((n) => <span key={n} className="lr-est">{n}</span>)}
      </div>

      {nh && (
        <div className="lr-bell">
          <div className="lr-bell-title">
            <span className="lr-bell-dot" />执行者需要你拍板
            {live && <button className="lr-mute" onClick={() => lr.setMuted(!lr.muted)}>{lr.muted ? '取消静音' : '静音'}</button>}
          </div>
          <div>需要你提供：<b>{nh.needs || ''}</b></div>
          {nh.reason && <div className="lr-dim">依据：{nh.reason}</div>}
          <pre>{nh.question || ''}</pre>
          {live && task.awaitingHuman ? (
            <div className="lr-answer">
              <textarea value={answer} onChange={(e) => setAnswer(e.target.value)}
                placeholder="你的回答会原样发给执行者（不加包装），续同一会话。留空提交 = 停机" />
              <button className="btn btn-primary btn-small" disabled={busy} onClick={sendAnswer}>
                {answer.trim() ? '回答并续跑' : '不回答，停机'}
              </button>
              {msg && <span className="lr-err">{msg}</span>}
            </div>
          ) : <div className="lr-dim">{board.replay ? '这是历史现场，当时的提问。' : '任务已不在等待。'}</div>}
        </div>
      )}

      {board.inject && (
        <div className="lr-card lr-banner">
          <b>人工打断</b> <span className="lr-est">{INJECT_PHASE[board.inject.phase] || board.inject.phase}</span>
          <pre>{board.inject.text || ''}</pre>
        </div>
      )}
      {board.paused && (
        <div className="lr-card lr-banner">
          <b>已暂停</b> 下一发「{board.paused.label || ''}」暂不派发。执行者已停在上一发结束处，不烧钱。
          <div className="lr-dim">点右侧「继续」，或删掉 {board.paused.path || 'pause 文件'} 即继续</div>
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
    </div>
  );
};

export default LongRunMain;

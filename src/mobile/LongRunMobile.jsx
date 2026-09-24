import React, { useState } from 'react';
import { socket } from './socket';
import { useLongRunBrief } from './useLongRunBrief';
import LongRunMobileActions, { ConfirmButton } from './LongRunMobileActions';
import { longRunAdvice } from '../components/longrun/longrunAdvice.js';
import { fmtDur } from '../components/longrun/longrunBoard.js';

const hhmm = (at) => new Date((at || 0) * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
const k = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n || 0));

/**
 * 手机上的长程详情：取代终端预览（长程跑的时候 tmux 里只有空 shell，预览没有意义）。
 * 最要紧的是**问题卡**：长程本来就是你不在电脑前时跑的，它停下来等你时，手机是你唯一的入口。
 */
export default function LongRunMobile({ task }) {
  const { brief: b, error, refresh } = useLongRunBrief(task);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  if (!task) {
    return <div className="m-empty">这个条目上没有长程任务在内存里（服务重启过，或还没开跑）。<br />新开或续跑请到电脑上操作。</div>;
  }
  if (!b) return <div className="m-empty">{error || '读取长程状态…'}</div>;

  const send = (text) => {
    setBusy(true); setMsg('');
    socket.emit('longrun:answer', { taskId: task.id, text }, (r) => {
      setBusy(false);
      if (!r?.ok) { setMsg(`失败：${r?.error || '无响应'}`); return; }
      setAnswer('');
      setMsg(text ? '已回答，执行者接着跑' : '已停机');
      refresh();
    });
  };

  const done = b.state !== 'running';
  const advice = done ? longRunAdvice(b.report ? { ...b.report, outcome: b.outcome } : null, { finished: b.finished }) : null;

  return (
    <div className="m-lr">
      <div className="m-lr-status">
        <b>{b.title}</b>
        <span className={`m-lr-state ${b.awaitingHuman ? 'wait' : done ? 'done' : 'run'}`}>
          {b.awaitingHuman ? '等你回答' : done ? '已收工' : b.paused ? '已暂停' : '运行中'}
        </span>
        <div className="m-lr-nums">
          第 {b.legs} 发 · ${b.spentUsd.toFixed(2)}{b.runningCost > 0 && ` (+$${b.runningCost.toFixed(2)} 进行中)`}
          {' · '}水位 {k(b.context.peak)}/{k(b.context.limit)} · {fmtDur(b.elapsedS)}
          {b.decisions > 0 && <span className="m-lr-warn"> · 监督者代你答了 {b.decisions} 次</span>}
        </div>
      </div>

      {b.needHuman && (
        <div className="m-lr-ask">
          <div className="m-lr-ask-title">🔔 执行者停下来等你拍板</div>
          {b.needHuman.needs && <div>需要你提供：<b>{b.needHuman.needs}</b></div>}
          {b.needHuman.reason && <div className="m-lr-dim">依据：{b.needHuman.reason}</div>}
          {b.needHuman.question && <pre className="m-lr-q">{b.needHuman.question}</pre>}
          <textarea className="m-lr-input" rows={3} value={answer} onChange={(e) => setAnswer(e.target.value)}
            placeholder="你的回答原样发给执行者，续同一会话" />
          <div className="m-lr-row">
            <button className="m-btn primary" disabled={busy || !answer.trim()} onClick={() => send(answer)}>回答并续跑</button>
            {/* 与电脑上一致：不回答就停机。手机误触代价大，要点两次 */}
            <ConfirmButton label="不回答，停机" confirmLabel="再点一次：停机" disabled={busy || !!answer.trim()}
              onConfirm={() => send('')} />
          </div>
        </div>
      )}

      {advice && (
        <div className={`m-lr-finish ${advice.tone}`}>
          <b>{advice.title}</b>
          <div>{advice.summary}</div>
          <div className="m-lr-dim">{advice.next}</div>
          {/* 结论文案与电脑共用，里面提到的「转为终端/续跑长程」手机上刻意不做 —— 说清楚，免得人找按钮 */}
          <div className="m-lr-dim">续跑或转为终端请到电脑上操作。</div>
        </div>
      )}

      {msg && <div className="m-lr-msg">{msg}</div>}
      <LongRunMobileActions task={task} onChanged={refresh} />

      <div className="m-lr-recent">
        <div className="m-lr-dim">最近进展</div>
        {b.recent.slice().reverse().map((e, i) => (
          <div key={`${e.at}-${i}`} className={`m-lr-item ${e.role}`}>
            <span className="m-lr-time">{hhmm(e.at)}</span> <b>{e.label}</b>
            {e.head && <span className="m-lr-dim"> {e.head}</span>}
            {e.body && <div className="m-lr-body">{e.body}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

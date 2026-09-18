import React, { useState, useEffect } from 'react';
import { HANDOFF_STEPS, handoffSummary } from './longrunHandoffView.js';

/**
 * 普通会话 → 长程 的「交接」向导。
 *
 * 这一步存在的理由：当前 CLI 对话里的进度、结论、失败过的方案全在它的上下文里，
 * 直接退出再开长程，接管方从 .memory 起步 —— 那一段全丢。所以先让它写进记忆再退。
 * 失败不退出：上下文还在 CLI 里，界面给「仍要开长程（跳过交接）」与「再等等」两个出口，由人决定。
 */
const LongRunHandoffDialog = ({ lr, socket, sessionId, sessionName, onSkip, onDone, onClose }) => {
  const [phase, setPhase] = useState('');      // '' = 还没开始
  const [seconds, setSeconds] = useState(0);
  const [busy, setBusy] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [prompt, setPrompt] = useState('');    // 指令原文从服务端取，前端不留副本
  const [result, setResult] = useState(null);  // 成功或失败的服务端返回
  const done = result?.ok;

  useEffect(() => { lr.call('longrun:handoffPrompt').then((r) => r?.ok && setPrompt(r.prompt)); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!socket) return undefined;
    const onProgress = (p) => { if (p?.sessionId === sessionId) { setPhase(p.phase || ''); setSeconds(p.seconds || 0); } };
    socket.on('longrun:handoffProgress', onProgress);
    return () => socket.off('longrun:handoffProgress', onProgress);
  }, [socket, sessionId]);

  const start = async () => {
    setBusy(true); setResult(null); setPhase(HANDOFF_STEPS.waiting);
    const r = await lr.call('longrun:handoff', { sessionId }, 8 * 60 * 1000);
    setBusy(false);
    if (r.ok && r.skipped) { onSkip(r.skipped); return; }   // CLI 没在跑，没什么可交接的
    setResult(r);
  };

  const summary = handoffSummary(result);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal confirm-modal lr-modal" style={{ maxWidth: 620 }} onClick={(e) => e.stopPropagation()}>
        <h2>交接给长程{sessionName ? `：${sessionName}` : ''}</h2>

        {!busy && !result && (
          <>
            <p className="lr-dim">
              转长程之前先做三件事：让这个会话把进度写进 Auto Memory → 确认写完后退出 CLI → 打开长程接管弹窗。
              它给出的「下一步」会预填进长程的新增需求，你可以改。
            </p>
            <div className="lr-handoff-why">
              不做这一步的后果：这段对话里的结论、决定的原因、失败过的方案都只在 CLI 上下文里，退出即丢，
              长程接管后会从头摸索一遍。
            </div>
            <button type="button" className="lr-link" onClick={() => setShowPrompt(!showPrompt)}>
              {showPrompt ? '收起' : '看看将要发给它的原话'}
            </button>
            {showPrompt && <pre className="lr-handoff-prompt">{prompt}</pre>}
          </>
        )}

        {busy && (
          <div className="lr-handoff-progress">
            <span className="lr-bell-dot" />
            {phase || '正在联系这个会话…'}
            {phase === HANDOFF_STEPS.writing && seconds > 0 && <span className="lr-dim">（已等 {seconds} 秒）</span>}
            <div className="lr-dim">这一步要等它自己写完，通常一两分钟。中途不会打断它正在跑的活。</div>
            <div className="lr-dim">现在关掉窗口也不影响：交接在后台照常走完（写完仍会退出 CLI），只是你看不到进度。</div>
          </div>
        )}

        {result && !done && (
          <div className="lr-handoff-fail">
            <div className="lr-err">没能完成交接：{result.error}</div>
            <div className="lr-dim">CLI 没有退出，上下文还在，你可以再试一次或自己去看一眼。</div>
            {result.reply && <pre className="lr-handoff-prompt">{result.reply}</pre>}
          </div>
        )}

        {done && (
          <div className="lr-handoff-ok">
            <div className="lr-handoff-sum">{summary}</div>
            {result.receipt?.files?.length > 0 && (
              <div className="lr-handoff-files">{result.receipt.files.map((f) => <code key={f}>{f}</code>)}</div>
            )}
            <pre className="lr-handoff-prompt">{result.reply}</pre>
            {!result.exited && <div className="lr-err">{result.note}</div>}
          </div>
        )}

        <div className="modal-actions">
          {/* 等待期最长六分多钟，这期间必须留得出出口：关窗只是不看了，服务端那边照走 */}
          {!result && <button className="btn btn-secondary" onClick={onClose}>{busy ? '先关掉窗口' : '取消'}</button>}
          {!busy && !result && <button className="btn btn-primary" onClick={start}>开始交接</button>}
          {result && !done && (
            <>
              <button className="btn btn-secondary" onClick={onClose}>再等等</button>
              <button className="btn btn-secondary" onClick={() => onSkip('user_skipped')}
                title="跳过交接直接开长程：这段对话的上下文不会进记忆">仍要开长程</button>
              <button className="btn btn-primary" onClick={start}>再试一次</button>
            </>
          )}
          {done && (
            <>
              <button className="btn btn-secondary" onClick={onClose} title="交接已完成，记忆已写好；长程随时可以再开">稍后再说</button>
              <button className="btn btn-primary" onClick={() => onDone(result.receipt)}>继续开长程</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default LongRunHandoffDialog;

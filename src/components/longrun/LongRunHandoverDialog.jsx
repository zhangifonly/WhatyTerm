import React, { useState, useEffect } from 'react';

const MODES = [
  ['auto', '按水位自动选（推荐）'],
  ['resume', '续同一对话'],
  ['fresh', '开新对话，从记忆接上'],
];

/**
 * 「转为终端」确认框（样式同其它确认弹窗）。先取交接计划给人看：接续方式、理由、要在终端里打的命令；
 * 确认后同一条目切回终端模式，claude 在它的 tmux 里接着干。
 */
const LongRunHandoverDialog = ({ lr, sessionId, sessionName, onClose }) => {
  const [mode, setMode] = useState('auto');
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setPlan(null); setError('');
    lr.call('longrun:handoverPlan', { sessionId, mode }).then((r) => {
      if (!alive) return;
      if (r.ok) setPlan(r); else setError(r.error);
    });
    return () => { alive = false; };
  }, [sessionId, mode]);   // eslint-disable-line react-hooks/exhaustive-deps

  const confirm = async () => {
    setBusy(true); setError('');
    const r = await lr.call('longrun:toTerminal', { sessionId, mode });
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    onClose(r);
  };

  return (
    <div className="modal-overlay" onClick={() => onClose(null)}>
      <div className="modal confirm-modal lr-modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <h2>转为终端{sessionName ? `：${sessionName}` : ''}</h2>
        <p className="lr-dim">同一条目切回终端，在它的 tmux 里用交互式 claude 接着开发。记忆（.memory）与长程共用；自动操作先关着，水位只告警。</p>
        <div className="lr-row lr-mb">
          {MODES.map(([k, label]) => (
            <label key={k}><input type="radio" checked={mode === k} onChange={() => setMode(k)} /> {label}</label>
          ))}
        </div>
        {!plan && !error && <div className="lr-dim">正在读取上一轮的记录…</div>}
        {plan && (
          <div className="lr-plan">
            <div>接续方式：<b>{plan.mode === 'resume' ? '续同一对话' : '开新对话'}</b></div>
            <div className="lr-kv">{plan.reason}</div>
            {plan.claudeSessionId && <div className="lr-kv">claude 会话：{plan.claudeSessionId}（来自{plan.idSource}）</div>}
            <div className="lr-kv">终端里将执行：</div>
            <pre className="lr-pre">{plan.shellLine}</pre>
            {plan.mode === 'fresh' && <div className="lr-kv">claude 就绪后会先发「新对话开始提示词」，让它从记忆接上进度。</div>}
            {plan.providerId && <div className="lr-kv">会恢复长程期间移走的会话级供应商。</div>}
          </div>
        )}
        {error && <pre className="lr-err lr-pre">{error}</pre>}
        <div className="modal-actions" style={{ justifyContent: 'flex-end', gap: 12 }}>
          <button className="btn btn-secondary" onClick={() => onClose(null)}>取消</button>
          <button className="btn btn-primary" disabled={busy || !plan} onClick={confirm}>{busy ? '正在转换…' : '转为终端'}</button>
        </div>
      </div>
    </div>
  );
};

export default LongRunHandoverDialog;

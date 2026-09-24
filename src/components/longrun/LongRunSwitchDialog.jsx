import React, { useState, useEffect } from 'react';

const TO_TEXT = { longrun: '转为长程', terminal: '转为终端' };
const MODE_LABEL = { resume_session: '续同一条对话', handoff: '交接后开新对话' };

/**
 * 长程 ⇄ 终端 切换的确认框。
 *
 * 先出预检计划再动手：两个方向的失败代价不对称 ——
 * 转长程时 CLI 还在跑会让编排器和人同时按键；转终端时长程还在跑会打断执行者、丢掉当前发的成果。
 * 所以 blockers 直接禁用按钮，warnings 只提示。
 */
const LongRunSwitchDialog = ({ lr, sessionId, sessionName, to, onClose, onNeedHandoff, onNeedStart }) => {
  const [plan, setPlan] = useState(null);
  const [mode, setMode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [stage, setStage] = useState('');   // 长动作进行中的说明（等 CLI 退出可能要一分钟）

  useEffect(() => {
    let alive = true;
    lr.call('longrun:switchPlan', { sessionId, to }).then((r) => {
      if (!alive) return;
      setPlan(r);
      if (r?.suggest?.mode) setMode(r.suggest.mode);
    });
    return () => { alive = false; };
  }, [sessionId, to]);   // eslint-disable-line react-hooks/exhaustive-deps

  const confirm = async () => {
    setBusy(true); setErr('');
    if (to === 'terminal') {
      const r = await lr.call('longrun:toTerminal', { sessionId, mode: 'auto' });
      setBusy(false);
      if (!r?.ok) { setErr(r?.error || '切换失败'); return; }
      onClose(r);
      return;
    }
    // 转长程分两条路，都要先让交互式 CLI 退出（否则长程与它会抢同一条对话）：
    //   续同一条对话：直接退出，不写记忆 —— 对话由长程用 --resume 接着续；
    //   交接：交给交接向导，它先让 CLI 写记忆、再退出。
    if (mode === 'resume_session') {
      if (plan.cliRunning) {
        setStage('正在让 CLI 退出…（它若正在干活会等它回到输入框，最多 60 秒）');
        const q = await lr.call('longrun:quitCli', { sessionId }, 120000);
        setStage('');
        if (!q?.ok) { setBusy(false); setErr(q?.error || 'CLI 没能退出'); return; }
      }
      setBusy(false);
      onNeedStart({ resumeSessionId: plan.claudeSessionId, root: plan.root });
      return;
    }
    setBusy(false);
    onNeedHandoff({ root: plan.root });
  };

  const blocked = !plan || !plan.ok || busy;

  return (
    <div className="modal-overlay" onClick={() => !busy && onClose(null)}>
      <div className="modal confirm-modal lr-modal" style={{ maxWidth: 580 }} onClick={(e) => e.stopPropagation()}>
        <h2>{TO_TEXT[to]}{sessionName ? `：${sessionName}` : ''}</h2>

        {!plan && <p className="lr-dim">正在检查…</p>}

        {plan && (
          <>
            <p className="lr-dim">
              {to === 'longrun'
                ? '同一个条目、同一个 tmux、同一份记忆，只是换成无人值守的编排来驱动。'
                : '同一个条目切回终端，你自己接着开发。长程的进度与花费都留着，之后转回去是续跑。'}
            </p>

            {plan.blockers?.length > 0 && (
              <div className="lr-sw-block">
                {plan.blockers.map((b) => <div key={b} className="lr-err">✗ {b}</div>)}
              </div>
            )}
            {plan.warnings?.length > 0 && (
              <div className="lr-sw-warn">
                {plan.warnings.map((w) => <div key={w}>！{w}</div>)}
              </div>
            )}

            {/* 续接方式只在转长程时要选 */}
            {to === 'longrun' && plan.ok && plan.suggest && (
              <div className="lr-sw-modes">
                {plan.suggest.options.map((o) => (
                  <label key={o.mode} className={`lr-sw-mode${mode === o.mode ? ' on' : ''}`}>
                    <input type="radio" checked={mode === o.mode} disabled={plan.suggest.forced && o.mode === 'resume_session'}
                      onChange={() => setMode(o.mode)} />
                    <span className="lr-sw-mode-t">
                      {o.label}
                      {plan.suggest.mode === o.mode && <span className="lr-sw-tag">推荐</span>}
                    </span>
                    <span className="lr-dim lr-sw-mode-d">{o.detail}</span>
                  </label>
                ))}
                <p className="lr-dim lr-sw-why">{plan.suggest.reason}</p>
                {mode === 'resume_session' && (
                  <p className="lr-dim">续接前会先告诉它「运行方式变了」：权限白名单更严、需要决策时停下问你。不静默换规则。</p>
                )}
              </div>
            )}

            {plan.prior?.legs != null && (
              <p className="lr-dim lr-sw-prior">
                这个项目的长程累计：调用 {plan.prior.legs} 次 · 花费 ${Number(plan.prior.spentUsd || 0).toFixed(2)}
                {plan.prior.memoryCount ? ` · ${plan.prior.memoryCount} 个记忆文件` : ''}
              </p>
            )}
          </>
        )}

        {stage && <p className="lr-dim">{stage}</p>}
        {err && <div className="lr-err">{err}</div>}

        <div className="modal-actions">
          <button className="btn btn-secondary" disabled={busy} onClick={() => onClose(null)}>取消</button>
          <button className="btn btn-primary" disabled={blocked} onClick={confirm}>
            {busy ? '处理中…' : TO_TEXT[to]}
          </button>
        </div>
      </div>
    </div>
  );
};

export default LongRunSwitchDialog;

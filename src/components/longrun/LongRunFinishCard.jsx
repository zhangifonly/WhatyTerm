import React, { useState } from 'react';
import { longRunAdvice, outcomeLine } from './longrunAdvice.js';

/**
 * 收工结论卡（主区底部，占原来那一行说明的位置）。
 *
 * 要解决的是「跑完了看不出来，也不知道接着该干什么」：
 *   标题一眼看出结果 → 一句话结论（带实测数字）→ 本轮产出了什么 → 建议你现在做什么 → 两个动作按钮。
 * 文案与右侧面板同源（都走 longRunAdvice），不写两套。
 */
const LongRunFinishCard = ({ report, outcome: outcomeProp, board, onResume, onHandover }) => {
  const advice = longRunAdvice(report, board);
  const [copied, setCopied] = useState('');
  if (!advice) return null;
  const outcome = outcomeProp || advice.outcome;
  const line = outcomeLine(outcome);

  const copyCommit = async () => {
    try { await navigator.clipboard.writeText(outcome.commit); setCopied(outcome.commit); } catch { setCopied(''); }
  };

  return (
    <div className={`lr-finish ${advice.tone}`}>
      <div className="lr-finish-head">
        <span className={`lr-badge ${advice.tone}`}>{board?.replay ? '上一轮' : '本轮'}</span>
        <b className="lr-finish-title">{advice.title}</b>
      </div>
      <div className="lr-finish-summary">{advice.summary}</div>
      <div className="lr-finish-facts">
        {advice.facts.map(([k, v]) => <span key={k}><i>{k}</i> {v}</span>)}
      </div>
      {(line || outcome?.commit) && (
        <div className="lr-finish-outcome">
          {outcome?.commit && (
            <button type="button" className="lr-link" onClick={copyCommit} title="点击复制，然后 git show 看这一轮改了什么">
              快照 {outcome.commit}{copied === outcome.commit ? '（已复制）' : ''}
            </button>
          )}
          {line && <span className="lr-dim">{line}</span>}
        </div>
      )}
      <div className="lr-finish-next">{advice.next}</div>
      <div className="lr-composer-bar">
        <span className="lr-grow" />
        <button className="btn btn-secondary btn-small" onClick={onResume} title={advice.actions[1].hint}>续跑长程…</button>
        <button className="btn btn-primary btn-small" onClick={onHandover} title={advice.actions[0].hint}>转为终端…</button>
      </div>
    </div>
  );
};

export default LongRunFinishCard;

import React, { useState, useEffect } from 'react';
import { socket } from './socket';

/**
 * AI 状态卡：当前阶段/状态 + 需操作时的大按钮「执行 AI 建议」+ 自动模式开关。
 * ai:execute payload 对齐桌面版 App.jsx executeSuggestion。
 */
export default function AiCard({ session, aiStatus, loading }) {
  const [executed, setExecuted] = useState(false);

  // 状态更新（新一轮分析）后解除"已执行"标记
  useEffect(() => { setExecuted(false); }, [aiStatus?.updatedAt]);

  const needsAction = !!aiStatus?.needsAction && !session.autoActionEnabled;
  const suggestion = aiStatus?.suggestion;

  const execute = () => {
    if (executed) return;
    socket.emit('ai:execute', {
      sessionId: session.id,
      command: suggestion?.command || aiStatus?.suggestedAction,
      reasoning: suggestion?.reasoning || aiStatus?.actionReason
    });
    setExecuted(true);
  };

  const toggleAuto = () => {
    socket.emit('ai:toggleAutoAction', {
      sessionId: session.id,
      enabled: !session.autoActionEnabled
    });
  };

  return (
    <div className={`m-aicard ${needsAction ? 'needs-action' : ''}`}>
      <div className="m-aicard-row">
        <span className="m-aicard-state">
          {loading ? '⏳ 分析中…' : (aiStatus?.currentState || '等待分析')}
        </span>
        <button
          className={`m-btn m-auto-btn ${session.autoActionEnabled ? 'on' : ''}`}
          onClick={toggleAuto}
        >
          {session.autoActionEnabled ? '🤖 自动中' : '手动'}
        </button>
      </div>
      {aiStatus?.actionReason && (
        <div className="m-aicard-reason">{aiStatus.actionReason}</div>
      )}
      {needsAction && (aiStatus?.suggestedAction || suggestion?.command) && (
        <button className="m-btn primary m-exec-btn" onClick={execute} disabled={executed}>
          {executed ? '✓ 已发送' : `执行建议：${suggestion?.command || aiStatus.suggestedAction}`}
        </button>
      )}
    </div>
  );
}

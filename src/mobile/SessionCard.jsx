import React from 'react';

const AI_COLORS = {
  claude: '#d97757', codex: '#10a37f', gemini: '#4285f4',
  grok: '#8b5cf6', droid: '#f59e0b', opencode: '#06b6d4'
};

/** 单个会话卡片：名称 + CLI 徽标 + AI 状态行 + 内存；needsAction 高亮 */
/** 长程条目的状态文案。长程不经过 AI 监控，不能用 aiStatus（那里永远是「等待分析」） */
function longRunText(t) {
  if (!t) return '长程 · 没有运行中的任务';
  if (t.state === 'running' && t.awaitingHuman) return '🔔 长程在等你回答';
  if (t.state === 'running') return `长程运行中 · 第 ${t.legs || 0} 发 · $${Number(t.costUsd || 0).toFixed(2)}`;
  return `长程已收工 · ${t.legs || 0} 发 · $${Number(t.costUsd || 0).toFixed(2)}`;
}

export default function SessionCard({ session, aiStatus, loading, memory, onClick, pinned, lrTask }) {
  const isLongRun = session.runMode === 'longrun';
  const lrWaiting = isLongRun && lrTask?.state === 'running' && !!lrTask.awaitingHuman;
  const needsAction = isLongRun ? lrWaiting : (!!aiStatus?.needsAction && !session.autoActionEnabled);
  const stateText = isLongRun ? longRunText(lrTask) : (aiStatus?.currentState || aiStatus?.phaseName || '等待分析');
  const aiType = (session.aiType || 'claude').toLowerCase();

  return (
    <div
      className={`m-card ${needsAction ? 'needs-action' : ''}`}
      onClick={onClick}
      role="button"
    >
      <div className="m-card-row">
        <span className="m-ai-badge" style={{ background: isLongRun ? '#7c3aed' : (AI_COLORS[aiType] || '#666') }}>
          {isLongRun ? '🧭 长程' : aiType.toUpperCase()}
        </span>
        {pinned && <span className="m-pin-tag" title="已置顶（与电脑端同步）">📌</span>}
        <span className="m-card-name">{session.projectName || session.name}</span>
        {session.autoActionEnabled && <span className="m-auto-tag">🤖 自动</span>}
        {needsAction && <span className="m-action-tag">⚠ 需操作</span>}
      </div>
      <div className="m-card-state">
        {loading ? '分析中…' : stateText}
        {needsAction && aiStatus?.suggestedAction && (
          <span className="m-card-suggest">→ {aiStatus.suggestedAction}</span>
        )}
      </div>
      <div className="m-card-meta">
        {(session.projectDesc || session.goal || session.workingDir || '').slice(0, 50)}
        {memory?.memory > 0 && (
          <span className={memory.memory > 500 ? 'm-mem high' : 'm-mem'}>
            {Math.round(memory.memory)}MB
          </span>
        )}
      </div>
    </div>
  );
}

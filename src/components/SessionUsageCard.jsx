import React from 'react';

/**
 * AI 面板的「用量与预算」卡片：这个会话里 CLI 自己花的钱（不含 WebTmux 监控自身的调用）。
 *
 * 三种拿不到数的情况必须如实说，不能显示 $0 —— $0 会被读成"没花钱"：
 *   · 该 CLI 不在本地记录用量（Grok 实测如此）
 *   · 同目录同类型多个会话在跑，分不清是谁花的
 *   · 模型不在价格表里，费用只含已知模型
 */
const money = (n) => `$${Number(n || 0).toFixed(2)}`;

const SessionUsageCard = ({ usage }) => {
  if (!usage) return null;
  if (usage.kind === 'unsupported' || usage.kind === 'ambiguous') {
    return (
      <div className="ai-status-section">
        <h4>用量</h4>
        <p className="usage-note">{usage.reason || '拿不到这个会话的用量'}</p>
        <p className="usage-note dim">
          {usage.kind === 'unsupported' ? '换成 Claude 或 Codex 的会话就能看到花费。' : '等同目录里其它同类会话结束后即可区分。'}
        </p>
      </div>
    );
  }
  const today = Number(usage.today || 0);
  const total = Number(usage.usd || 0);
  return (
    <div className="ai-status-section">
      <h4>用量</h4>
      <div className="usage-row">
        <span className="usage-main">{money(total)}</span>
        <span className="usage-sub">本会话累计</span>
      </div>
      <div className="usage-row">
        <span className="usage-today">{money(today)}</span>
        <span className="usage-sub">今天</span>
        {usage.model && <span className="usage-model">{usage.model}</span>}
      </div>
      {usage.estimated && (
        <p className="usage-note" title="CLI 只偶尔写一次自记账；这之后的部分按 CC Switch 价格表折算，实测偏差约 15%">
          估算值：这份记录里没有 CLI 自己的账，全部按价格表折算
        </p>
      )}
      {usage.incomplete && <p className="usage-note">费用不完整：有模型不在价格表里，只统计了已知模型</p>}
    </div>
  );
};

export default SessionUsageCard;

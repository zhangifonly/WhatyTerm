import React, { useState } from 'react';

/**
 * AI 面板的「用量」卡片：这个会话里 CLI 自己花的钱（不含 WebTmux 监控自身的调用）。
 * 用户明确不要预算限制，这里只统计与显示，不设任何闸。
 *
 * 三种拿不到数的情况必须如实说，不能显示 $0 —— $0 会被读成"没花钱"：
 *   · 该 CLI 不在本地记录用量（Grok 实测如此）
 *   · 同目录同类型多个会话在跑，分不清是谁花的
 *   · 模型不在价格表里，费用只含已知模型
 */
const money = (n) => `$${Number(n || 0).toFixed(2)}`;

/**
 * 价格表缺哪些在用模型（全局，所有会话 + 长程共用一张表）。收成一行，点开看清单。
 * 价格在 CC Switch 里维护：模型更新后在那边补一条，这里 10 分钟内自动按新价重算，不用重启。
 */
export const MissingPrices = ({ data }) => {
  const [open, setOpen] = useState(false);
  if (!data) return null;
  if (!data.tableFound) {
    return <p className="usage-note">没找到 CC Switch 的价格表（~/.cc-switch/cc-switch.db），费用只能显示未知</p>;
  }
  const models = data.models || [];
  if (!models.length) return null;
  return (
    <div className="usage-missing">
      <button type="button" className="usage-missing-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} 价格表缺 {models.length} 个在用模型
      </button>
      {open && (
        <>
          <ul className="usage-missing-list">
            {models.map((m) => (
              <li key={m.model}><code>{m.model}</code>{m.sessions > 0 && <span className="dim"> · {m.sessions} 个会话在用</span>}</li>
            ))}
          </ul>
          <p className="usage-note dim">到 CC Switch「模型定价」按官网价补上，10 分钟内自动按新价重算（已用的 token 也会补算）。</p>
        </>
      )}
    </div>
  );
};

const SessionUsageCard = ({ usage, missingPrices }) => {
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
      {/* 只在真有缺价模型时说"不在价格表里"：不完整也可能只是还没有可计价的调用（金额本来就是 0） */}
      {usage.incomplete && usage.unknownModels?.length > 0 && (
        <p className="usage-note">
          费用不完整：{usage.unknownModels.join('、')} 不在价格表里，这部分没算进去
        </p>
      )}
      <MissingPrices data={missingPrices} />
    </div>
  );
};

export default SessionUsageCard;

import React from 'react';
import PricingNotes from './PricingNotes.jsx';

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
// 服务端已把 claude-opus-5.5 / claude-opus-5-5 这类同模型两种写法合成一行，比较时同样归一
const sameModel = (a, b) => !!a && !!b && a.toLowerCase().replace(/\./g, '-') === b.toLowerCase().replace(/\./g, '-');
const pct = (part, whole) => {
  if (!(whole > 0)) return '—';
  const p = (part / whole) * 100;
  if (p > 0 && p < 1) return '<1%';      // 花了钱却显示 0% 会被读成没用过
  if (p > 99 && p < 100) return '>99%';  // 同理，别的模型也花了钱，不能显示成 100%
  return `${Math.round(p)}%`;
};
const tokens = (n) => {
  const v = Number(n || 0);
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
};


const sumTok = (m) => (m.input || 0) + (m.cacheRead || 0) + (m.cacheWrite || 0) + (m.output || 0);
/** 「输入 1.2M · 缓存读 30M · 输出 300K」：缓存读通常占九成以上，不拆开看会以为输入量大得离谱 */
const tokParts = (m) => [['输入', m.input], ['缓存读', m.cacheRead], ['缓存写', m.cacheWrite], ['输出', m.output]]
  .filter(([, v]) => v > 0).map(([k, v]) => `${k} ${tokens(v)}`).join(' · ');
const sinceLabel = (ms) => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const SessionUsageCard = ({ usage, pricing }) => {
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
  // 用过两个及以上模型才列明细；只有一个模型时维持原来的一行显示，不多占地方
  const models = (usage.byModel || []).filter((m) => m.usd > 0);
  const multi = models.length >= 2;
  const allRows = usage.byModel || [];
  const totalTok = allRows.reduce((a, m) => a + sumTok(m), 0);
  const todayTok = allRows.reduce((a, m) => a + (m.todayTokens || 0), 0);
  const tokSum = allRows.reduce((acc, m) => {
    for (const k of ['input', 'cacheRead', 'cacheWrite', 'output']) acc[k] = (acc[k] || 0) + (m[k] || 0);
    return acc;
  }, {});
  // token 列在 v1.4.79 之前记错了（Codex 每轮重复累加累计值），升级时清零重计：起点之后才有数
  const recentSince = usage.tokensSince > 0 && Date.now() - usage.tokensSince < 30 * 86400e3;
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
        {!multi && usage.model && <span className="usage-model">{usage.model}</span>}
      </div>
      {totalTok > 0 && (
        <div className="usage-tokens" title={tokParts(tokSum)}>
          <span className="usage-tok-main">{tokens(totalTok)}</span>
          <span className="usage-sub">token</span>
          {todayTok > 0 && <span className="usage-sub">· 今天 {tokens(todayTok)}</span>}
          <div className="usage-tok-parts">{tokParts(tokSum)}</div>
        </div>
      )}
      {multi && (
        <table className="usage-models" aria-label="按模型的用量">
          <thead>
            <tr><th scope="col">模型</th><th scope="col">累计</th><th scope="col">今天</th><th scope="col">占比</th></tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <React.Fragment key={m.model}>
                <tr className={`usage-model-row${sameModel(m.model, usage.model) ? ' current' : ''}`}>
                  <td className="usage-model-name">{m.model}{sameModel(m.model, usage.model) && <span className="usage-current-tag">当前</span>}</td>
                  <td>{money(m.usd)}</td>
                  <td className={m.today > 0 ? '' : 'dim'}>{money(m.today)}</td>
                  <td className="dim">{pct(m.usd, total)}</td>
                </tr>
                <tr className="usage-model-tok">
                  <td colSpan={4}>{sumTok(m) > 0 ? `${tokens(sumTok(m))} token：${tokParts(m)}` : (recentSince ? '统计起点之后没再用过' : '没有 token 记录')}</td>
                </tr>
              </React.Fragment>
            ))}
          </tbody>
        </table>
      )}
      {recentSince && (
        <p className="usage-note dim">token 自 {sinceLabel(usage.tokensSince)} 起统计（此前的记录有误，已清零重计）</p>
      )}
      {usage.scanning > 0 && (
        <p className="usage-note dim">正在首次按模型拆分记录（{usage.scanning}%），完成前新增费用暂不计入</p>
      )}
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
      {usage.autoModels?.length > 0 && (
        <p className="usage-note dim" title="CC Switch 里没有这些模型，价格取自 LiteLLM 社区价格表（每天自动更新）；在 CC Switch 里填了价就以它为准">
          {usage.autoModels.join('、')} 按自动价格（LiteLLM）折算
        </p>
      )}
      <PricingNotes data={pricing} />
    </div>
  );
};

export default SessionUsageCard;

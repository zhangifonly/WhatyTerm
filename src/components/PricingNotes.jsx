import React, { useState } from 'react';

const $ = (n) => `$${Number(n)}`;

/** 一行可展开的提示：标题常显，明细点开才看（这些不是每次都要看的东西，别占面板） */
const Fold = ({ title, tone = '', children }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="usage-missing">
      <button type="button" className={`usage-missing-toggle ${tone}`} onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} {title}
      </button>
      {open && children}
    </div>
  );
};

/**
 * 价格表状况（全局：所有会话 + 长程共用一张价格表）。
 * 两层价格：CC Switch「模型定价」优先（你能直接改的地方），没有的由 LiteLLM 自动补（每天更新）。
 * 只列最近 7 天真正用到的模型，没用到的不打扰。
 */
const PricingNotes = ({ data }) => {
  if (!data) return null;
  const { missing = [], autoPriced = [], conflicts = [], auto = {} } = data;
  const n = (x) => (x.sessions > 0 ? <span className="dim"> · {x.sessions} 个会话在用</span> : null);
  return (
    <>
      {!data.tableFound && !auto.ok && (
        <p className="usage-note">没找到 CC Switch 的价格表，自动价格也没拉到，费用只能显示未知</p>
      )}
      {missing.length > 0 && (
        <Fold title={`价格表缺 ${missing.length} 个在用模型`}>
          <ul className="usage-missing-list">
            {missing.map((m) => <li key={m.model}><code>{m.model}</code>{n(m)}</li>)}
          </ul>
          <p className="usage-note dim">
            CC Switch 和自动价格表（LiteLLM）里都没有。可到 CC Switch「模型定价」按官网价补上，10 分钟内自动重算（已用的 token 也会补算）。
          </p>
        </Fold>
      )}
      {autoPriced.length > 0 && (
        <Fold title={`${autoPriced.length} 个模型用的是自动价格`} tone="dim">
          <ul className="usage-missing-list">
            {autoPriced.map((m) => (
              <li key={m.model}><code>{m.model}</code> {$(m.in)} / {$(m.out)} 每百万 token{n(m)}</li>
            ))}
          </ul>
          <p className="usage-note dim">
            CC Switch 里没有这些模型，价格取自 LiteLLM 社区价格表（每天自动更新）。要改价就在 CC Switch 里填，填了以它为准。
          </p>
        </Fold>
      )}
      {conflicts.length > 0 && (
        <Fold title={`${conflicts.length} 个模型 CC Switch 的价格可能过时`}>
          <ul className="usage-missing-list">
            {conflicts.map((c) => (
              <li key={c.model}><code>{c.model}</code> CC Switch {$(c.ccswitch.in)}/{$(c.ccswitch.out)}，LiteLLM {$(c.auto.in)}/{$(c.auto.out)}</li>
            ))}
          </ul>
          <p className="usage-note dim">现在按 CC Switch 的价计费。核对官网后，如果 CC Switch 这条旧了，到「模型定价」里改掉即可。</p>
        </Fold>
      )}
      {auto.error && (
        <p className="usage-note dim">
          自动价格表{auto.ok ? `今天没更新成功，继续用 ${new Date(auto.fetchedAt).toLocaleDateString('zh-CN')} 的缓存` : '拉取失败'}：{auto.error}
        </p>
      )}
    </>
  );
};

export default PricingNotes;

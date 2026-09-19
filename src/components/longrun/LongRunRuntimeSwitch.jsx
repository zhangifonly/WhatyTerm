import React, { useState, useEffect } from 'react';

/**
 * 运行中换供应商 / 换模型（右侧面板，执行者卡片里）。
 *
 * 为什么放在这里：Hitech 那两轮全败于「503 无可用渠道」，当时只能停机、改配置、重开一轮。
 * 现在跑着就能换 —— **下一发生效，当前这发照常跑完**，不丢已经做出来的东西。
 *
 * 换供应商与换模型的区别要让人看见：换模型只是同一家换个型号；
 * 换供应商意味着接下来的代码发往另一家中转站、费用记在那边，所以文案上说清。
 */
const LongRunRuntimeSwitch = ({ lr, taskId, running, currentModel, currentProviderId }) => {
  const [open, setOpen] = useState(false);
  const [providers, setProviders] = useState([]);
  const [models, setModels] = useState({ loading: true });
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!open) return;
    fetch('/api/cc-switch/providers?app=claude').then((r) => r.json())
      .then((res) => setProviders(res?.providers || res?.data?.providers || [])).catch(() => {});
  }, [open]);

  // 模型清单跟着供应商走：换了供应商再拉一次，否则会选出个上一家才有的模型
  useEffect(() => {
    if (!open) return;
    setModels({ loading: true });
    lr.call('longrun:providerModels', { providerId: currentProviderId || '' }, 20000)
      .then((r) => setModels({ loading: false, ...r }));
  }, [open, currentProviderId]);   // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (event, payload, label) => {
    setBusy(label); setErr(''); setMsg('');
    const r = await lr.call(event, { taskId, ...payload });
    setBusy('');
    if (!r?.ok) { setErr(r?.error || '切换失败'); return; }
    setMsg(r.note || '已切换');
  };

  if (!running) return null;

  return (
    <div className="lr-rt-switch">
      <button type="button" className="lr-link" onClick={() => setOpen(!open)}>
        {open ? '收起' : '换供应商 / 换模型…'}
      </button>
      {open && (
        <div className="lr-rt-body">
          <p className="lr-dim lr-rt-note">都是<strong>下一发生效</strong>，当前这发照常跑完，不会丢掉它已经做出来的东西。</p>

          <label className="lr-rt-label">执行者模型</label>
          {models.loading ? (
            <div className="lr-dim">正在查当前供应商支持的模型…</div>
          ) : models.ok && models.models?.length ? (
            <select className="lr-select" value={currentModel || ''} disabled={!!busy}
              onChange={(e) => act('longrun:setModel', { model: e.target.value }, 'model')}>
              <option value="">跟随供应商默认{models.configured ? `（${models.configured}）` : ''}</option>
              {models.models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          ) : (
            <>
              <input className="lr-rt-input" defaultValue={currentModel || ''} placeholder="留空 = 跟随默认"
                disabled={!!busy}
                onKeyDown={(e) => { if (e.key === 'Enter') act('longrun:setModel', { model: e.target.value }, 'model'); }} />
              <div className="lr-dim">拿不到模型清单{models.error ? `（${models.error}）` : ''}，手填后按回车。填错会在下一发报「无可用渠道」，那时会自动等待重试。</div>
            </>
          )}

          <label className="lr-rt-label">供应商（CC Switch）</label>
          <select className="lr-select" value={currentProviderId || ''} disabled={!!busy}
            onChange={(e) => act('longrun:setProvider', { providerId: e.target.value }, 'provider')}>
            <option value="">{currentProviderId ? '（保持不变）' : '跟随 CC Switch 当前配置'}</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{p.name}{p.isCurrent ? '（当前）' : ''}</option>
            ))}
          </select>
          <p className="lr-dim lr-rt-warn">
            换供应商后，接下来的代码会发往那一家、费用记在那边。自动恢复从不替你换供应商，只有这里点选才换。
          </p>

          {busy && <div className="lr-dim">正在切换…</div>}
          {msg && <div className="lr-rt-ok">{msg}</div>}
          {err && <div className="lr-err">{err}</div>}
        </div>
      )}
    </div>
  );
};

export default LongRunRuntimeSwitch;

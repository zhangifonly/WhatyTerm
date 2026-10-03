import React, { useState, useEffect } from 'react';
import { executorUi } from './longrunExecutors.js';

/**
 * 执行者模型选择。
 *
 * 为什么要有：Hitech 那两轮长程全败在
 * `503 分组 zhangzong 下模型 claude-fable-5-1 无可用渠道`。在此之前模型只是高级参数里
 * 一个手输文本框，人既不知道当前供应商支持什么、也验证不了填得对不对，
 * 而填错的代价是十次重试 + 一发白跑（那次 $0.94 全花在重试上）。
 *
 * 清单来自供应商自己的 /v1/models。拿不到就退回手输并说明原因 ——
 * 编一份清单只会再撞「无可用渠道」，比没有清单更坏。
 */
const LongRunModelPicker = ({ lr, providerId, executor = 'claude', value, onChange }) => {
  const [state, setState] = useState({ loading: true });
  const [manual, setManual] = useState(false);

  const load = (refresh = false) => {
    setState({ loading: true });
    lr.call('longrun:providerModels', { providerId: providerId || '', refresh, executor }, 40000)
      .then((r) => setState({ loading: false, ...r }));
  };

  // 换供应商就得重查：不同中转站支持的模型不一样，沿用上一个的清单会选出个不存在的
  // 换执行者也要重查：Cursor 的清单来自 Cursor 账号，与 CC Switch 供应商无关
  useEffect(() => { load(false); }, [providerId, executor]);   // eslint-disable-line react-hooks/exhaustive-deps

  const ui = executorUi(executor);
  const models = state.models || [];
  const showSelect = !manual && state.ok && models.length > 0;
  // 供应商配置里写死的模型可能不在清单里（中转站列表未必完整），补进去免得被"纠正"掉
  const options = state.configured && !models.includes(state.configured)
    ? [state.configured, ...models] : models;

  return (
    <div className="form-group">
      <label>
        执行者模型
        {showSelect && <span className="lr-dim"> · {ui.modelsFrom} {models.length} 个</span>}
      </label>

      {state.loading && <div className="lr-dim">正在查{ui.modelsFrom}的模型…</div>}

      {!state.loading && showSelect && (
        <select className="lr-select" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{ui.defaultModel ? `留空 = 默认（${ui.defaultModel}）` : `留空 = 用供应商默认${state.configured ? `（${state.configured}）` : ''}`}</option>
          {options.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      )}

      {!state.loading && !showSelect && (
        <>
          <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="留空 = 用供应商默认" />
          {state.error && <div className="lr-dim">拿不到模型清单（{state.error}），只能手填。填错会在开跑后报「无可用渠道」。</div>}
        </>
      )}

      {!state.loading && (
        <div className="lr-row lr-mt">
          <button type="button" className="lr-link" onClick={() => load(true)}>重新查询</button>
          {state.ok && models.length > 0 && (
            <button type="button" className="lr-link" onClick={() => setManual(!manual)}>
              {manual ? '从清单里选' : '手动填一个清单外的'}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default LongRunModelPicker;

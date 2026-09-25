import React from 'react';
import LongRunRuntimeSwitch from './LongRunRuntimeSwitch.jsx';
import { ctxView, fmtDur } from './longrunBoard.js';

/**
 * 长程右侧面板的几块卡片，版式照搬 AI 面板（头部统计悬浮框、CLAUDE 供应商卡、上下文水位条），
 * 同一个位置放同一类信息，切换条目时眼睛不用重新找。
 */

/** 头部「N次 ⇄N $x」与悬浮明细（同 AI 面板的操作统计） */
export const HeaderStats = ({ board, task }) => {
  const spent = board?.spent_usd || 0;
  const item = (label, value, cls = '') => (
    <div className="tooltip-item"><span className="tooltip-label">{label}:</span><span className={`tooltip-value ${cls}`}>{value}</span></div>
  );
  return (
    <span className="ai-stats-wrapper">
      <span className="ai-stats">{board?.legs || 0}次 ⇄{board?.handoffs || 0} ${spent.toFixed(2)}</span>
      <div className="ai-stats-tooltip">
        <div className="tooltip-title">长程统计</div>
        {item('调用执行者', `${board?.legs || 0} 次`)}
        {item('上下文交接', `${board?.handoffs || 0} 次`)}
        {item('记忆维护', `${board?.maintenances || 0} 轮`)}
        {item('监督者代你作答', `${board?.decisions || 0} 次`, board?.decisions ? 'failed' : '')}
        <div className="tooltip-divider"></div>
        {item('已结算花费', `$${spent.toFixed(4)}`)}
        {board?.running_cost > 0 && item('进行中（估算）', `约 $${board.running_cost.toFixed(2)}`)}
        {task && item('预算上限', `$${Number(task.totalBudgetUsd || 0).toFixed(2)}`)}
        {item('耗时', fmtDur(board?.elapsed_s))}
      </div>
    </span>
  );
};

const ModelLine = ({ model }) => (
  <p className="mono lr-prov-line"><span className="lr-prov-tag">模型</span>{model}</p>
);

/**
 * CLAUDE（执行者）与监督者两张供应商卡。执行者用 CC Switch 当前全局配置（项目里的会话级供应商已移走），
 * provider 与 AI 面板同一个 getCurrentProvider 口径。
 */
export const ProviderCards = ({ provider: p, task, lr }) => {
  const sup = task?.supervisor;
  const supName = sup?.via === 'cli' ? (p?.name || 'CC Switch 当前配置') : sup?.providerName;
  return (
    <>
      <div className="ai-status-section">
        <h4 className="lr-prov-title">CLAUDE <span className="lr-dim">执行者</span></h4>
        <div className="lr-prov-head">
          <p className={`lr-prov-name ${p?.exists ? 'on' : ''}`}>{p?.name || '读取中…'}</p>
          <span className="lr-prov-tag" title="执行者不读项目里的会话级供应商，用的是 CC Switch 当前全局配置">CC Switch·全局</span>
        </div>
        {p?.isOAuth && p?.oauthEmail && <p className="mono lr-prov-line lr-oauth">{p.oauthEmail}</p>}
        {!p?.isOAuth && p?.url && <p className="mono lr-prov-line">{p.url}</p>}
        <ModelLine model={task?.options?.model || p?.model || '跟随配置'} />
        {lr && task?.state === 'running' && (
          <LongRunRuntimeSwitch lr={lr} taskId={task.id} running
            currentModel={task?.options?.model || ''} currentProviderId={task?.options?.providerId || ''} />
        )}
      </div>
      {sup && (
        <div className="ai-status-section">
          <h4 className="lr-prov-title">监督者</h4>
          {sup.status === 'on' ? (
            <>
              <div className="lr-prov-head">
                <p className="lr-prov-name on">{supName}</p>
                <span className="lr-prov-tag" title={sup.via === 'cli' ? '经 claude CLI 调用，与执行者同一套地址、登录与代理' : '面板上明确选定的供应商，直接调 HTTP，调不通不会换别家'}>
                  {sup.via === 'cli' ? 'claude CLI·同执行者' : 'HTTP·所选供应商'}
                </span>
              </div>
              {sup.via === 'http' && <p className="mono lr-prov-line">{sup.baseUrl}</p>}
              <ModelLine model={sup.model} />
            </>
          ) : <p className="lr-err">{sup.status === 'off' ? '未启用：每次结束都停机等人判断' : `不可用：${sup.error}`}</p>}
        </div>
      )}
    </>
  );
};

/** 上下文水位（同 AI 面板：条 + 右侧「已用 N%」+ 一行说明） */
export const WaterlineSection = ({ board, task }) => {
  const ctx = ctxView(board?.context);
  const floor = task?.thresholds?.handoffFloor;
  return (
    <div className="ai-status-section">
      <h4>上下文水位</h4>
      <div className="lr-wl">
        <div className={`lr-bar ${ctx.hot ? 'hot' : ''}`}><i style={{ width: `${ctx.pct}%` }} /></div>
        <span className={`lr-wl-pct ${ctx.hot ? 'hot' : ''}`}>{board?.context?.limit ? `已用 ${Math.round(ctx.pct)}%` : '—'}</span>
      </div>
      <p className="lr-kv">{ctx.text.replace(/^水位 /, '')}{floor ? ` · 交接线 ${floor.toLocaleString()}` : ''}</p>
    </div>
  );
};

import React, { useState } from 'react';
import { socket } from './socket';
import { parsePanel, keysForOption } from './panelParse';

/** 按键之间留点间隔：连发太快 Ink 可能并成一次处理，光标走不到位 */
const KEY_GAP_MS = 60;

/**
 * 把终端上的选项面板渲染成手机上可点的按钮。
 *
 * 为什么需要：这类面板靠 ↑↓ 移光标、空格勾选、Tab 切分栏，而手机上没有方向键 ——
 * 现有的 1/2/3 按钮只对编号菜单有用，对勾选框完全无效（截图反馈）。
 *
 * 识别不出来时**整块不渲染**，下面的方向键/Tab/Esc 按钮照常可用 ——
 * 解析是加分项，不能成为唯一通路。
 */
export default function PanelPicker({ sessionId, screen }) {
  const [busy, setBusy] = useState(false);
  const panel = parsePanel(screen);
  if (!panel.isPanel) return null;

  /** 依次发出这一项需要的按键；多选要走 ↓ 再空格，所以有间隔 */
  const tap = async (index) => {
    const keys = keysForOption(panel, index);
    if (!keys.length || busy) return;
    setBusy(true);
    for (const k of keys) {
      socket.emit('terminal:input', { sessionId, input: k.input });
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, KEY_GAP_MS));
    }
    setBusy(false);
  };

  const sendRaw = (input) => socket.emit('terminal:input', { sessionId, input });

  return (
    <div className="m-panel">
      <div className="m-panel-head">
        <span className="m-panel-tag">{panel.kind === 'multi' ? '多选面板' : '选项面板'}</span>
        {panel.question && <span className="m-panel-q">{panel.question}</span>}
      </div>

      {panel.options.map((o) => (
        <button
          key={o.index}
          className={`m-panel-opt${o.cursor ? ' cursor' : ''}${o.checked ? ' checked' : ''}`}
          disabled={busy}
          onClick={() => tap(o.index)}
        >
          <span className="m-panel-box">
            {o.hasBox ? (o.checked ? '☑' : '☐') : o.index}
          </span>
          <span className="m-panel-label">
            {o.label}
            {o.detail && <span className="m-panel-detail">{o.detail}</span>}
          </span>
        </button>
      ))}

      {/* 多选要自己按回车提交；分栏面板还要 Tab 切换 —— 这两个必须给，
          否则勾完了没法交（截图那个面板就是这种） */}
      <div className="m-panel-foot">
        {panel.kind === 'multi' && (
          <button className="m-btn primary" disabled={busy} onClick={() => sendRaw('\r')}>提交 ↵</button>
        )}
        {panel.hasTabBar && (
          <button className="m-btn" disabled={busy} onClick={() => sendRaw('\t')}>切换分栏 Tab</button>
        )}
        <button className="m-btn" disabled={busy} onClick={() => sendRaw('\x1b')}>取消 Esc</button>
      </div>
    </div>
  );
}

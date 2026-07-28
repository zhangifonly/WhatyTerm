import React, { useState, useRef, useEffect } from 'react';
import { socket } from './socket';

/**
 * 快捷操作条 + 文本输入框。
 * 输入规则（与桌面版 VoiceInput 两段式一致，Claude Code Ink 框架要求）：
 * - 文本：先发文本，50ms 后再发 '\r'
 * - 单字符（1/2/3）：直接发，不加回车
 * - Esc: '\x1b'，回车: '\r'
 */
export default function QuickActions({ sessionId }) {
  const [text, setText] = useState('');
  const [sentTip, setSentTip] = useState('');
  const inputRef = useRef(null);
  const barRef = useRef(null);

  const tip = (msg) => {
    setSentTip(msg);
    setTimeout(() => setSentTip(''), 1200);
  };

  const sendRaw = (input, label) => {
    socket.emit('terminal:input', { sessionId, input });
    tip(`已发送 ${label}`);
  };

  const sendText = (t, label) => {
    if (!t) return;
    socket.emit('terminal:input', { sessionId, input: t });
    setTimeout(() => {
      socket.emit('terminal:input', { sessionId, input: '\r' });
    }, 50);
    tip(`已发送「${label || t}」`);
  };

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    sendText(t);
    setText('');
    inputRef.current?.blur();  // 收起软键盘
  };

  // iOS 软键盘弹起时把操作条顶到可视区上方（visualViewport 是唯一可靠信号）
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      const el = barRef.current;
      if (!el) return;
      const offset = window.innerHeight - vv.height - vv.offsetTop;
      el.style.transform = offset > 0 ? `translateY(-${offset}px)` : '';
    };
    vv.addEventListener('resize', onResize);
    vv.addEventListener('scroll', onResize);
    return () => {
      vv.removeEventListener('resize', onResize);
      vv.removeEventListener('scroll', onResize);
    };
  }, []);

  return (
    <div className="m-actions" ref={barRef}>
      {sentTip && <div className="m-sent-tip">{sentTip}</div>}
      <div className="m-actions-keys">
        <button className="m-btn primary" onClick={() => sendText('继续')}>继续</button>
        <button className="m-btn" onClick={() => sendRaw('1', '1')}>1</button>
        <button className="m-btn" onClick={() => sendRaw('2', '2')}>2</button>
        <button className="m-btn" onClick={() => sendRaw('3', '3')}>3</button>
        <button className="m-btn" onClick={() => sendRaw('\x1b', 'Esc')}>Esc</button>
        <button className="m-btn" onClick={() => sendRaw('\r', '回车')}>↵</button>
      </div>
      <div className="m-actions-input">
        <input
          ref={inputRef}
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          placeholder="输入指令发给终端…"
          enterKeyHint="send"
        />
        <button className="m-btn primary" onClick={submit} disabled={!text.trim()}>发送</button>
      </div>
    </div>
  );
}

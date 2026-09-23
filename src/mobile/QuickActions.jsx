import React, { useState, useRef, useEffect } from 'react';
import { socket } from './socket';
import { loadHistory, pushHistory, suggest } from './inputHistory';

/**
 * 快捷操作条 + 文本输入框。
 * 输入规则（与桌面版 VoiceInput 两段式一致，Claude Code Ink 框架要求）：
 * - 文本：先发文本，50ms 后再发 '\r'
 * - 单字符（1/2/3）：直接发，不加回车
 * - Esc: '\x1b'，回车: '\r'，Tab: '\t'
 *
 * Tab 是**发真键给终端**（不是本地联想）：补全由 CLI/shell 自己做，结果出现在终端画面上，
 * 与电脑上敲 Tab 行为一致。手机上没有物理 Tab 键，所以必须给个按钮。
 *
 * 输入历史按会话存本机（inputHistory.js）：手机打字费劲而指令高度重复，
 * 点一下候选就能重发。
 */
export default function QuickActions({ sessionId }) {
  const [text, setText] = useState('');
  const [sentTip, setSentTip] = useState('');
  const [history, setHistory] = useState([]);
  const [showHist, setShowHist] = useState(false);
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
    setHistory(pushHistory(sessionId, t));   // 记进历史，下次点一下就能重发
    setText('');
    setShowHist(false);
    inputRef.current?.blur();  // 收起软键盘
  };

  // 切会话时重读历史：历史按会话分开，不能把上一个项目的指令带过来
  useEffect(() => { setHistory(loadHistory(sessionId)); setShowHist(false); }, [sessionId]);

  const candidates = suggest(history, text);

  /** 点候选：填进输入框而**不直接发** —— 手机上误触代价太大，让人确认一眼再按发送 */
  const pick = (t) => {
    setText(t);
    setShowHist(false);
    inputRef.current?.focus();
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
        <button className="m-btn" onClick={() => sendRaw('\t', 'Tab')} title="发 Tab 给终端，由 CLI 自己补全">Tab</button>
        <button className="m-btn" onClick={() => sendRaw('\x1b', 'Esc')}>Esc</button>
        <button className="m-btn" onClick={() => sendRaw('\r', '回车')}>↵</button>
      </div>
      {/* 候选放在输入框**上方**：手机软键盘从下方弹起，放下面会被键盘挡住 */}
      {showHist && candidates.length > 0 && (
        <div className="m-hist">
          {candidates.map((h) => (
            <button key={h} className="m-hist-item" onClick={() => pick(h)} title={h}>{h}</button>
          ))}
        </div>
      )}
      <div className="m-actions-input">
        <input
          ref={inputRef}
          type="text"
          value={text}
          onChange={(e) => { setText(e.target.value); setShowHist(true); }}
          onFocus={() => setShowHist(true)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          placeholder="输入指令发给终端…"
          enterKeyHint="send"
        />
        {history.length > 0 && (
          <button className="m-btn" onClick={() => setShowHist((v) => !v)}
            title="最近发过的指令">↑</button>
        )}
        <button className="m-btn primary" onClick={submit} disabled={!text.trim()}>发送</button>
      </div>
    </div>
  );
}

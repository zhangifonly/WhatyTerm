import React, { useEffect, useState } from 'react';

/**
 * 普通会话换 CLI 接着开发（Claude Code ⇄ Codex）。服务端流程见 server/index.js 的 session:switchCli。
 *   确认 → 交接中（它写交接 → 退出 → 起新 CLI → 发交接摘要）→ 完成 / 失败
 * 交接中可以关掉对话框，服务端照常做完（进度只回给发起方，重新打开看不到进度，但结果会体现在会话上）。
 */
const LABEL = { claude: 'Claude Code', codex: 'Codex' };

const CliSwitchDialog = ({ socket, session, to, onClose }) => {
  const from = session.aiType || 'claude';
  const [state, setState] = useState('confirm');   // confirm | running | done | failed
  const [progress, setProgress] = useState('');
  const [result, setResult] = useState(null);

  useEffect(() => {
    const onProgress = (d) => {
      if (d.sessionId !== session.id) return;
      setProgress(d.seconds ? `${d.text}（${d.seconds} 秒）` : d.text);
    };
    socket.on('session:switchCliProgress', onProgress);
    return () => socket.off('session:switchCliProgress', onProgress);
  }, [socket, session.id]);

  const start = () => {
    setState('running');
    setProgress('准备中…');
    // 交接最长要等 5 分钟写完 + 3 分钟起新 CLI，回调给足时间
    const timer = setTimeout(() => { setResult({ ok: false, error: '超过 10 分钟没有结果，请到终端里看看' }); setState('failed'); }, 10 * 60 * 1000);
    socket.emit('session:switchCli', { sessionId: session.id, to }, (r) => {
      clearTimeout(timer);
      setResult(r);
      setState(r?.ok ? 'done' : 'failed');
    });
  };

  return (
    <div className="modal-overlay" onClick={state === 'running' ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <h2>换成 {LABEL[to]} 接着开发</h2>
        {state === 'confirm' && (
          <>
            <p>会依次做这几件事，期间这个会话的自动操作暂停：</p>
            <ol style={{ paddingLeft: 20, lineHeight: 1.7 }}>
              <li>等 {LABEL[from]} 闲下来，请它{from === 'claude' ? '把进度写进记忆，并' : ''}写一份交接摘要（进度、决定、失败过的方案、下一步）</li>
              <li>写完后退出 {LABEL[from]}；没写完就不退出，上下文不会丢</li>
              <li>在同一个终端里启动 {LABEL[to]}（新对话），把交接摘要作为第一句发给它</li>
            </ol>
            <p className="lr-dim">项目规则两边都读得到：{to === 'codex' ? 'Codex 没有 AGENTS.md 时会读 CLAUDE.md' : 'Claude 会同时读 CLAUDE.md 与 AGENTS.md'}。
              若 {LABEL[to]} 第一次在这个目录运行，会问是否信任目录，需要你到终端里选。</p>
          </>
        )}
        {state === 'running' && <p>{progress}</p>}
        {state === 'done' && <p>已换成 {LABEL[to]}，交接摘要已发给它。{result?.receiptFile ? `摘要另存在 ${result.receiptFile}` : ''}</p>}
        {state === 'failed' && (
          <>
            <p className="lr-err">{result?.error || '没有成功'}</p>
            {result?.receipt && <pre className="lr-pre" style={{ maxHeight: 220, overflow: 'auto' }}>{result.receipt}</pre>}
          </>
        )}
        <div className="modal-actions">
          {state === 'confirm' && <button className="btn btn-secondary" onClick={onClose}>取消</button>}
          {state === 'confirm' && <button className="btn btn-primary" onClick={start}>开始交接</button>}
          {state === 'running' && <button className="btn btn-secondary" onClick={onClose}>在后台继续</button>}
          {(state === 'done' || state === 'failed') && <button className="btn btn-primary" onClick={onClose}>关闭</button>}
        </div>
      </div>
    </div>
  );
};

export default CliSwitchDialog;

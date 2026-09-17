import React, { useState, useEffect, useCallback } from 'react';

/** 过程明细类条目（比时间线多一个 meta：系统记录与图片输入） */
const TRACE = new Set(['thinking', 'tool', 'toolout', 'meta']);
const fmtSize = (n) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
/** ISO 时间 → 本地时间（原版直接截字符串，显示的是 UTC —— 这里修正） */
const localTime = (iso, withDate) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return withDate ? d.toLocaleString('zh-CN', { hour12: false }) : d.toLocaleTimeString('zh-CN', { hour12: false });
};

/**
 * 「对话记录」：执行者会话的原始记录（原版 transcript.py）。看对话层 —— 每一次思考、工具入参、工具返回；
 * 时间线看的是编排器层。`claude -p` 跑出来的会话不进 history 索引，`claude -c/-r` 找不到，只能在这里翻。
 * 目录缺省为沙箱根：会话按 cwd 存，执行者的 cwd 就是沙箱。
 */
const LongRunTranscript = ({ call, defaultDir }) => {
  const [dir, setDir] = useState(defaultDir || '');
  const [list, setList] = useState(null);
  const [stat, setStat] = useState('');
  const [error, setError] = useState('');
  const [current, setCurrent] = useState(null);      // {file, data, loading, error}
  const [showTrace, setShowTrace] = useState(true);
  const [fold, setFold] = useState(true);

  const load = useCallback(async (d) => {
    setError(''); setList(null); setCurrent(null); setStat('读取中…');
    const r = await call('longrun:transcript:sessions', { dir: d });
    if (r.error) { setError(r.error); setStat(''); return; }
    setList(r.sessions || []);
    setStat(`${(r.sessions || []).length} 个会话 · 目录 ${r.project_dir}`);
  }, [call]);

  useEffect(() => { setDir(defaultDir || ''); if (defaultDir) load(defaultDir); }, [defaultDir, load]);

  const openSession = async (s) => {
    setCurrent({ file: s.file, loading: true });
    const r = await call('longrun:transcript:session', { file: s.file });
    setCurrent(r.error ? { file: s.file, error: r.error } : { file: s.file, data: r });
  };

  const entries = (current?.data?.entries || []).filter((e) => showTrace || !TRACE.has(e.role));
  const sum = current?.data?.summary;

  return (
    <div className="lr-tr">
      <div className="lr-tl-bar">
        <input className="lr-input" value={dir} onChange={(e) => setDir(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && load(dir)} placeholder="工作目录（会话按 cwd 存，子目录里跑的不算）" />
        <button className="btn btn-secondary btn-small" onClick={() => load(dir)}>列出会话</button>
        <label><input type="checkbox" checked={showTrace} onChange={(e) => setShowTrace(e.target.checked)} /> 思考与工具</label>
        <label><input type="checkbox" checked={fold} onChange={(e) => setFold(e.target.checked)} /> 折叠长内容</label>
        <span className="lr-dim">{stat}</span>
      </div>
      <div className="lr-tr-body">
        <div className="lr-tr-side">
          {error && <div className="lr-err">{error}</div>}
          {list && !list.length && <span className="lr-dim">这个目录下没有会话记录。</span>}
          {(list || []).map((s) => (
            <div key={s.file} className={`lr-tr-card ${current?.file === s.file ? 'on' : ''}`} onClick={() => openSession(s)}>
              <div className="lr-dim">{localTime(s.started, true)} <span className={`lr-tag ${s.entrypoint === 'sdk-cli' ? 'sdk' : ''}`}>{s.entrypoint || '?'}</span> {fmtSize(s.size)}</div>
              <div className="lr-tr-title">{s.title || '(无标题)'}</div>
              <div className="lr-dim">对话 {s.users}/{s.assistants} · 工具 {s.tools} · {s.id.slice(0, 8)}</div>
            </div>
          ))}
        </div>
        <div className="lr-tr-pane">
          {!current && <span className="lr-dim">左边选一个会话查看详细记录。</span>}
          {current?.loading && <span className="lr-dim">解析中…（大文件要几秒）</span>}
          {current?.error && <div className="lr-err">{current.error}</div>}
          {sum && (
            <div className="lr-tr-head">
              会话 <b>{sum.id}</b> · {sum.entrypoint} · {localTime(sum.started, true)} → {localTime(sum.ended, true)} · {fmtSize(sum.size)} · {sum.lines} 行
              · 水位峰值 {Number(sum.peak_tokens).toLocaleString()} tok · 输出合计 {Number(sum.out_tokens).toLocaleString()} tok · 显示 {entries.length}/{current.data.entries.length} 条
              <div className="lr-dim">cwd {sum.cwd}</div>
              {sum.entrypoint === 'sdk-cli' && (
                <div className="lr-warn">⚠ 这是 claude -p 跑出来的会话，<b>claude -c / -r 找不到它</b>（SDK 不写 history 索引）。要接续用 <code>claude --resume {sum.id}</code>。
                  另外：被编排器结束的发次，末尾几条可能没来得及落盘，这里的水位峰值会略低于编排器记录的值。别接续编排器正在用的会话，会抢同一份历史。</div>
              )}
            </div>
          )}
          {entries.map((e) => {
            const folded = fold && TRACE.has(e.role) && e.head;   // 没有摘要的不折叠：折起来等于藏起来
            const label = <span className="lr-dim">{localTime(e.at)} <b>{e.label}</b></span>;
            return (
              <div key={e.id} className={`lr-tr-entry r-${e.role}${e.is_error ? ' err' : ''}`}>
                {folded ? (
                  <details><summary>{label} <span className="sum">{e.head}</span></summary><pre>{e.body}</pre></details>
                ) : (<>{label}<pre>{e.body}</pre></>)}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default LongRunTranscript;

import React, { useState, useEffect } from 'react';
import { PAUSE_TEMPLATE } from './longrunBoard.js';

/**
 * 人工干预卡。按钮写的就是原版的文件约定（inject.txt / inject!.txt / pause），终端投件与这里投件走同一条路。
 *
 * 四个动作的后果必须说清，它们看起来像，其实完全不同：
 *   投件   —— 下一个工具间隙把这句话发给执行者（勾"立即"则马上打断），续同一会话，不问监督者
 *   暂停   —— 当前这发**照常跑完**才停在派发口（可能要很久）；继续后发的是「继续完成项目」
 *   停下   —— 立即打断 + 挂暂停闸。仍不是终止，点继续会接着干
 *   终止   —— 结束执行者进程，本轮收工并打快照；沙箱与记忆保留，可以续跑
 */
const LongRunIntervene = ({ lr, task }) => {
  const [text, setText] = useState('');
  const [immediate, setImmediate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => { setText(''); setMsg(''); setImmediate(false); }, [task.id]);

  const run = async (event, payload, okText) => {
    setBusy(true); setMsg('');
    const r = await lr.call(event, { taskId: task.id, ...payload });
    setBusy(false);
    setMsg(r.ok ? (r.note || okText) : `失败：${r.error}`);
    return r;
  };

  const inject = async () => {
    const r = await run('longrun:inject', { text, immediate }, immediate ? '已投件：立即打断当前这发' : '已投件：下一个工具间隙生效');
    if (r.ok) setText('');
  };
  const togglePause = () => run('longrun:pause', { on: !task.pauseArmed },
    task.pauseArmed ? '已删除暂停闸：执行者会接着干' : '已挂暂停闸：当前这发跑完后停在派发口');
  const stop = () => {
    if (!window.confirm('停下 = 立即打断当前这发 + 挂上暂停闸。\n\n这不是终止：之后点「继续」执行者会接着干。\n确定要停下吗？')) return;
    run('longrun:stop', {}, '已打断并暂停');
  };
  const terminate = () => {
    if (!window.confirm('终止 = 结束执行者进程，本轮以「人工终止」收工并打快照。\n\n'
      + '这一发正在做的事会中断；沙箱与记忆都保留，之后可以续跑。\n确定要终止吗？')) return;
    run('longrun:terminate', {}, '已终止');
  };

  return (
    <div className="ai-status-section lr-intervene">
      <h4>人工干预</h4>
      {task.halted && <div className="lr-note wait">⏸ 已停在派发口，不烧钱。点「继续」接着干（暂停不是终止）。</div>}
      {task.pauseArmed && !task.halted && (
        <div className="lr-note wait">⏳ 暂停闸已挂：当前这发会照常跑完才停，可能要很久。要马上停用「停下」。</div>
      )}
      <textarea className="lr-textarea" value={text} onChange={(e) => setText(e.target.value)}
        placeholder="中途改方向：写一句话，原样发给执行者。例：数据改存 SQLite，别用 JSON 文件" />
      <div className="lr-row">
        <label title="不等工具间隙，马上打断。它在死循环里反复跑同一个命令时用">
          <input type="checkbox" checked={immediate} onChange={(e) => setImmediate(e.target.checked)} /> 立即打断
        </label>
        <button className="lr-link" onClick={() => setText(PAUSE_TEMPLATE)} title="暂停不是终止：打断语写成'停下别干了'会被执行者当结论写进记忆">
          填入安全措辞
        </button>
        <button className="btn btn-primary btn-small" disabled={busy || !text.trim()} onClick={inject}>投件</button>
      </div>
      <div className="lr-row lr-actions">
        <button className="btn btn-secondary btn-small" disabled={busy} onClick={togglePause}>{task.pauseArmed ? '▶ 继续' : '⏸ 暂停'}</button>
        <button className="btn btn-secondary btn-small" disabled={busy} onClick={stop}>■ 停下</button>
        <button className="btn btn-small lr-danger" disabled={busy} onClick={terminate}>✖ 终止</button>
      </div>
      {msg && <div className="lr-dim">{msg}</div>}
      <div className="lr-dim lr-small" title={`${task.injectPath}\n${task.injectNowPath}\n${task.pausePath}`}>
        终端里同样可用：往沙箱 <code>.run/inject.txt</code> 写一句话即投件（<code>inject!.txt</code> 或以 !! 开头为立即打断），
        建空文件 <code>.run/pause</code> 即暂停。想立刻停：先打断再建 pause，顺序反了当前这发会跑完。
      </div>
    </div>
  );
};

export default LongRunIntervene;

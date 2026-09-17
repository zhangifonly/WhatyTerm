import React, { useState, useEffect, useRef } from 'react';
import LongRunIntervene from './LongRunIntervene.jsx';
import { isSubmitKey, STOP_LABEL } from './longrunBoard.js';

/**
 * 主区底部输入区 —— 人要输入的一切都在这里，位置与 Claude Code 的输入框相同，使用习惯一致：
 *   等你回答 —— 提问卡贴在输入框上方，Enter 回答并续跑；留空停机必须点按钮（误按 Enter 不能把任务停掉）
 *   运行中   —— 投件 / 暂停 / 停下 / 终止
 *   已结束   —— 输入框位置换成「转为终端 / 续跑长程」
 */
const LongRunComposer = ({ lr, onResume, onHandover }) => {
  const { board, meta, view } = lr;
  const task = meta.task;
  const live = view?.kind === 'task' && task?.state === 'running';
  const awaiting = live && task.awaitingHuman;
  const nh = board?.need_human;
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const input = useRef(null);
  useEffect(() => { setAnswer(''); setMsg(''); }, [task?.id]);
  // 刚进入等人状态时把光标放进回答框：人被提醒声叫回来，直接打字就行
  useEffect(() => { if (awaiting) input.current?.focus(); }, [awaiting]);

  if (!board || view?.kind === 'pending') return null;

  const sendAnswer = async () => {
    setBusy(true);
    const r = await lr.call('longrun:answer', { taskId: task.id, text: answer });
    setBusy(false);
    setMsg(r.ok ? '' : `失败：${r.error}`);
    if (r.ok) setAnswer('');
  };

  if (awaiting) {
    return (
      <div className="lr-composer need">
        <div className="lr-bell-title">
          <span className="lr-bell-dot" />执行者需要你拍板
          <button className="lr-mute" onClick={() => lr.setMuted(!lr.muted)}>{lr.muted ? '取消静音' : '静音'}</button>
        </div>
        {nh && (
          <div className="lr-composer-question">
            <div>需要你提供：<b>{nh.needs || ''}</b></div>
            {nh.reason && <div className="lr-dim">依据：{nh.reason}</div>}
            <pre>{nh.question || ''}</pre>
          </div>
        )}
        <textarea ref={input} className="lr-composer-input" rows={2} value={answer} onChange={(e) => setAnswer(e.target.value)}
          onKeyDown={(e) => { if (isSubmitKey(e) && answer.trim() && !busy) { e.preventDefault(); sendAnswer(); } }}
          placeholder="你的回答原样发给执行者（不加包装），续同一会话。Enter 发送，Shift+Enter 换行" />
        <div className="lr-composer-bar">
          <span className="lr-err lr-grow">{msg}</span>
          <button className="btn btn-secondary btn-small" disabled={busy || !!answer.trim()} onClick={sendAnswer}
            title="与原版终端里直接回车一致：不回答就停机">不回答，停机</button>
          <button className="btn btn-primary btn-small" disabled={busy || !answer.trim()} onClick={sendAnswer}>回答并续跑</button>
        </div>
      </div>
    );
  }

  if (live) return <div className="lr-composer"><LongRunIntervene lr={lr} task={task} /></div>;

  const f = board.finished;
  return (
    <div className="lr-composer ended">
      <div className="lr-composer-bar">
        <span className="lr-dim lr-grow">
          {board.replay ? '上一轮的记录' : '本轮已结束'}{f ? `（${STOP_LABEL[f.stop] || f.stop}）` : ''}。项目与记忆（.memory）都在：
          转为终端 = 同一条目用交互式 claude 接着开发；续跑长程 = 追加需求，执行者从记忆接上
        </span>
        <button className="btn btn-secondary btn-small" onClick={onResume}>续跑长程…</button>
        <button className="btn btn-primary btn-small" onClick={onHandover}>转为终端…</button>
      </div>
    </div>
  );
};

export default LongRunComposer;

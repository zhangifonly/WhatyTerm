import { useState, useEffect, useRef } from 'react';
import { socket } from './socket';

/** 两次拉取的最小间隔。长程跑起来一分钟能推几十次摘要，每次都拉会白耗手机流量 */
const THROTTLE_MS = 1500;

/**
 * 长程精简快照 hook（手机用）。
 *
 * 不订阅看板房间：看板动辄几百 KB（ERP 那轮 435 KB）。改为靠全局广播的任务摘要得知
 * "有变化"，节流后拉一份几 KB 的 longrun:brief。
 *
 * ⚠ 在等你的那一刻不能被节流吞掉：等人是最要紧的变化，awaitingHuman 翻转时立即拉。
 *
 * @param {object|null} task  该条目最新的长程任务摘要（来自 useSessions 的 longRunTasks）
 * @returns {{brief:object|null, error:string, refresh:Function}}
 */
export function useLongRunBrief(task) {
  const [brief, setBrief] = useState(null);
  const [error, setError] = useState('');
  const lastAt = useRef(0);
  const timer = useRef(null);
  const lastAwaiting = useRef(null);

  const fetchNow = () => {
    if (!task?.id) return;
    lastAt.current = Date.now();
    socket.emit('longrun:brief', { taskId: task.id }, (r) => {
      if (r?.ok) { setBrief(r.brief); setError(''); } else setError(r?.error || '取不到长程状态');
    });
  };

  useEffect(() => {
    if (!task?.id) { setBrief(null); return undefined; }
    const flipped = lastAwaiting.current !== null && lastAwaiting.current !== !!task.awaitingHuman;
    lastAwaiting.current = !!task.awaitingHuman;
    const wait = THROTTLE_MS - (Date.now() - lastAt.current);
    clearTimeout(timer.current);
    if (flipped || wait <= 0) fetchNow();              // 等人状态变了，或已过节流窗口：立即拉
    else timer.current = setTimeout(fetchNow, wait);   // 否则窗口结束时补拉一次，不丢最后的变化
    return () => clearTimeout(timer.current);
    // task 对象每次广播都是新的；按会影响快照的字段决定要不要重拉
  }, [task?.id, task?.legs, task?.state, task?.awaitingHuman, task?.pauseArmed, task?.halted, task?.costUsd]);   // eslint-disable-line react-hooks/exhaustive-deps

  return { brief, error, refresh: fetchNow };
}

export default useLongRunBrief;

import { useEffect, useRef } from 'react';

/** 周期性提醒间隔：够长不烦人 */
export const BELL_INTERVAL_MS = 12000;
const WAITING_TITLE = '● 等待你回复 — 长程任务';
const DONE_TITLE = '✅ 已完成 — 长程任务';
const STOPPED_TITLE = '■ 已停机 — 长程任务';

/**
 * 三个音一组的小琶音（A5–C#6–E6），Web Audio 生成，不依赖音频文件。比单音蜂鸣悦耳，也不容易听腻。
 * 自动播放被拦或不支持时静默降级。
 */
/** 收工提示音：下行三音（E6–C#6–A5），与"等你回答"的上行琶音听感相反，一响就知道是收工而不是在催你 */
function chimeDone(ctxRef) { chime(ctxRef, [1318.5, 1108.7, 880], 0.13); }

function chime(ctxRef, freqs = [880, 1108.7, 1318.5], gap = 0.16) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    ctxRef.current = ctxRef.current || new Ctx();
    const ctx = ctxRef.current;
    freqs.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t0 = ctx.currentTime + i * gap;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(0.16, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.55);
    });
  } catch { /* 静默降级 */ }
}

/**
 * 有运行中的任务在等人回答时响铃并改标题，直到没有人在等。
 * 只看运行中的任务（awaitingHuman 由服务端给出）—— 回放里那个"等待你回复"是历史现场，响铃是纯粹的噪音。
 * 静音不清定时器，只让响铃直接返回（与原版一致），取消静音后下一个周期照常响。
 */
export function useLongRunBell(tasks, muted, onFinish = null) {
  const ctxRef = useRef(null);
  const timerRef = useRef(null);
  const titleRef = useRef(null);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const waiting = tasks.some((t) => t.state === 'running' && t.awaitingHuman);
  /** 已经提醒过收工的任务 id。null = 页面刚打开，先把历史任务登记下来，不为它们响铃 */
  const seenRef = useRef(null);
  const finishRef = useRef(onFinish);
  finishRef.current = onFinish;

  // 收工提醒：一次性。跑完那一刻响一声 + 改标题，刷新页面、切视图、看回放都不再响
  useEffect(() => {
    const done = tasks.filter((t) => t.state && t.state !== 'running');
    if (!seenRef.current) { seenRef.current = new Set(done.map((t) => t.id)); return; }
    for (const t of done) {
      if (seenRef.current.has(t.id)) continue;
      seenRef.current.add(t.id);
      if (!mutedRef.current) chimeDone(ctxRef);
      if (titleRef.current == null) titleRef.current = document.title;
      document.title = t.report?.stop === 'project_done' ? DONE_TITLE : STOPPED_TITLE;
      finishRef.current?.(t);
    }
  }, [tasks]);

  // 人回到页面就把标题收回来（收工标题是提醒，不是常驻状态）
  useEffect(() => {
    const restore = () => {
      if (titleRef.current == null) return;
      if (document.title === DONE_TITLE || document.title === STOPPED_TITLE) {
        document.title = titleRef.current; titleRef.current = null;
      }
    };
    window.addEventListener('focus', restore);
    document.addEventListener('visibilitychange', restore);
    return () => { window.removeEventListener('focus', restore); document.removeEventListener('visibilitychange', restore); };
  }, []);

  useEffect(() => {
    const ring = () => { if (!mutedRef.current) chime(ctxRef); };
    if (waiting && !timerRef.current) {
      ring();
      timerRef.current = setInterval(ring, BELL_INTERVAL_MS);
      titleRef.current = document.title;
      document.title = WAITING_TITLE;
    } else if (!waiting && timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
      if (document.title === WAITING_TITLE && titleRef.current != null) document.title = titleRef.current;
    }
  }, [waiting]);

  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (document.title === WAITING_TITLE && titleRef.current != null) document.title = titleRef.current;
  }, []);

  return waiting;
}

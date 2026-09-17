import { useEffect, useRef } from 'react';

/** 周期性提醒间隔：够长不烦人 */
export const BELL_INTERVAL_MS = 12000;
const WAITING_TITLE = '● 等待你回复 — 长程任务';

/**
 * 三个音一组的小琶音（A5–C#6–E6），Web Audio 生成，不依赖音频文件。比单音蜂鸣悦耳，也不容易听腻。
 * 自动播放被拦或不支持时静默降级。
 */
function chime(ctxRef) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    ctxRef.current = ctxRef.current || new Ctx();
    const ctx = ctxRef.current;
    [880, 1108.7, 1318.5].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t0 = ctx.currentTime + i * 0.16;
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
export function useLongRunBell(tasks, muted) {
  const ctxRef = useRef(null);
  const timerRef = useRef(null);
  const titleRef = useRef(null);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const waiting = tasks.some((t) => t.state === 'running' && t.awaitingHuman);

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

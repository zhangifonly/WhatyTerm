/**
 * 鼠标上报模式切换去抖：不让 xterm.js 在「先全关、再打开」的瞬间把正在进行的拖动弄丢（v1.4.88）。
 *
 * 现象：在 Claude Code 全屏模式（开了 1003「任意移动都上报」）的会话里拖选，tmux 刚进选择模式就再也收不到
 * 鼠标事件——松手不复制，只能按住 Option 走 xterm 自带选择，而那个选区一碰到 CLI 重绘就没了。
 *
 * 根因（实测 tmux 3.6）：应用开着 1003 时，tmux 进入选择模式要把外层终端从 1003 降到 1002，发的是
 *   ?1006l ?1000l ?1002l ?1003l ?1006h ?1000h ?1002h
 * 最终状态没问题，但 xterm.js 关掉 1000/1002/1003 中任何一个都把鼠标协议置为 NONE，
 * 置 NONE 时连同「这次拖动」挂在 document 上的 mousemove / mouseup 监听一起拆掉；随后再打开协议
 * 只会重新挂 mousedown，这次拖动的后续移动和松手再也发不出去。
 *
 * 「开」也一样要合并：上面那串里 ?1000h 先把协议切到 VT200（只报按下/松开），xterm 随即拆掉拖动监听；
 * 紧接着的 ?1002h 虽然把协议升回 DRAG，拖动监听却要等下一次按下才重新挂上——实测松手能发出去，中间的移动全丢，
 * 拖了一整行只复制到两个字。
 *
 * 做法：鼠标协议类（1000/1002/1003）的开和关一律先不交给 xterm，只记账；这一批输出解析完（微任务）
 * 按最终想要的模式只应用一次：全关了就关，否则直接切到剩下最高的那一档——从 ANY 到 DRAG 一步到位，
 * 拖动监听不会被拆。编码类（1006 等）不碰，它不拆监听。
 */

const PROTOCOL = [1000, 1002, 1003];   // 从低到高：按下松开 / 拖动 / 任意移动
const isProtocol = (n) => PROTOCOL.includes(n);

/**
 * 纯状态机（便于测试）：喂入 DECSET/DECRST 的参数，告诉调用方要不要拦下、批次结束时要补写什么。
 */
export function createMouseModeState() {
  const want = new Set();     // 应用（经 tmux）此刻想要的协议模式
  let applied = 0;            // xterm 实际在用的协议模式（0 = NONE）
  const apply = (params, on) => {
    const proto = params.filter(isProtocol);
    for (const n of proto) { if (on) want.add(n); else want.delete(n); }
    // 混着别的模式的整条交给 xterm（xterm 会按它自己的规则改协议，照实记下）
    if (proto.length && proto.length !== params.length) { applied = on ? proto[proto.length - 1] : 0; return false; }
    return proto.length > 0;  // 全是协议参数：拦下，等批次结束统一应用
  };
  return {
    /** DECSET（h）。返回 true = 拦下 */
    set: (params) => apply(params, true),
    /** DECRST（l）。返回 true = 拦下 */
    reset: (params) => apply(params, false),
    /** 批次结束：返回要交给 xterm 的那一条（'' 表示不用动） */
    settle() {
      const top = Math.max(0, ...want);
      if (top === applied) return '';
      applied = top;
      return top ? `\x1b[?${top}h` : '\x1b[?1000l';   // 关任何一个都是 NONE，用 1000 即可
    },
    snapshot: () => ({ want: [...want].sort(), applied }),
  };
}

/** 装到 xterm 上，返回 dispose */
export function attachMouseModeGuard(term) {
  const st = createMouseModeState();
  let passThrough = 0;     // 自己补写的那一条要真交给 xterm（计数：写出去几条，就放行几条）
  let scheduled = false;
  const nums = (params) => {
    const out = [];
    for (let i = 0; i < params.length; i++) out.push(Array.isArray(params[i]) ? params[i][0] : params[i]);
    return out;
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      const fix = st.settle();
      if (fix) { passThrough++; term.write(fix); }
    });
  };
  const handle = (on) => (params) => {
    const ps = nums(params);
    if (!ps.some(isProtocol)) return false;
    if (passThrough > 0 && ps.length === 1) { passThrough--; return false; }   // 自己补写的
    const swallow = on ? st.set(ps) : st.reset(ps);
    schedule();
    return swallow;
  };
  const h = term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, handle(true));
  const l = term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, handle(false));
  return () => { h.dispose(); l.dispose(); };
}

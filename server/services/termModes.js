/**
 * 终端模式跟踪：记住 tmux 客户端当前开着哪些 DEC 私有模式，供新页面接入时补发。
 *
 * 背景（v1.4.76）：服务端每个会话只有**一条**长驻 `tmux attach`（node-pty），tmux 只在这条
 * 客户端刚连上时发一次 `ESC[?1002h ESC[?1006h`（开鼠标上报）等模式切换。之后的页面刷新、
 * 切会话，前端拿到的只是 capture-pane 回放的屏幕文字——模式切换一条都没有。
 * 于是浏览器里的 xterm 以为没开鼠标上报：拖动变成 xterm 自带的选择（看得见高亮），
 * 不经过 tmux copy-mode，松手也不会发 OSC 52 —— 「松开即复制」是假的。实测新开页面、
 * 切会话、刷新四种情况全是关的。
 *
 * 做法：从 pty 输出流里解析模式切换（就是 tmux 真实发给客户端的那些），按模式号记最新状态；
 * 新页面接入时把当前状态拼成一串前导序列发过去。
 */

// 只跟踪影响交互的模式：鼠标上报各编码、焦点事件、括号粘贴、应用光标键
export const TRACKED_MODES = [1, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 2004];
const TRACKED = new Set(TRACKED_MODES);
// CSI ? Pm h / l，参数可以是分号分隔的多个模式
const DECSET_RE = /\x1b\[\?([0-9;]+)([hl])/g;
// 序列可能被 pty 分块切开：保留上一块尾部一段，拼到下一块前面再解析
const CARRY = 24;

export function createModeTracker() {
  const state = new Map();     // mode -> true(h)/false(l)
  let carry = '';

  function apply(text) {
    DECSET_RE.lastIndex = 0;
    let m;
    while ((m = DECSET_RE.exec(text))) {
      const on = m[2] === 'h';
      for (const p of m[1].split(';')) {
        const n = Number(p);
        if (TRACKED.has(n)) state.set(n, on);
      }
    }
  }

  return {
    feed(data) {
      const text = carry + String(data || '');
      // 末尾若是一个没收完的 CSI（ESC、ESC[、ESC[?100 这类），留给下一块拼完整再解析
      const lastEsc = text.lastIndexOf('\x1b');
      const rest = lastEsc >= 0 ? text.slice(lastEsc) : '';
      const incomplete = lastEsc >= 0 && rest.length < CARRY && /^\x1b(\[[0-9;?]*)?$/.test(rest);
      const cut = incomplete ? lastEsc : text.length;
      apply(text.slice(0, cut));
      carry = text.slice(cut);
    },
    /** 当前状态拼成的前导序列：开着的发 h，明确关掉的发 l（让复用的 xterm 实例清掉上一个会话留下的模式） */
    prelude() {
      // ⚠ 先全部「关」再全部「开」：xterm.js 把 1000/1002/1003 合成一个「鼠标协议」状态，
      //   关掉其中任何一个都会把整个协议置为 NONE。tmux 会发 ?1003l（不要任意移动上报），
      //   按模式号顺序拼成 `?1002h ?1003l` 就等于刚开就关——实测补发后鼠标上报仍是关的
      const offs = TRACKED_MODES.filter((n) => state.get(n) === false).map((n) => `\x1b[?${n}l`);
      const ons = TRACKED_MODES.filter((n) => state.get(n) === true).map((n) => `\x1b[?${n}h`);
      return offs.join('') + ons.join('');
    },
    snapshot() { return Object.fromEntries(state); }
  };
}

/**
 * 前端那个 xterm 实例是所有会话复用的：切到新会话前先把鼠标/粘贴类模式全关掉，再按新会话的状态打开，
 * 否则上一个会话开着的鼠标上报会「漏」到一个本来没开的会话里。
 */
export const RESET_PRELUDE = TRACKED_MODES.filter((n) => n !== 1).map((n) => `\x1b[?${n}l`).join('');

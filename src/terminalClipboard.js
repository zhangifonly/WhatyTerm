/**
 * 终端剪贴板：把 tmux / xterm 里选中的文字送进系统剪贴板。
 *
 * 为什么需要这一层：
 * 会话开着 tmux `mouse on`，滚轮和拖拽都被 tmux 接管，xterm 自己的 scrollback 是空的，
 * 只持有当前可见屏。所以「按住 Option 往上滚着选」在浏览器侧根本选不到滚走的内容——
 * 那些内容在 tmux 的历史缓冲里。正确做法是让 tmux 自己做跨屏选择（拖到边缘自动滚动），
 * 复制时它通过 OSC 52 把结果发出来，由这里写进系统剪贴板。
 *
 * 三条写入通道，按可靠性排序：
 *   1. Electron IPC —— 主进程 clipboard.writeText，不需要用户手势，最稳
 *   2. navigator.clipboard —— 浏览器标准 API，非用户手势时可能被拒
 *   3. execCommand('copy') —— 老浏览器兜底
 */

// OSC 52 的载荷可能很大（复制整屏历史），超过这个长度直接丢弃，避免卡住渲染
const MAX_CLIPBOARD_BYTES = 2 * 1024 * 1024;

/** base64 → UTF-8 字符串（atob 只处理 latin1，中文必须再解一次） */
export function decodeBase64Utf8(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

/** 写系统剪贴板。返回 Promise<boolean>，失败不抛异常（复制失败不该打断终端） */
export async function writeClipboard(text) {
  if (!text) return false;

  if (window.electronAPI?.writeClipboard) {
    try {
      await window.electronAPI.writeClipboard(text);
      return true;
    } catch (err) {
      console.warn('[剪贴板] Electron 写入失败，回退浏览器 API:', err?.message);
    }
  }

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    // 非用户手势场景下浏览器会拒绝，落到 execCommand
    console.warn('[剪贴板] Clipboard API 被拒，回退 execCommand:', err?.message);
  }

  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (err) {
    console.error('[剪贴板] 全部通道失败:', err?.message);
    return false;
  }
}

/**
 * 「松手即复制」在 Safari / Firefox 上的关键：剪贴板写入必须发生在用户手势里。
 *
 * tmux 的 OSC 52 在鼠标松开后**异步**到达（几十毫秒后），那时已不算用户手势：
 * Chrome 放行，Safari / Firefox 静默拒绝（execCommand 兜底同样要手势）——表现就是
 * 「提示说松开即复制，实际什么都没复制」。
 * 解法（Safari 官方推荐的写法）：在 mouseup 手势里**当场**调 clipboard.write，
 * 内容给一个 Promise，等 OSC 52 到了再兑现。没等到（只是单击、没选中）就作废，剪贴板不动。
 */
const GESTURE_WAIT_MS = 1500;   // 双击选词 tmux 自己会等 0.3 秒再复制，留足余量
let pendingGesture = null;      // { resolve, reject, timer, done: Promise<boolean> }

function armGestureCopy() {
  if (window.electronAPI?.writeClipboard) return;               // 走主进程，不需要手势
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return;
  cancelGesture();
  let resolve, reject;
  const text = new Promise((res, rej) => { resolve = res; reject = rej; });
  let item;
  try {
    item = new ClipboardItem({ 'text/plain': text.then((t) => new Blob([t], { type: 'text/plain' })) });
  } catch {
    return;                                                     // 不支持 Promise 形式的 ClipboardItem
  }
  const done = navigator.clipboard.write([item]).then(() => true, () => false);
  const timer = setTimeout(() => cancelGesture(), GESTURE_WAIT_MS);
  pendingGesture = { resolve, reject, timer, done };
}

function cancelGesture() {
  if (!pendingGesture) return;
  clearTimeout(pendingGesture.timer);
  pendingGesture.reject(new Error('没有等到复制内容'));
  pendingGesture = null;
}

/**
 * 在终端容器上监听「拖动后松手 / 双击 / 三击」，在手势里预约一次剪贴板写入。
 * 只有真拖动过（移动超过 3px）才预约，普通单击不碰剪贴板。返回解绑函数。
 */
export function attachGestureCopy(el) {
  if (!el) return () => {};
  let down = null;
  let dragged = false;
  const onDown = (e) => { if (e.button === 0) { down = { x: e.clientX, y: e.clientY }; dragged = false; } };
  const onMove = (e) => {
    if (down && (e.buttons & 1) && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 3) dragged = true;
  };
  const onUp = (e) => {
    if (e.button === 0 && down && dragged) armGestureCopy();
    down = null;
  };
  const onClicks = (e) => { if (e.detail >= 2) armGestureCopy(); };   // 双击选词、三击选行
  el.addEventListener('mousedown', onDown, true);
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('mouseup', onUp, true);
  el.addEventListener('click', onClicks, true);
  return () => {
    el.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseup', onUp, true);
    el.removeEventListener('click', onClicks, true);
    cancelGesture();
  };
}

/** OSC 52 到达：有预约就兑现预约（手势内的写入），否则走普通写入。返回是否成功 */
async function deliver(text) {
  if (pendingGesture) {
    const g = pendingGesture;
    pendingGesture = null;
    clearTimeout(g.timer);
    g.resolve(text);
    if (await g.done) return true;
    // 浏览器不认 Promise 形式的写入：退回普通通道（Chrome 在非手势下也放行）
  }
  return writeClipboard(text);
}

/**
 * 给 xterm 装上 OSC 52 处理：tmux 复制完会发 `ESC ] 52 ; c ; <base64> BEL`。
 *
 * ⚠️ 只实现「写」不实现「读」。OSC 52 的查询形式（载荷为 `?`）会让终端把当前
 *    剪贴板内容回传给程序——那等于任何在终端里跑的东西都能读走用户剪贴板，
 *    这里直接吞掉不响应。
 *
 * @param {import('@xterm/xterm').Terminal} term
 * @param {(text: string) => void} [onCopied] 复制成功后的回调（用于提示）
 */
export function registerOsc52(term, onCopied) {
  return term.parser.registerOscHandler(52, (payload) => {
    try {
      const sep = payload.indexOf(';');
      const b64 = sep >= 0 ? payload.slice(sep + 1) : payload;
      if (!b64 || b64 === '?') return true;              // 查询剪贴板：不响应
      if (b64.length > MAX_CLIPBOARD_BYTES) {
        console.warn('[剪贴板] OSC 52 载荷过大，已忽略');
        return true;
      }
      const text = decodeBase64Utf8(b64);
      deliver(text).then(ok => { if (ok) onCopied?.(text); });
    } catch (err) {
      console.error('[剪贴板] OSC 52 解析失败:', err?.message);
    }
    return true;   // 无论成败都吞掉，别让转义序列漏到屏幕上
  });
}

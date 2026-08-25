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
      writeClipboard(text).then(ok => { if (ok) onCopied?.(text); });
    } catch (err) {
      console.error('[剪贴板] OSC 52 解析失败:', err?.message);
    }
    return true;   // 无论成败都吞掉，别让转义序列漏到屏幕上
  });
}

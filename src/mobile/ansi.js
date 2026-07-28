import Anser from 'anser';

/**
 * tmux capturePane 快照 → 安全 HTML（保留颜色，剥掉一切控制序列）。
 * 复制自桌面版 App.jsx 的 convertAnsiToHtml，额外剥离光标保存/恢复序列
 * （attach 回放场景 App.jsx:1008-1012 的处理）。
 */
export function convertAnsiToHtml(text) {
  if (!text) return '';

  let cleaned = text
    // 光标保存/恢复（\x1b[s \x1b[u \x1b7 \x1b8）
    .replace(/\x1b\[[su]/g, '')
    .replace(/\x1b[78]/g, '')
    // 光标控制序列
    .replace(/\x1b\[\??\d*[hlABCDEFGHJKSTfnsu]/g, '')
    // 光标位置设置
    .replace(/\x1b\[\d*;\d*[Hf]/g, '')
    // 清屏/清行
    .replace(/\x1b\[[012]?[JK]/g, '')
    // 滚动区域设置
    .replace(/\x1b\[\d*;\d*r/g, '')
    // 设备状态查询
    .replace(/\x1b\[\?[\d;]*[cnm]/g, '')
    // OSC 序列（标题设置等）
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // 其他 CSI 序列（保留颜色 m 序列）
    .replace(/\x1b\[[\d;]*[^m\d;]/g, '')
    // 回车符（保留换行）
    .replace(/\r(?!\n)/g, '');

  return Anser.ansiToHtml(Anser.escapeForHtml(cleaned), {
    use_classes: false
  });
}

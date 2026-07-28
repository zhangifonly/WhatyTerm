import React, { useRef, useLayoutEffect, useState } from 'react';
import { convertAnsiToHtml } from './ansi';

/**
 * 只读终端预览：Anser HTML 快照渲染（不用 xterm，无 resize）。
 * 默认自动换行适配窄屏；「原样」模式保 TUI 框线对齐、横向滚动。
 */
export default function TerminalPreview({ screen }) {
  const boxRef = useRef(null);
  const [wrap, setWrap] = useState(true);

  // 内容更新后自动滚底（用户上滑查看历史时不打扰：距底 >40px 不滚）
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40 + el.clientHeight * 0.1;
    if (nearBottom || el.scrollTop === 0) {
      el.scrollTop = el.scrollHeight;
    }
  }, [screen]);

  return (
    <div className="m-term-wrap">
      <button
        className="m-term-mode"
        onClick={() => setWrap(!wrap)}
        title={wrap ? '切换为原样（横向滚动）' : '切换为自动换行'}
      >
        {wrap ? '换行' : '原样'}
      </button>
      <pre
        ref={boxRef}
        className={`m-term ${wrap ? 'wrap' : 'raw'}`}
        dangerouslySetInnerHTML={{ __html: convertAnsiToHtml(screen) || '&nbsp;' }}
      />
    </div>
  );
}

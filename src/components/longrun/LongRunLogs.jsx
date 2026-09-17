import React, { useRef, useLayoutEffect } from 'react';
import { clockOf } from './longrunBoard.js';

/**
 * 「编排日志」：编排器打到日志里的每一行（沙箱、水位、每发结果、监督者判定、交接……），最近 500 行。
 * 离底部不足 40px 时自动跟随滚动。
 */
const LongRunLogs = ({ logs }) => {
  const boxRef = useRef(null);
  const stickRef = useRef(true);
  const list = logs || [];

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box && stickRef.current) box.scrollTop = box.scrollHeight;
  }, [list.length, list[list.length - 1]?.at]);

  const onScroll = () => {
    const b = boxRef.current;
    stickRef.current = b.scrollHeight - b.scrollTop - b.clientHeight < 40;
  };

  return (
    <div className="lr-logs" ref={boxRef} onScroll={onScroll}>
      {!list.length && <span className="lr-dim">还没有日志</span>}
      {list.map((l, i) => (
        <div key={i} className="lr-logline">{clockOf(l.at)} <b>{l.message}</b></div>
      ))}
    </div>
  );
};

export default LongRunLogs;

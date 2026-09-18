import React, { useState, useRef, useLayoutEffect, useEffect } from 'react';
import { mergedEntries, timelineCount, entryView, clockOf, ROLE_ICON } from './longrunBoard.js';

const PREFS_KEY = 'webtmux.longrun.timelinePrefs';
const readPrefs = () => {
  try { return { showTrace: true, fold: true, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; }
  catch { return { showTrace: true, fold: true }; }
};

/**
 * 「对话与关键节点」时间线。条目由后端归类，这里只管显示。
 * · 展开状态用条目自增 id 做键：用数组下标会在条目被挤出时整体错位，展开状态跳到别的条目上
 * · 跟随滚动：离底部不足 60px 时新条目到来自动滚到底，否则保持位置（人在往上翻时别把他拽下去）
 * · 两个开关记在本机（原版刷新即丢，每次都要重勾）
 */
const LongRunTimeline = ({ board, resetKey }) => {
  const [prefs, setPrefs] = useState(readPrefs);
  const [expanded, setExpanded] = useState(() => new Set());
  const boxRef = useRef(null);
  const stickRef = useRef(true);

  // 换了任务/回放，展开状态作废（id 只在同一个看板内唯一）
  useEffect(() => { setExpanded(new Set()); stickRef.current = true; }, [resetKey]);

  const list = mergedEntries(board, prefs.showTrace);
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box && stickRef.current) box.scrollTop = box.scrollHeight;
  }, [list.length, list[list.length - 1]?.id]);

  const setPref = (k, v) => {
    const next = { ...prefs, [k]: v };
    setPrefs(next);
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* 忽略 */ }
  };
  const toggle = (id) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const onScroll = () => {
    const b = boxRef.current;
    stickRef.current = b.scrollHeight - b.scrollTop - b.clientHeight < 60;
  };

  return (
    <div className="lr-tl">
      <div className="lr-tl-bar">
        <span className="lr-dim">{timelineCount(board, prefs.showTrace)}</span>
        <label><input type="checkbox" checked={prefs.showTrace} onChange={(e) => setPref('showTrace', e.target.checked)} /> 显示思考与工具</label>
        <label><input type="checkbox" checked={prefs.fold} onChange={(e) => setPref('fold', e.target.checked)} /> 折叠长内容</label>
      </div>
      <div className="lr-tl-box" ref={boxRef} onScroll={onScroll}>
        {!list.length && <span className="lr-dim">等待事件…</span>}
        {list.map((e) => {
          const v = entryView(e, { fold: prefs.fold, expanded });
          // 收工那条服务端归在灰色的 system 角色（与原版逐字段对拍，不能改），
          // 但它是整条时间线上最该被看见的一条 —— 前端单独加一个醒目类。
          // 条目里没有 kind 字段（只有 role/label/head/body），所以按标签认，标签来自服务端常量
          const cls = `lr-entry r-${e.role}${v.isTrace ? ' trace' : ''}${e.label === '运行结束' ? ' lr-finished' : ''}`;
          if (!v.open) {
            return (
              <div key={`${e.stream}-${e.id}`} className={`${cls} one`} onClick={() => toggle(e.id)}>
                <span className="who">{ROLE_ICON[e.role] || '·'}</span>
                <span className="lbl">{e.label}</span>
                <span className="sum">{v.head}</span>
                <span className="ts">{clockOf(e.at)}{v.len > 260 ? ` · ${v.len}字` : ''}</span>
              </div>
            );
          }
          return (
            <div key={`${e.stream}-${e.id}`} className={cls}>
              <div className="lr-entry-head">
                <span className="who">{ROLE_ICON[e.role] || '·'} {e.label}</span>
                {e.node && <span>{e.node}</span>}
                <span>{clockOf(e.at)}</span>
              </div>
              <div className="lr-entry-body">{e.body}</div>
              {v.collapsible && <div className="lr-more" onClick={() => toggle(e.id)}>收起</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default LongRunTimeline;

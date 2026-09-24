import React from 'react';
import { useScreen } from './useScreen';
import TerminalPreview from './TerminalPreview';
import AiCard from './AiCard';
import QuickActions from './QuickActions';
import PanelPicker from './PanelPicker';

/**
 * 会话详情页：终端预览(flex:1) → AI 卡片 → 快捷操作条(底部)。
 * 布局高度由父级 .m-content 撑满，QuickActions 自带 safe-area padding。
 */
export default function SessionDetail({ session, aiStatus, loading }) {
  const { screen, attached } = useScreen(session?.id);

  if (!session) {
    return <div className="m-empty">会话不存在或已关闭</div>;
  }

  return (
    <div className="m-detail">
      {!attached && <div className="m-attach-hint">连接会话中…</div>}
      <TerminalPreview screen={screen} />
      <AiCard session={session} aiStatus={aiStatus} loading={loading} />
      {/* 屏上挂着选项面板时，把选项渲染成可点按钮 —— 手机上没有方向键。
          认不出来就不渲染，QuickActions 里的 ↑↓/空格/Tab 是保底通路 */}
      <PanelPicker sessionId={session.id} screen={screen} />
      <QuickActions sessionId={session.id} />
    </div>
  );
}

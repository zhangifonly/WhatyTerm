import React, { useState } from 'react';
import { usePush } from './usePush';

const ICON = { on: '🔔', off: '🔕', denied: '🔕', unsupported: '🔕', 'needs-homescreen': '🔕' };

/**
 * 顶栏的提醒开关。只推两件事：长程开始等你、长程收工 —— 在面板里写明，
 * 免得人以为开了会被每条进度轰炸而不敢开。
 */
export default function PushSettings() {
  const p = usePush();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button className="m-btn m-push-toggle" aria-label="提醒设置" onClick={() => setOpen((v) => !v)}>
        {ICON[p.status] || '🔕'}
      </button>
      {open && (
        <div className="m-push-panel">
          <div className="m-push-head">
            <b>手机提醒</b>
            <button className="m-btn" onClick={() => setOpen(false)}>收起</button>
          </div>
          <div className="m-lr-dim">只在两种时候通知这台手机：长程停下来等你回答、长程收工。</div>

          {p.status === 'needs-homescreen' && (
            <div className="m-push-hint">
              iPhone 上要先把本页加到主屏幕：点 Safari 底部的「分享」→「添加到主屏幕」，
              再从主屏幕图标打开，回到这里开启。（需要 iOS 16.4 及以上）
            </div>
          )}
          {p.status === 'unsupported' && <div className="m-push-hint">这个浏览器不支持网页推送。</div>}
          {p.status === 'denied' && (
            <div className="m-push-hint">通知权限被拒绝过。请到系统「设置 → 通知」里找到本应用重新允许，再回来开启。</div>
          )}

          <div className="m-lr-row">
            {p.status === 'off' && <button className="m-btn primary" disabled={p.busy} onClick={p.enable}>开启提醒</button>}
            {p.status === 'on' && (
              <>
                <button className="m-btn primary" disabled={p.busy} onClick={p.test}>发一条测试</button>
                <button className="m-btn" disabled={p.busy} onClick={p.disable}>关闭提醒</button>
              </>
            )}
          </div>
          {p.msg && <div className="m-lr-msg">{p.msg}</div>}
        </div>
      )}
    </>
  );
}

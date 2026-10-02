import React from 'react';

/**
 * 服务端跑着旧代码时置顶告警（AI 面板与长程面板共用）：判定逻辑全在服务端，
 * 不重启的话所有修复都不生效，而界面上原本毫无迹象。
 */
/**
 * 页面跑着旧前端：服务端已升级重启，但这个页面是升级前打开的、一直没刷新。
 * 后端数据是新的、界面文字和逻辑是旧的，两者会互相矛盾（实测「登录后 7 天内免登录」旁边写着「28 天后到期」）。
 * 不自动刷新：用户可能正在输入。只提示，点一下刷新。
 */
/** 1.4.81 vs 1.4.82 → 负数表示 a 更旧 */
export function compareVersion(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

export const PageStaleBanner = ({ serverVersion }) => {
  const pageVersion = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';
  if (!serverVersion || !pageVersion || serverVersion === 'unknown') return null;
  // 只在页面比服务旧时提示。页面更新、服务没重启是另一种情况，由下面的 ServerStaleBanner 报
  if (compareVersion(pageVersion, serverVersion) >= 0) return null;
  return (
    <div className="page-stale-banner" role="status">
      <span>页面是旧版本 v{pageVersion}，服务已更新到 v{serverVersion}</span>
      <button type="button" onClick={() => window.location.reload()}>刷新</button>
    </div>
  );
};

const ServerStaleBanner = ({ stale }) => {
  if (!stale) return null;
  return (
    <div className="server-stale-banner">
      <strong>⚠️ 服务端运行的是旧代码</strong>
      <p>
        进程内 v{stale.bootVersion}（启动于 {new Date(stale.startedAt).toLocaleString()}），
        磁盘上已是 v{stale.diskVersion}。
      </p>
      <p>状态判定全在服务端，重启前所有修复都不会生效。</p>
    </div>
  );
};

export default ServerStaleBanner;

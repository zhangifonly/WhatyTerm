import React from 'react';

/**
 * 服务端跑着旧代码时置顶告警（AI 面板与长程面板共用）：判定逻辑全在服务端，
 * 不重启的话所有修复都不生效，而界面上原本毫无迹象。
 */
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

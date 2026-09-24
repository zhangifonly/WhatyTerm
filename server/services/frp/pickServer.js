/**
 * FRP 服务器选择：**地址稳定优先于快几百毫秒**。
 *
 * 由来（2026-09-24）：原来每次启动都挑延迟最低的那台。几台服务器同在洛杉矶，
 * 实测 847ms 对 848ms 这种差距就会让隧道域名在 frp.whaty.org 与 frp-lax01.whaty.org 之间来回翻
 * （历史日志两个域名都出现过）。以前只是书签偶尔打不开；有了手机推送后是硬伤：
 * 主屏幕图标、Service Worker、推送订阅都绑在**域名**上，域名一翻，点通知打开的是 404。
 *
 * 规则：
 * 1. 上次用的那台仍可用，且没比最快那台慢出 SLACK_MS → 继续用它
 * 2. 没有记录（首次）→ 按配置顺序取第一台可用的（配置顺序即优先级，与延迟抖动无关）
 * 3. 上次那台不可用或慢得离谱 → 才换最快的
 */

/** 上次那台比最快的慢多少以内仍然坚持用它。握手延迟的正常抖动在几百毫秒内 */
export const SLACK_MS = 2000;

/**
 * @param {Array<{server:{name:string}, latency:number}>} available  可用服务器（顺序 = 配置顺序）
 * @param {string|null} lastName  上次用的服务器名
 * @returns {{server:object, latency:number, reason:'sticky'|'config-order'|'fastest'}|null}
 */
export function pickFrpServer(available, lastName, slackMs = SLACK_MS) {
  const list = (available || []).filter((r) => r && r.server && Number.isFinite(r.latency));
  if (!list.length) return null;
  const fastest = list.reduce((a, b) => (b.latency < a.latency ? b : a));
  if (lastName) {
    const last = list.find((r) => r.server.name === lastName);
    if (last && last.latency - fastest.latency <= slackMs) return { ...last, reason: 'sticky' };
    return { ...fastest, reason: 'fastest' };
  }
  return { ...list[0], reason: 'config-order' };
}

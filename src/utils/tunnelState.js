/**
 * 远程访问地址（左下角 📱 二维码按钮依它显示）怎么随隧道事件变化（纯函数，前端用）。
 *
 * 由来（2026-09-26）：付费用户启动时 FRP 与 Cloudflare 两条隧道**并行**建立，FRP 成功就把 Cloudflare 停掉。
 * Cloudflare 进程退出时照样广播 `tunnel:disconnected`（不带是哪条隧道），前端一收到就把地址清空 ——
 * 于是 FRP 明明好好的，📱 按钮却消失了（每次服务启动都会发生）。
 * 两条隧道还共用 ai-settings.json 的 tunnelUrl：Cloudflare 停止时写空串，把 FRP 刚存的地址也抹了。
 *
 * 规则：断开事件只清掉「当前显示的正是它」那一条；带不带 type 都要能判断（旧事件没有 type）。
 */

/** @typedef {{url: string, type: string}} TunnelView */

/** 从 URL 认隧道类型：trycloudflare.com 是 Cloudflare 快速隧道，其余视为 FRP 固定域名 */
export function tunnelTypeOf(url) {
  if (!url) return '';
  let host = '';
  try { host = new URL(String(url)).hostname; } catch { host = ''; }   // 按主机名判断，路径或参数里带这个字样不算
  return /(^|\.)trycloudflare\.com$/i.test(host) ? 'cloudflare' : 'frp';
}

/**
 * @param {TunnelView} cur 当前显示的地址
 * @param {{kind: 'connected'|'disconnected', url?: string, type?: string}} ev
 * @returns {TunnelView}
 */
export function nextTunnelView(cur, ev) {
  const current = { url: cur?.url || '', type: cur?.type || tunnelTypeOf(cur?.url) };
  if (ev?.kind === 'connected') {
    if (!ev.url) return current;
    const type = ev.type || tunnelTypeOf(ev.url);
    // FRP 是固定域名、优先用；它在时 Cloudflare 的「已连接」不顶替它（启动时两条并行，谁先到不一定）
    if (current.url && current.type === 'frp' && type === 'cloudflare') return current;
    return { url: ev.url, type };
  }
  if (ev?.kind === 'disconnected') {
    // 旧版服务端的 Cloudflare 断开事件不带 type：按「断开的一定不是 FRP」处理只在当前是 Cloudflare 时清
    const type = ev.type || 'cloudflare';
    return current.type === type ? { url: '', type: '' } : current;
  }
  return current;
}

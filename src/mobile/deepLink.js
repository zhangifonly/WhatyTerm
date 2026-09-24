/**
 * 从链接里取要直接打开的会话。点推送通知进来时带 ?session=<id>（见 server/services/longrunPush.js）。
 * 相对链接（SW 传来的是绝对地址，冷启动是 location.href）都要能解析；解析不了就当没有。
 */
export function sessionFromUrl(href) {
  try { return new URL(href, 'http://x').searchParams.get('session') || null; } catch { return null; }
}

/**
 * 交接向导的纯展示逻辑（无 React、无 IO，可单测）。
 *
 * ⚠ HANDOFF_STEPS 的值必须与服务端 server/services/longrunHandoff.js 的 HANDOFF_PHASE 逐字相同 ——
 *   服务端推的就是这几句原文，界面拿它比对当前处在哪一步。前端不 import 服务端模块（打包边界），
 *   所以抄了一份，由 tests/test-longrun-handoff.mjs 守着两边不许漂移。
 */
export const HANDOFF_STEPS = {
  waiting: '等这个会话闲下来…',
  sent: '已把收尾指令发给它',
  writing: '它正在把进度写进记忆…',
  quitting: '记忆写完了，正在退出 CLI…',
  done: '交接完成',
};

/**
 * 交接成功后的一句话总结：写了几个记忆文件、下一步有没有拿到、CLI 退了没有。
 * 拿不到就如实说「没抽到」，绝不编 —— 抽到的那句会原样变成长程执行者的任务。
 */
export function handoffSummary(result) {
  if (!result?.ok) return '';
  const files = result.receipt?.files || [];
  const parts = [files.length ? `更新了 ${files.length} 个记忆文件` : '它没有列出更新的记忆文件（请看下面的原文自行确认）'];
  parts.push(result.receipt?.nextStep ? '已拿到「下一步」，会预填进长程需求' : '没抽到明确的「下一步」，长程需求需要你自己填');
  parts.push(result.exited ? 'CLI 已退出' : 'CLI 可能还没退出');
  return parts.join('；') + '。';
}

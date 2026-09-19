/**
 * 「机械继续」的第二道计数：不看屏幕有没有变，只数连着发了多少次「继续」。
 *
 * 为什么需要第二道：原有熔断（index.js 的 continueCount）判据是
 * **发了继续但 Claude 回复正文没变**。那是为了不误伤「继续→干活→回复→继续」
 * 这种正常节奏（v1.2.59 修过一次误熔断致永久挂死）。
 * 但 2026-09-18 tableCard 实测出它拦不住的形态：每次「继续」CLI 都真回了话
 * （`（等）`、`Cooked for 14s`、最后甚至写「我一直在等指令，你一直发『继续』」），
 * 回复正文每轮都不同 → 计数每轮归零 → 三道闸一次没触发，
 * 机械「继续」发到 15 万余次、烧掉 $1519，而 CLI 早就停在一个四选一的问题上。
 *
 * 所以这里换一个正交的判据：**次数本身**。屏幕在变也不代表工作在推进 ——
 * CLI 可以一边礼貌回话一边原地等人决策。连发这么多次仍要靠我们催，
 * 就不该再猜，交给 AI 读屏或交人工。
 */

/**
 * 连发多少次「继续」就不再机械发。
 *
 * 取 8：正常开发节奏里一轮「继续」通常换来几分钟的实际工作，连着 8 次还在催，
 * 已经不是节奏问题。取小了会误伤（v1.2.59 的 4 就误伤过），取大了没意义 ——
 * 上限的作用是兜底，主判据是 pendingQuestion 与下面的抱怨识别。
 */
export const MECHANICAL_CONTINUE_LIMIT = 8;

/**
 * CLI 在**抱怨我们复读**：它已经明说「继续」不是有效输入。
 * 这是最强的停手信号 —— 对方直接告诉我们沟通错频道了，再发一次纯属浪费钱。
 * 措辞取自实测原话，并留出同义变体。
 */
const COMPLAINT_RE = /(你|您)一直(在)?发.{0,4}继续|一直在等(你的)?指令|理解不了.{0,4}继续.{0,4}(指什么|是什么)|不(要|用)再发.{0,4}继续|重复(发送|发).{0,4}继续|继续.{0,4}(不是|并非).{0,6}(答案|有效)|我们在不同的频道|\bkeep (saying|sending) ["「']?继续|\bI (don't|do not) know what ["「']?继续/i;

/**
 * 判断是否该停掉机械「继续」。
 * @param {object} p
 * @param {number} p.streak     连续发出的「继续」次数（不因屏幕变化归零）
 * @param {string} p.lastReply  CLI 最近一段回复正文（已剥 ANSI）
 * @returns {{stop:boolean, reason:string}} stop 为真时应放弃机械继续、升级判断
 */
export function shouldStopMechanicalContinue({ streak = 0, lastReply = '' } = {}) {
  if (COMPLAINT_RE.test(String(lastReply || ''))) {
    return { stop: true, reason: 'CLI 明确表示「继续」不是它要的输入，已停止机械继续' };
  }
  if (streak >= MECHANICAL_CONTINUE_LIMIT) {
    return { stop: true, reason: `已连发 ${streak} 次「继续」仍需我们催，屏幕虽在变但工作没往前走，已停止机械继续` };
  }
  return { stop: false, reason: '' };
}

/**
 * 累计连发次数：只要本次动作还是「继续」就 +1，换了别的动作（或人工介入）归零。
 * 与 index.js 里那个「屏幕没变才累加」的 continueCount 互补，两者都不单独充分。
 */
export function nextStreak(prevStreak, action) {
  return /^继续/.test(String(action || '')) ? (Number(prevStreak) || 0) + 1 : 0;
}

export default { shouldStopMechanicalContinue, nextStreak, MECHANICAL_CONTINUE_LIMIT };

/**
 * 「任务是否真的全部完成」的统一判定。
 *
 * 背景：原先三处（AIEngine 的 Codex 分支、Claude 分支，以及 FullStackDevPlugin）
 * 各自内联同一条正则，其中 `已(全部)?完成` 单独成立，于是
 * 「本批已完成并同步到 ...」这种阶段性汇报被判成整个任务结束，自动模式就此卡死——
 * 哪怕同屏下一行明明写着「下一批目标是 0x1e145660 ...」。
 *
 * 现在改为三段式：先看有没有「还有后续工作」的明确信号（有则一票否决），
 * 再看「完成」是不是只限定在本批/本轮（是则否决），最后才匹配真正的全局完成词。
 */

// 明确宣告还有后续工作 —— 命中即一票否决，无论后面说得多像"完成"
const HAS_NEXT_WORK = /下一[批步个轮]|下个(任务|批次|阶段)|接下来|后续(的)?(工作|任务|计划|批次)|剩余(的)?(任务|工作)|待完成|待办|尚未完成|还需(要)?|next\s+(batch|step|task|up)|remaining\s+(tasks?|work|items?)|\bTODO\b/i;

// 「完成」只限定在当前这一批/一轮/一步 —— 属于进度汇报，不是收工
const SCOPE_LIMITED = /(本批|这批|该批|本轮|这轮|本次|这次|当前批次|当前轮|本阶段|这一步|当前步骤|第\s*\d+\s*[批轮步阶]|batch\s*\d+|step\s*\d+)[^。\n]{0,12}(已|完成|done)/i;

// 真正的全局完成 —— 注意不含裸的「已完成」，必须带 全部/所有/整个 之类的全局限定
const ALL_DONE = /没有(更多|其他)?(任务|工作|需要|要做)|全部(任务|工作)?(都)?(已)?完成|所有(任务|工作)(都)?(已)?完成|已(全部)?完成(所有|全部|整个)|任务[^。\n]{0,10}已[^。\n]{0,10}全部完成|工作[^。\n]{0,10}已[^。\n]{0,10}结束|没什么[^。\n]{0,10}要做|all\s*(tasks?\s*)?(are\s*)?(done|complete)|nothing\s*(left\s*)?(to\s*do|more)|no\s*(more\s*)?(tasks?|work)\b/i;

/**
 * 判断终端文本是否表示「整个任务已完成，不该再发继续」。
 * @param {string} text 已剥离 ANSI 的终端尾部文本
 * @returns {boolean}
 */
export function isTaskDone(text) {
  if (!text) return false;
  // 有明确的下一批/下一步 → 还有活干
  if (HAS_NEXT_WORK.test(text)) return false;
  // 完成只针对本批/本轮 → 阶段性汇报
  if (SCOPE_LIMITED.test(text)) return false;
  return ALL_DONE.test(text);
}

/**
 * 是否明确提到了后续工作（用于把"继续"细化成"继续下一步"）。
 * @param {string} text
 * @returns {boolean}
 */
export function hasExplicitNextWork(text) {
  return !!text && HAS_NEXT_WORK.test(text);
}

export default { isTaskDone, hasExplicitNextWork };

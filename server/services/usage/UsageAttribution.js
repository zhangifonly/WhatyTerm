/**
 * 归属：这个终端会话的花费该算在哪些 CLI 记录上（纯函数，零 I/O）
 *
 * 为什么要专门判：实测同一个工作目录下最多有 5 个会话（bpecard），按目录认领会把别人的账算到自己头上；
 * 而 `lsof` 拿不到 CLI 与 .jsonl 的绑定（append 完就关文件），所以只能靠下面三级：
 *   1. hook 给的 claudeSessionId —— hook 带 TMUX_PANE，服务端按窗格精确反查会话，是唯一 100% 可靠的通道
 *   2. 同目录同类型只有这一个在跑 —— 排他推断
 *   3. 都不满足 → **不认领**，如实标「归属不明」，界面上如实说明拿不到。绝不按 mtime 猜。
 */

export const SUPPORTED = ['claude', 'codex'];

/** Grok 实测本地不记任何 token/费用；gemini/droid 未接 */
export function isSupportedCli(aiType) {
  return SUPPORTED.includes(String(aiType || 'claude'));
}

/**
 * @param {object} session {id, aiType, workingDir, claudeSessionId, claudeTranscriptPath}
 * @param {object[]} siblings 同目录、同 aiType、仍在运行的其它会话（不含自己）
 * @returns {object} {kind, cli, runKey?, filePath?, source?, reason?}
 */
export function decideBinding(session, siblings = []) {
  const cli = String(session?.aiType || 'claude');
  if (!isSupportedCli(cli)) {
    return { kind: 'unsupported', cli, reason: `${cli} 不在本地记录用量` };
  }
  if (cli === 'claude' && session.claudeSessionId) {
    return {
      kind: 'bound', cli, source: 'hook',
      runKey: session.claudeSessionId,
      filePath: session.claudeTranscriptPath || null,   // 没有就由调用方按工作目录推算
    };
  }
  if (siblings.length > 0) {
    return { kind: 'ambiguous', cli, reason: `同目录还有 ${siblings.length} 个 ${cli} 会话在跑，无法区分是谁花的` };
  }
  // 同目录同类型只有自己 → 可以按目录认领（claude 取该项目最新 transcript，codex 取该 cwd 的 rollout）
  return { kind: 'exclusive', cli, source: 'exclusive' };
}

/** 同目录、同 CLI、仍在运行的其它会话 */
export function siblingsOf(session, allSessions = []) {
  return allSessions.filter((s) => s.id !== session.id
    && s.status === 'running'
    && String(s.aiType || 'claude') === String(session.aiType || 'claude')
    && s.workingDir && s.workingDir === session.workingDir);
}

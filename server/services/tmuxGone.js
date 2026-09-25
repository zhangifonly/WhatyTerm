/**
 * tmux 会话是不是**确实**没了。
 *
 * 由来（2026-09-26 Hitech）：附着客户端断开时，原代码跑一次 `tmux has-session`，只要这条命令**出错**
 * 就当「用户 exit 了」→ 把会话记录标成已删除、再去杀 tmux。实测 01:15 一条会话记录被删，
 * 而 tmux 和里面的 Claude 一直活到 06:59 整机重启（对话文件 06:59 还在写）—— 判断是错的，
 * 杀 tmux 也同样失败了。结果重启后这条会话没被重建，只剩同目录的旧条目，接回的是旧对话。
 *
 * 规则：只有 tmux **明确回答「找不到这个会话 / 没有 tmux 服务」**才算没了；
 * 命令没跑起来、被信号打断、超时、其他报错 —— 一律「说不准」，不许据此删会话。
 */

import { spawnSync } from 'child_process';

const GONE_TEXT = /can't find session|session not found|no server running|error connecting to/i;

/**
 * @param {{status:number|null, signal?:string|null, error?:Error, stderr?:string}} r  spawnSync 的结果
 * @returns {'alive'|'gone'|'unknown'}
 */
export function classifyHasSession(r) {
  if (!r || r.error || r.signal) return 'unknown';
  if (r.status === 0) return 'alive';
  if (r.status === 1 && GONE_TEXT.test(String(r.stderr || ''))) return 'gone';
  return 'unknown';
}

/** @param {string[]} tmuxCmd  如 ['tmux'] 或 ['wsl','tmux'] */
export function probeTmuxSession(tmuxCmd, name) {
  const [bin, ...pre] = tmuxCmd;
  return classifyHasSession(spawnSync(bin, [...pre, 'has-session', '-t', name], { encoding: 'utf8', timeout: 5000 }));
}

/**
 * 连查几次直到有定论。「说不准」时隔一会儿再查（被信号打断、机器正忙多半是一时的）。
 * @returns {Promise<'alive'|'gone'|'unknown'>} 查满次数仍说不准就返回 unknown —— 调用方**不得**当成已退出
 */
export async function confirmTmuxGone(probe, { tries = 3, delayMs = 2000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = probe();
    if (v !== 'unknown') return v;
    if (i < tries - 1) await sleep(delayMs);
  }
  return 'unknown';
}

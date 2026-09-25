/**
 * 内置服务异常退出后的重拉策略（纯逻辑，便于单测；main.cjs 是 CommonJS，所以放 .cjs）。
 *
 * 为什么需要：服务进程自己救不了自己（SIGKILL / OOM 时任何钩子都跑不到），只能靠父进程重拉。
 * 以前 main.cjs 只在 close 事件里记一行日志，服务一死整个应用就只剩一个连不上的窗口。
 *
 * 规则：
 * - 主动停止（退出应用、stopServer）→ 不重拉
 * - 异常退出 → 退避重拉：1s、2s、4s … 封顶 30s；连续成功跑满 fastFailMs 后退避归零
 * - 启动后 fastFailMs 内就退出算「快速失败」，连续 maxFastFails 次 → 放弃并告诉用户
 *   （多半是端口被占、依赖坏了这类重拉也不会好的问题，无限重拉只会刷日志、占 CPU）
 */

const DEFAULTS = { baseMs: 1000, maxMs: 30000, fastFailMs: 10000, maxFastFails: 5 };

class RespawnPolicy {
  constructor(opts = {}) {
    this.o = { ...DEFAULTS, ...opts };
    this.startedAt = 0;
    this.attempt = 0;     // 连续异常退出次数（决定退避）
    this.fastFails = 0;   // 连续快速失败次数（决定放弃）
  }

  /** 每次拉起服务时调用 */
  onStart(now) {
    this.startedAt = now;
  }

  /**
   * 服务退出时调用。
   * @param {number} now
   * @param {{stopping?: boolean, code?: number|null, signal?: string|null}} info
   * @returns {{action: 'none'} | {action: 'restart', delayMs: number, attempt: number} | {action: 'giveup', reason: string}}
   */
  onExit(now, { stopping = false } = {}) {
    if (stopping) return { action: 'none' };
    const ranMs = this.startedAt ? now - this.startedAt : 0;
    if (ranMs >= this.o.fastFailMs) {
      this.attempt = 0;
      this.fastFails = 0;
    } else {
      this.fastFails += 1;
    }
    if (this.fastFails >= this.o.maxFastFails) {
      return { action: 'giveup', reason: `服务连续 ${this.fastFails} 次启动后 ${Math.round(this.o.fastFailMs / 1000)} 秒内就退出` };
    }
    const delayMs = Math.min(this.o.baseMs * 2 ** this.attempt, this.o.maxMs);
    this.attempt += 1;
    return { action: 'restart', delayMs, attempt: this.attempt };
  }
}

module.exports = { RespawnPolicy, DEFAULTS };

/**
 * 「发送未生效」的会话：自动操作发出去了，但 CLI 没收进去，监控已停手 —— 需要人看一眼。
 *
 * 为什么单独一张表、单独一个事件：以前这种情况只在台账里记一笔 no_effect、熔断后静默停手，
 * 界面上仍写着「检测到等待输入状态，发送继续」，看起来一切正常（实测 WebOffice 停了 4 个多小时没人发现）。
 * ai:status 有 13 处发送点，逐个加字段容易漏；这里集中维护，变了就整表广播。
 *
 * 解除只认硬证据：之后某次发送确认落地、或 CLI 开始运行。**不按屏幕哈希变化解除** ——
 * 卡住时状态栏照样在变（实测 WebOffice 两个哈希来回跳），按哈希解除标记会一闪就没。
 */

export class InputStuckTracker {
  /** @param {{onChange?: (all: object) => void, now?: () => number}} [o] */
  constructor({ onChange = null, now = Date.now } = {}) {
    this.map = new Map();   // sessionId -> {reason, since, source}
    this.onChange = onChange;
    this.now = now;
  }

  /** 标记。同一会话重复标记只更新原因，since 保留第一次（界面显示「卡了多久」） */
  set(sessionId, reason, source = 'send') {
    if (!sessionId) return;
    const prev = this.map.get(sessionId);
    if (prev && prev.reason === reason) return;
    this.map.set(sessionId, { reason, source, since: prev?.since || this.now() });
    this._emit();
  }

  clear(sessionId) {
    if (this.map.delete(sessionId)) this._emit();
  }

  /** 每轮抓屏后调用：CLI 跑起来了 = 已经不卡了 */
  refresh(sessionId, screen) {
    if (this.map.has(sessionId) && /esc to interrupt/i.test(String(screen || '').slice(-3000))) this.clear(sessionId);
  }

  has(sessionId) { return this.map.has(sessionId); }

  all() { return Object.fromEntries(this.map); }

  _emit() {
    try { this.onChange?.(this.all()); } catch { /* 广播失败不能影响监控 */ }
  }
}

export default InputStuckTracker;

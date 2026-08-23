import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

/**
 * 自动操作效果台账。
 *
 * 背景：监控每天发出成千上万次自动操作（历史日志里「等待接受编辑 → 发继续」一项就 3271 次），
 * 但此前唯一的效果验证是「2 秒后屏上有没有 Interrupted」，而且只在一条执行路径上、只存内存 10 条。
 * 更糟的是它把「没被打断」记作 success —— 往一个根本不理会的会话里发「继续」也算成功。
 * 于是「监控策略到底有没有用」这个问题，系统自己答不上来。
 *
 * 这里改为：每次发送后延迟回读屏幕，按判定类型记录**它有没有推动事情发生**，落盘成 JSONL，
 * 可按判定类型聚合出命中率。目的是让策略调整有依据，而不是继续凭感觉加正则。
 */

// 回读延迟：太短 CLI 还没反应，太长就不好归因到这次操作
const VERIFY_DELAY = 6000;
// 连续多少次毫无效果就停手。3 次约等于 18 秒~1 分钟内反复按键无反应，
// 再按下去也只是空转（而且每轮都在花监控成本）。
const NO_EFFECT_LIMIT = 3;
const LEDGER_PATH = path.join(os.homedir(), '.webtmux', 'action-outcomes.jsonl');
const MAX_BYTES = 5 * 1024 * 1024;   // 超过就轮转，保留一个 .1 备份

// 屏幕「实质变化」比对前要抹掉的易变噪音：计时器、token 计数、spinner、光标。
// 不抹的话，CLI 只要挂着一个走秒的状态栏，每次回读都算「变了」，统计就没意义了。
const VOLATILE = [
  /\(\s*\d+h?\s*\d*m?\s*\d*s\s*[·•][^)]*\)/gi,   // (12s · esc to interrupt) / (1h 2m 3s · ...)
  /\d+(\.\d+)?[km]?\s*tokens?/gi,
  /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒|\/\-\\]\s*(?=\S)/g,        // spinner
  /\x1b\[[0-9;?]*[a-zA-Z]/g,
  /\x1b\][^\x07]*\x07/g,
  /\s+/g
];

function normalize(screen) {
  let s = String(screen || '');
  for (const re of VOLATILE) s = s.replace(re, ' ');
  return s.trim();
}

function hash(screen) {
  return crypto.createHash('sha1').update(normalize(screen)).digest('hex').slice(0, 12);
}

// CLI 确实动起来了的证据（比「屏幕变了」更强的成功信号）
const RUNNING = /esc to interrupt|正在|Running \d+ Task|\bthinking\b/i;
const INTERRUPTED = /Interrupted\s*[·•]\s*What should Claude do instead/i;
const CONFIRM_MENU = /(Do you want to|Would you like to)[\s\S]{0,400}?[❯>]?\s*1\.\s+\S/i;

class ActionOutcome {
  constructor() {
    this.pending = new Map();   // id -> timer
    this.recent = [];           // 内存里保留最近若干条，供接口即时查询
    this.enabled = true;
    // 连续空转计数：sessionId -> { count, state, stuckHash }
    // 屏幕一动就清零，所以它只会在"真的卡住"时累积
    this.streak = new Map();
  }

  /**
   * 记一次自动操作，并安排回读验证。
   * @param {object} session - 会话对象（需要 getScreenContent）
   * @param {object} info - { state, actionType, action, source }
   *   state 是判定名（如「Claude Code等待接受编辑」），聚合就按它分组
   */
  record(session, info) {
    if (!this.enabled || !session) return;
    // ⚠️ 「操作前」必须用**做判断时那一屏**，而不是现在重新抓一次：
    //    record() 在发送之后调用，此时输入框里已经回显了刚打进去的文字，
    //    拿它当基线，比的就成了"回显之后 vs 6 秒后"，而不是"我们判断的那屏 vs 之后"。
    const before = info.beforeScreen
      || (session.getScreenContent ? session.getScreenContent() : '');
    const entry = {
      id: `${session.id}-${Date.now()}`,
      at: new Date().toISOString(),
      sessionId: session.id,
      sessionName: session.name,
      state: info.state || '未知',
      actionType: info.actionType || null,
      action: typeof info.action === 'string' ? info.action.slice(0, 40) : String(info.action || ''),
      source: info.source || 'rule',
      beforeHash: hash(before),
      hadConfirmMenu: CONFIRM_MENU.test(before)
    };

    const timer = setTimeout(() => {
      this.pending.delete(entry.id);
      try {
        this._verify(session, entry);
      } catch (err) {
        console.error('[效果台账] 回读失败:', err.message);
      }
    }, VERIFY_DELAY);
    if (timer.unref) timer.unref();
    this.pending.set(entry.id, timer);
    return entry;   // 返回记录本身，方便调用方与测试核对基线取自哪一屏
  }

  /**
   * 回读判定。成功的定义按操作类型区分——这是整个台账的关键：
   * 把「没被打断」当成功，就等于给"往死会话里发继续"发及格证。
   */
  _verify(session, entry) {
    const after = session.getScreenContent ? session.getScreenContent() : '';
    const changed = hash(after) !== entry.beforeHash;
    const interrupted = INTERRUPTED.test(after);
    const running = RUNNING.test(after);
    const menuGone = entry.hadConfirmMenu && !CONFIRM_MENU.test(after);

    let outcome;
    if (interrupted) {
      outcome = 'interrupted';          // 明确的坏结果：打断了正在跑的活
    } else if (!changed) {
      // 屏幕纹丝不动 = 发了等于没发。这一条必须**先于** running 判断：
      // 屏上本来就挂着的运行指示器是操作之前就在跑的活，不能算这次操作的功劳，
      // 否则往一个正忙的会话里乱发按键会被记成满分。
      outcome = 'no_effect';
    } else if (entry.actionType === 'select') {
      outcome = menuGone ? 'advanced' : 'no_effect';   // 菜单没消失说明按键没被 Ink 收到
    } else if (running) {
      outcome = 'advanced';             // CLI 真的动起来了，最强的成功信号
    } else {
      outcome = 'changed';              // 屏幕变了但看不出在干活，弱成功
    }

    if (outcome === 'no_effect') {
      const st = this.streak.get(entry.sessionId) || { count: 0 };
      st.count++;
      st.state = entry.state;
      st.stuckHash = hash(after);   // 记下卡住的那一屏，屏幕一变就解除
      this.streak.set(entry.sessionId, st);
    } else {
      this.streak.delete(entry.sessionId);
    }

    const rec = { ...entry, outcome, changed, interrupted, running };
    this.recent.push(rec);
    if (this.recent.length > 500) this.recent.shift();
    this._append(rec);
    if (outcome === 'no_effect' || outcome === 'interrupted') {
      console.log(`[效果台账] ${entry.sessionName}: 「${entry.state}」发出 "${entry.action}" → ${outcome}`);
    }
  }

  /**
   * 该不该停手。
   *
   * 占比最高的那条判定（「等待接受编辑」，历史日志 3271 次）本质是
   * 「没看到提示符、也没看到运行迹象」时的兜底猜测——屏幕因为任何原因不可解析
   * 都会落到它，然后发「继续」。猜错时没有任何机制叫停，只会 15 秒一轮地重复。
   *
   * 这里用台账的实测结果兜底：同一会话连续 N 次操作都毫无效果，且屏幕始终停在
   * 卡住的那一屏，就停止自动操作。屏幕一旦真的变了立刻解除——所以它不会把
   * 正常会话锁死，只在"我们在对着一块石头按键"时生效。
   *
   * @param {string} sessionId
   * @param {string} currentScreen - 当前屏幕，用于判断是否已脱离卡住状态
   * @returns {string|null} 停手原因；null 表示放行
   */
  shouldPause(sessionId, currentScreen) {
    const st = this.streak.get(sessionId);
    if (!st || st.count < NO_EFFECT_LIMIT) return null;
    if (currentScreen && hash(currentScreen) !== st.stuckHash) {
      this.streak.delete(sessionId);   // 屏幕动了，自愈
      return null;
    }
    return `连续 ${st.count} 次自动操作毫无效果（判定「${st.state}」），屏幕始终未变，已停手等人工介入`;
  }

  _append(rec) {
    try {
      fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
      try {
        if (fs.statSync(LEDGER_PATH).size > MAX_BYTES) {
          fs.renameSync(LEDGER_PATH, LEDGER_PATH + '.1');
        }
      } catch {}
      fs.appendFileSync(LEDGER_PATH, JSON.stringify(rec) + '\n');
    } catch (err) {
      console.error('[效果台账] 写入失败:', err.message);
    }
  }

  /**
   * 按判定类型聚合。这是「监控策略到底有没有用」的答案来源：
   * 某个判定如果 no_effect 占比很高，说明那条规则在空转，该改或该删。
   * @param {number} limit - 只统计最近多少条（默认全部已落盘记录）
   */
  stats(limit = 5000) {
    const rows = this._load(limit);
    const by = new Map();
    for (const r of rows) {
      const k = r.state || '未知';
      const g = by.get(k) || { state: k, total: 0, advanced: 0, changed: 0, no_effect: 0, interrupted: 0, actions: {} };
      g.total++;
      g[r.outcome] = (g[r.outcome] || 0) + 1;
      g.actions[r.action] = (g.actions[r.action] || 0) + 1;
      by.set(k, g);
    }
    const list = [...by.values()].map(g => ({
      ...g,
      // 有效率 = 真推进了 + 屏幕有变化；空转率是最该看的那个数
      effectiveRate: +(((g.advanced + g.changed) / g.total) * 100).toFixed(1),
      noEffectRate: +((g.no_effect / g.total) * 100).toFixed(1),
      interruptRate: +((g.interrupted / g.total) * 100).toFixed(1)
    })).sort((a, b) => b.total - a.total);
    return { sampled: rows.length, byState: list };
  }

  _load(limit) {
    try {
      const raw = fs.readFileSync(LEDGER_PATH, 'utf-8').trim();
      if (!raw) return this.recent.slice(-limit);
      const lines = raw.split('\n').slice(-limit);
      return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch {
      return this.recent.slice(-limit);
    }
  }
}

const actionOutcome = new ActionOutcome();
export default actionOutcome;
export { normalize, hash, VERIFY_DELAY, NO_EFFECT_LIMIT };

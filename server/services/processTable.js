/**
 * 进程表快照与 ps 限流（macOS）
 *
 * ⚠ macOS 上 ps 是**串行**的：内核里读进程表要排队，并发 N 个 ps 总耗时随 N 线性增长、而且一起返回
 *   （实测单次 80ms，并发 8 → 各 960ms，并发 16 → 各 2.1s）。启动时 35 个会话各自 ps，每个都要 ~4.6s，
 *   全部撞 3 秒超时被杀，日志里 32 条 "[readClaudeProcessEnv] 失败: Command failed"（2026-09-17）。
 *
 * 所以：
 *   · 查"某会话下有哪些进程"不再每会话一次 ps/pgrep，改为整张进程表取一次，多个调用方共享（single-flight + 短缓存）
 *   · 读进程环境变量的 ps eww 只能逐个 pid 调，经限流队列排队执行 —— 排队的等待不计入单次超时
 */

/** 解析 `ps -Ao pid=,ppid=,pgid=,comm=` 的输出。comm 可能含空格（路径），取第四列起的剩余部分。 */
export function parseProcessTable(out) {
  const rows = [];
  for (const line of String(out || '').split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), comm: m[4] });
  }
  return rows;
}

/**
 * 某 pane 进程下要检查的进程：自身 + 直接子进程 + 同进程组成员。
 * 与原来的 `pgrep -P <pid>; pgrep -g <pid>` 语义一致（只到子进程一层，不递归）。
 */
export function paneProcesses(rows, panePid) {
  const pid = Number(panePid);
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if ((r.pid === pid || r.ppid === pid || r.pgid === pid) && !seen.has(r.pid)) {
      seen.add(r.pid);
      out.push(r);
    }
  }
  // pane 自身排第一，与原来 [panePid, ...descendants] 的顺序一致
  return out.sort((a, b) => (a.pid === pid ? -1 : b.pid === pid ? 1 : 0));
}

/**
 * 进程表快照：ttl 内复用；进行中的请求被并发调用方共享，不会因为 35 个会话同时要就跑 35 次 ps。
 * @param {() => Promise<string>} run  执行 ps 并返回 stdout
 */
export function createProcessSnapshot(run, ttlMs = 2000) {
  let cached = null;          // {at, rows}
  let inflight = null;
  return async function snapshot() {
    if (cached && Date.now() - cached.at < ttlMs) return cached.rows;
    if (!inflight) {
      inflight = run().then((out) => {
        cached = { at: Date.now(), rows: parseProcessTable(out) };
        return cached.rows;
      }).finally(() => { inflight = null; });
    }
    return inflight;
  };
}

/** 并发上限为 n 的执行队列。返回 limit(fn)：fn 在拿到名额后才开始执行（超时应从这里开始算）。 */
export function createLimiter(n = 1) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active -= 1; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

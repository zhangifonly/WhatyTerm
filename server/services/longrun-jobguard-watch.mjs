/**
 * 进程连坐的看门进程（由 LongRunJobGuard.adoptProcessGroup 起）。
 * 用法：node longrun-jobguard-watch.mjs <WebTmux 的 pid> <执行者进程组 id>
 *
 * 每秒看一眼：执行者整组已经退了 → 本发结束，自己退；WebTmux 没了 → 连坐整组。
 * 故意写得极小、零依赖：它要在 WebTmux 已经死掉的情况下独立工作。
 */
const [parentPid, pgid] = process.argv.slice(2).map(Number);
if (!parentPid || !pgid) process.exit(2);

/** EPERM 说明进程在（只是没权限发信号），也算活着 */
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

const timer = setInterval(() => {
  if (!alive(-pgid)) process.exit(0);
  if (alive(parentPid)) return;
  clearInterval(timer);
  try { process.kill(-pgid, 'SIGTERM'); } catch { /* 已退 */ }
  setTimeout(() => {
    try { process.kill(-pgid, 'SIGKILL'); } catch { /* 已退 */ }
    process.exit(0);
  }, 5000);
}, 1000);

/**
 * 孤儿进程清理的自保护：绝不能清理 WebTmux 服务自己所在的进程链。
 *
 * 事故（2026-10-01）：删除一个工作目录就是 WebTmux 项目本身的会话时，cleanupOrphanProcesses
 * 按「PPID=1 + 命令行含 node + cwd 在项目目录内」认孤儿——而 launchd 拉起的服务外壳
 * `/bin/zsh -lic '... node server/index.js'` 正好三条全中，连同服务 node、caffeinate、
 * 所有会话的 tmux attach 客户端一起被 SIGTERM，服务直接下线（launchd 未自动拉起）。
 *
 * 规则：服务进程自身、它的全部祖先、它的全部后代，一律不杀。
 */

/** pid 的祖先链（不含自己），按 ppid 往上走到 1 为止 */
export function ancestorsOf(pid, processMap) {
  const out = [];
  let cur = processMap.get(String(pid))?.ppid;
  let guard = 0;
  while (cur && cur !== '0' && cur !== '1' && guard++ < 100) {
    out.push(cur);
    cur = processMap.get(cur)?.ppid;
  }
  return out;
}

/** 全部后代 */
export function descendantsOf(pid, childrenMap) {
  const out = [];
  const stack = [...(childrenMap.get(String(pid)) || [])];
  while (stack.length) {
    const p = stack.pop();
    out.push(p);
    stack.push(...(childrenMap.get(p) || []));
  }
  return out;
}

/** 受保护的 pid 集合：服务自己 + 祖先 + 后代 */
export function protectedPids(selfPid, processMap, childrenMap) {
  const self = String(selfPid);
  return new Set([self, ...ancestorsOf(self, processMap), ...descendantsOf(self, childrenMap)]);
}

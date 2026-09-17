/**
 * 路径边界判断（纯函数）
 *
 * ⚠ 不能用 startsWith / includes 判"属于某目录"：`/…/ClaudeCode/Foo` 会命中 `/…/ClaudeCode/FooBar`。
 *   关会话时按目录清孤儿进程（cleanupOrphanProcesses）曾用前缀匹配，项目并列放在同一个根下后，
 *   关掉 Foo 会误杀 FooBar 里跑着的 dev server。
 */

const trimSlash = (p) => {
  const s = String(p || '');
  return s.length > 1 ? s.replace(/\/+$/, '') : s;
};

/** p 就是 dir，或在 dir 之内。 */
export function isPathWithin(p, dir) {
  const a = trimSlash(p), d = trimSlash(dir);
  if (!a || !d) return false;
  return a === d || a.startsWith(d === '/' ? '/' : `${d}/`);
}

/** 命令行参数里是否提到 dir（本身或其下的路径）。dir 后面必须是路径边界，不能紧跟别的字符。 */
export function argsMentionDir(args, dir) {
  const d = trimSlash(dir);
  if (!d) return false;
  const escaped = d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}(?=$|[\\s/"':;,=)\\]])`).test(String(args || ''));
}

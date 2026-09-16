#!/usr/bin/env node
/**
 * 假 claude CLI —— 按脚本吐 stream-json，用于离线验证 LongRunRunner 的进程编排。
 * 不联网、不花钱。行为由环境变量控制：
 *   FAKE_SCRIPT  JSON 数组，每项 {delay?, line?} 或 {delay?, raw?}
 *   FAKE_SILENT  设为秒数：吐完脚本后静默这么久再退（测 hang）
 *   FAKE_HANG    设为 1：吐完脚本后永不退出（测收尾卡死）
 *   FAKE_ECHO_STDIN 设为 1：把收到的 stdin 原样写到 stderr（验证提示词走 stdin）
 */
const script = JSON.parse(process.env.FAKE_SCRIPT || '[]');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.env.FAKE_ECHO_STDIN === '1') {
  let buf = '';
  process.stdin.on('data', (c) => {
    buf += c.toString();
    process.stderr.write(`STDIN_GOT:${buf.length}:${buf.replace(/\n/g, '\\n')}\n`);
  });
}

(async () => {
  for (const step of script) {
    if (step.delay) await sleep(step.delay * 1000);
    const out = step.raw !== undefined ? step.raw : JSON.stringify(step.line);
    // raw2: 不追加换行，用于测跨 chunk 的半行拼接
    process.stdout.write(step.raw2 ? out : out + '\n');
  }
  if (process.env.FAKE_HANG === '1') {
    // ⚠ new Promise(() => {}) 不能阻止 Node 退出 —— 没有活跃 handle 时事件循环就空了。
    //    必须挂一个真正的 handle（长 interval），否则进程立刻结束，看门狗测不到。
    setInterval(() => {}, 1 << 30);
    await new Promise(() => {});
  }
  if (process.env.FAKE_SILENT) {
    await sleep(Number(process.env.FAKE_SILENT) * 1000);
  }
})();

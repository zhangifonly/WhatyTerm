#!/usr/bin/env node
/**
 * 假 claude CLI —— 按脚本吐 stream-json，离线验证 LongRunRunner 的进程编排。不联网、不花钱。
 *   FAKE_SCRIPT          JSON 数组，每项 {delay?, line?} 或 {delay?, raw?, raw2?}（raw2 不追加换行）
 *   FAKE_HANG=1          吐完脚本后永不退出（测看门狗）
 *   FAKE_SILENT=<秒>     吐完脚本后静默这么久再退
 *   FAKE_WAIT_STDIN_EOF=1  吐完脚本后等 stdin 关闭才退（真 CLI 在流输入模式下的行为）
 *   FAKE_STDIN_FILE=<路径>  把收到的 stdin 原样追加进文件
 *   FAKE_ARGV_FILE=<路径>   把自己的命令行参数写进文件
 *   FAKE_CLOSE_STDIN=1   一启动就关掉自己的 stdin（让对端写入触发 EPIPE）
 */
import fs from 'fs';

const script = JSON.parse(process.env.FAKE_SCRIPT || '[]');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.FAKE_ARGV_FILE) fs.writeFileSync(process.env.FAKE_ARGV_FILE, JSON.stringify(process.argv.slice(2)));

let stdinEnded = false;
if (process.env.FAKE_CLOSE_STDIN === '1') {
  // ⚠ 必须真关 fd 0：process.stdin.destroy() 在子进程侧并不关管道，对端写入不会 EPIPE（实测）
  fs.closeSync(0);
  stdinEnded = true;
} else {
  process.stdin.on('data', (c) => {
    if (process.env.FAKE_STDIN_FILE) fs.appendFileSync(process.env.FAKE_STDIN_FILE, c);
  });
  process.stdin.on('end', () => { stdinEnded = true; });
}

(async () => {
  for (const step of script) {
    if (step.delay) await sleep(step.delay * 1000);
    const out = step.raw !== undefined ? step.raw : JSON.stringify(step.line);
    process.stdout.write(step.raw2 ? out : out + '\n');
  }
  if (process.env.FAKE_HANG === '1') {
    // ⚠ new Promise(() => {}) 不能阻止 Node 退出（没有活跃 handle 事件循环就空了）
    setInterval(() => {}, 1 << 30);
    await new Promise(() => {});
  }
  if (process.env.FAKE_SILENT) await sleep(Number(process.env.FAKE_SILENT) * 1000);
  if (process.env.FAKE_WAIT_STDIN_EOF === '1') {
    const t = setInterval(() => {}, 1 << 30);
    while (!stdinEnded) await sleep(20);
    clearInterval(t);
  }
  process.exit(0);
})();

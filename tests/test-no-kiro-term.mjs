/**
 * WebTmux 建的 tmux 会话不被 Kiro CLI 的终端外壳（kiro-cli-term）接管 —— 真 tmux、真 shell 启动。
 *   ① 会话环境里带着 Kiro 脚本认的开关 PROCESS_LAUNCHED_BY_Q（任何机器都验）
 *   ② 装了 Kiro 的机器上：窗口首进程是真正的 shell，不是「zsh (kiro-cli-term)」；对照组不带开关确实被接管
 *   ③ shell 照常可用：能执行命令、回显结果
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { newTmuxSession } from '../server/services/SessionManager.js';

let pass = 0, fail = 0;
const check = (n, c, d = '') => { if (c) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}\n    ${d}`); } };
const tmux = (...a) => execFileSync('tmux', a, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
// 查询类命令失败（如变量不存在时 show-environment 退出码非 0）返回空串，按「不通过」记，不能让异常跳过检查
const q = (...a) => { try { return tmux(...a); } catch { return ''; } };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const firstProc = (s) => execFileSync('ps', ['-o', 'comm=', '-p', tmux('display', '-p', '-t', s, '#{pane_pid}')], { encoding: 'utf-8' }).trim();
const kiroInstalled = fs.existsSync(path.join(os.homedir(), '.local/bin/kiro-cli'));

const on = `whatyterm-nokiro-${process.pid}`;
const off = `whatyterm-kirocontrol-${process.pid}`;
try {
  newTmuxSession('tmux', `-d -s "${on}" -x 80 -y 24`);
  if (kiroInstalled) tmux('new-session', '-d', '-s', off, '-x', '80', '-y', '24');
  sleep(4000);   // 等 .zshrc 跑完（Kiro 的前置脚本就在这一步决定接不接管）
  check('① 会话环境带着 PROCESS_LAUNCHED_BY_Q', q('show-environment', '-t', on, 'PROCESS_LAUNCHED_BY_Q') === 'PROCESS_LAUNCHED_BY_Q=1');
  if (kiroInstalled) {
    check('② 首进程是真正的 shell，不是 Kiro 外壳', !/kiro-cli-term/.test(firstProc(on)), firstProc(on));
    check('② 对照：不带开关时确实被接管（证明测的是真问题）', /kiro-cli-term/.test(firstProc(off)), firstProc(off));
  } else {
    console.log('（本机没装 Kiro，跳过 ② 进程链检查）');
  }
  tmux('send-keys', '-t', on, 'echo NOKIRO_$((40+2))', 'Enter');
  sleep(1000);
  check('③ shell 照常可用', tmux('capture-pane', '-p', '-t', on).includes('NOKIRO_42'));
} catch (e) {
  fail++; console.log(`❌ 测试过程出错：${e.message.split('\n')[0]}`);
} finally {
  for (const s of [on, off]) { try { tmux('kill-session', '-t', s); } catch { /* 没建成 */ } }
}
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);

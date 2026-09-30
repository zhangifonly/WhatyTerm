/**
 * 拖动选字 E2E：真 tmux server + 真 tmux 客户端（node-pty，等同浏览器里 xterm 连上的那个客户端）。
 *
 * 场景：会话里的应用开了鼠标上报（像 Codex），客户端发来 SGR 鼠标「按下→拖动→松开」
 *   - whatyterm-* 会话：tmux 进 copy-mode 做选择，应用收不到拖拽 → 像普通终端一样能选字
 *   - 用户自己的会话：保持 tmux 默认，拖拽照旧转发给应用（不能改坏用户自己的 tmux）
 * 产物：失败时打印应用收到的原始字节，便于复查。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import pty from 'node-pty';
import { DRAG_BIND_ARGS } from '../server/services/SessionManager.js';

let pass = 0, fail = 0;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tmux = (...a) => execFileSync('tmux', a, { encoding: 'utf-8' }).trim();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dragsel-'));

async function scenario(name) {
  const log = path.join(dir, `${name}.log`);
  // 应用：开 1002（按键+拖动上报）与 1006（SGR），把收到的输入原样记下来
  const app = `printf '\\033[?1002h\\033[?1006h'; stty raw -echo; exec cat > '${log}'`;
  tmux('new-session', '-d', '-s', name, '-x', '80', '-y', '24', app);
  tmux('set-option', '-t', name, 'mouse', 'on');
  await wait(500);
  const client = pty.spawn('tmux', ['attach', '-t', name], { name: 'xterm-256color', cols: 80, rows: 24, env: process.env });
  await wait(800);
  client.write('\x1b[<0;10;5M');                       // 按下
  for (let x = 11; x <= 30; x += 5) { client.write(`\x1b[<32;${x};5M`); await wait(60); }   // 拖动
  await wait(300);
  const inMode = tmux('display', '-p', '-t', name, '#{pane_in_mode}') === '1';
  client.write('\x1b[<0;30;5m');                       // 松开
  await wait(400);
  const got = fs.existsSync(log) ? fs.readFileSync(log, 'latin1') : '';
  client.kill();
  tmux('kill-session', '-t', name);
  return { inMode, appGotDrag: /\x1b\[<32;/.test(got), raw: JSON.stringify(got) };
}

function check(name, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${name}`); } else { fail++; console.log(`❌ ${name}\n    ${detail}`); }
}

try {
  execFileSync('tmux', DRAG_BIND_ARGS);
  const w = await scenario(`whatyterm-dragtest-${process.pid}`);
  check('WhatyTerm 会话：应用开着鼠标上报，拖动仍进 tmux 选择模式', w.inMode, JSON.stringify(w));
  check('WhatyTerm 会话：拖拽不转发给应用', !w.appGotDrag, `应用收到：${w.raw}`);
  const o = await scenario(`userown-dragtest-${process.pid}`);
  check('用户自己的会话：保持 tmux 默认，拖拽照旧交给应用', o.appGotDrag && !o.inMode, JSON.stringify(o));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);

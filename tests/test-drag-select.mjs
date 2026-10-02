/**
 * 选字/复制 E2E：真 tmux server + 真 tmux 客户端（node-pty，等同浏览器 xterm 连上的那个客户端）。
 * 会话里的应用开着鼠标上报（像 Codex / Claude Code），对照普通终端逐项验：
 *   ① 拖动 → 进选择模式、应用收不到拖拽、松手经 OSC 52 发出复制内容
 *   ② 松手后高亮保留、仍在选择模式（看得见选了什么，不跳走）
 *   ③ 选完直接打字 → 先退出选择模式，按键原样进应用（Session.userInput）
 *   ④ 双击选词 → 复制的是那个词（应用开着鼠标也不转发）
 *   ⑤ 选择模式里单击 → 清掉高亮并退出（人在底部时）
 *   ⑥ 用户自己的 tmux 会话 → 与 tmux 默认一致，拖拽照旧交给应用
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import pty from 'node-pty';
import { installSelectionBindings } from '../server/services/tmuxSelection.js';
import { Session } from '../server/services/SessionManager.js';

let pass = 0, fail = 0;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tmux = (...a) => execFileSync('tmux', a, { encoding: 'utf-8' }).trim();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dragsel-'));
const check = (name, cond, detail) => { if (cond) { pass++; console.log(`✅ ${name}`); } else { fail++; console.log(`❌ ${name}\n    ${detail}`); } };

async function open(name) {
  const log = path.join(dir, `${name}.log`);
  // 应用：开 1002（按键+拖动）与 1006（SGR），打印一行字，之后把收到的输入原样记下来
  const app = `printf '\\033[?1002h\\033[?1006h'; printf 'alpha beta gamma\\n'; stty raw -echo; exec cat > '${log}'`;
  tmux('new-session', '-d', '-s', name, '-x', '80', '-y', '24', app);
  tmux('set-option', '-t', name, 'mouse', 'on');
  await wait(500);
  const c = pty.spawn('tmux', ['attach', '-t', name], { name: 'xterm-256color', cols: 80, rows: 24, env: process.env });
  let out = '';
  c.onData((d) => { out += d; });
  await wait(800);
  return {
    c, name,
    take: () => { const o = out; out = ''; return o; },
    appGot: () => (fs.existsSync(log) ? fs.readFileSync(log, 'latin1') : ''),
    q: (fmt) => tmux('display', '-p', '-t', name, fmt),
    close: () => { c.kill(); tmux('kill-session', '-t', name); }
  };
}
const osc52 = (out) => { const m = out.match(/\x1b\]52;[a-z]*;([A-Za-z0-9+/=]*)/); return m ? Buffer.from(m[1], 'base64').toString() : null; };
async function drag(t, x1, x2) {
  t.c.write(`\x1b[<0;${x1};1M`);
  for (let x = x1 + 1; x <= x2; x += 2) { t.c.write(`\x1b[<32;${x};1M`); await wait(40); }
  t.c.write(`\x1b[<0;${x2};1m`);
  await wait(600);
}

try {
  installSelectionBindings(['tmux'], execFileSync);
  const w = await open(`whatyterm-seltest-${process.pid}`);
  w.take();
  await drag(w, 1, 10);
  const copied = osc52(w.take());
  check('① 拖动：松手经 OSC 52 发出复制内容', copied && copied.startsWith('alpha'), `复制到 ${JSON.stringify(copied)}`);
  check('① 拖动：应用收不到拖拽', !/\x1b\[<32;/.test(w.appGot()), JSON.stringify(w.appGot()));
  check('② 松手后仍在选择模式且高亮保留', w.q('#{pane_in_mode}#{selection_present}') === '11', w.q('in_mode=#{pane_in_mode} sel=#{selection_present}'));

  // ③ 走服务端真实的输入入口：鼠标上报 → 记下；随后的按键 → 先退出选择模式再写
  const s = Object.assign(Object.create(Session.prototype), { tmuxSessionName: w.name, write: (d) => w.c.write(d) });
  s.userInput('\x1b[<0;30;5M'); s.userInput('\x1b[<0;30;5m');   // 选完又点了一下（模拟真实顺序里的鼠标活动）
  await wait(300);
  if (w.q('#{pane_in_mode}') !== '1') { await drag(w, 1, 10); s._mouseSinceKey = true; }   // 若单击已退出，重新选一次
  s.userInput('x');
  await wait(400);
  check('③ 选完直接打字：退出选择模式', w.q('#{pane_in_mode}') === '0', w.q('in_mode=#{pane_in_mode}'));
  check('③ 选完直接打字：按键进了应用', w.appGot().endsWith('x'), JSON.stringify(w.appGot().slice(-20)));

  w.take();
  w.c.write('\x1b[<0;9;1M\x1b[<0;9;1m'); await wait(60); w.c.write('\x1b[<0;9;1M\x1b[<0;9;1m');   // 双击「beta」
  await wait(900);
  check('④ 双击选词：复制的是那个词', osc52(w.take()) === 'beta', `in_mode=${w.q('#{pane_in_mode}')}`);

  if (w.q('#{pane_in_mode}') !== '1') await drag(w, 1, 10);
  await wait(400);   // 避开双击判定窗口
  w.c.write('\x1b[<0;40;8M\x1b[<0;40;8m');
  await wait(500);
  check('⑤ 选择模式里单击：清掉高亮并退出', w.q('#{pane_in_mode}') === '0', w.q('in_mode=#{pane_in_mode} sel=#{selection_present}'));

  // ⑦ 选完按 Esc：只收起高亮，Esc 不传给应用（Claude Code / Codex 里 Esc 会中断正在跑的任务）
  await drag(w, 1, 10);
  const before = w.appGot().length;
  s._mouseSinceKey = true;
  s.userInput('\x1b');
  await wait(400);
  check('⑦ 选完按 Esc：退出选择模式', w.q('#{pane_in_mode}') === '0', w.q('in_mode=#{pane_in_mode}'));
  check('⑦ 选完按 Esc：Esc 没传给应用（不会中断 CLI）', !w.appGot().slice(before).includes('\x1b'), JSON.stringify(w.appGot().slice(before)));
  w.close();

  const o = await open(`userown-seltest-${process.pid}`);
  await drag(o, 1, 10);
  check('⑥ 用户自己的会话：保持 tmux 默认，拖拽交给应用', /\x1b\[<32;/.test(o.appGot()) && o.q('#{pane_in_mode}') === '0', JSON.stringify(o.appGot().slice(0, 40)));
  o.close();
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);

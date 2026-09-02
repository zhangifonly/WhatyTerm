/**
 * 回归（v1.2.87）：程序化输入必须直达 tmux server（send-keys），不依赖 attach 客户端。
 *
 * 故障：session.write 走长驻 `tmux attach` 的 node-pty，客户端半死时写入静默丢失。
 * 实测 session-1788… 输入框里的「继续，开工 P6」用 write('\r') 连发 4 次全部
 * no_effect（台账），改 `tmux send-keys Enter` 一发即中——CLI 卡等一个回车 10 小时。
 */
import fs from 'fs';
import { execFileSync, execSync } from 'child_process';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};
const ok = (c, msg) => { if (!c) throw new Error(msg || '断言失败'); };

const sm = fs.readFileSync('server/services/SessionManager.js', 'utf-8');
const idx = fs.readFileSync('server/index.js', 'utf-8');
const ralph = fs.readFileSync('server/services/RalphEngine.js', 'utf-8');

console.log('接线锁定（源码断言）');

t('SessionManager 提供 sendInput/sendNamedKey 且走 send-keys -l', () => {
  ok(/sendInput\(text, opts = \{\}\)/.test(sm));
  ok(/'send-keys', '-t', this\.tmuxSessionName, '-l', '--'/.test(sm), '文本必须 -l 字面量发送');
  ok(/sendNamedKey\(key\)/.test(sm));
});

t('监控执行器不再用 pty.write 发按键/文本', () => {
  ok(!idx.includes('session.write(keyMap[action])'), '这一条锁住故障：keyMap 按键不得再走 write');
  ok(/session\.sendNamedKey\(action\)/.test(idx), '应改走 sendNamedKey');
  ok(/session\.sendInput\(action, \{ submit: true \}\)/.test(idx), '文本应走 sendInput submit（保留分两次发的约定）');
});

t('Ralph 命令写入与中断走 send-keys（mock 会话可回退 write）', () => {
  ok(!/session\.write\(shellCmd \+ '\\r'\);\n(?!      else)/.test(ralph.replace(/else session\.write/g, 'ELSEWRITE')), '主路径不得是裸 write');
  ok(/sendInput\(shellCmd, \{ submit: true \}\)/.test(ralph));
  ok(/sendNamedKey\('C-c'\)/.test(ralph), '中断走 C-c 命名键');
});

console.log('\n实弹：send-keys 直达真实 tmux 会话（无 attach 客户端）');

t('无客户端挂载时按键仍送达（write 的故障场景）', () => {
  const name = `wt-sendtest-${process.pid}`;
  const log = `/tmp/${name}.log`;
  try {
    execFileSync('tmux', ['new-session', '-d', '-s', name,
      `while IFS= read -r l; do printf '%s\\n' "$l" >> ${log}; done`]);
    // 复现 sendInput 的调用形态：-l 字面文本，再补 Enter
    execFileSync('tmux', ['send-keys', '-t', name, '-l', '--', '继续，开工 P6']);
    execFileSync('tmux', ['send-keys', '-t', name, 'Enter']);
    execSync('sleep 0.5');
    const got = fs.readFileSync(log, 'utf-8');
    ok(got.includes('继续，开工 P6'), `中文字面量必须完整送达，实际: ${JSON.stringify(got)}`);
  } finally {
    try { execFileSync('tmux', ['kill-session', '-t', name]); } catch {}
    try { fs.unlinkSync(log); } catch {}
  }
});

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);

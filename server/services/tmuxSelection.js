/**
 * 终端选字/复制，对齐普通终端（iTerm2 / Terminal.app）的手感（v1.4.77）。
 *
 * tmux 默认行为与普通终端的差距（会话里的 CLI 都开着鼠标上报，mouse_any_flag=1）：
 *   - 拖动 / 双击选词 / 三击选行：一律转发给 CLI，选不了字
 *   - 选完松手：copy-pipe-and-cancel 立刻退出选择模式，高亮当场消失，看不到选了什么；
 *     在历史里往上翻着选，松手就跳回最底部
 * 改成：
 *   - 拖动、双击、三击：总进 tmux 选择模式；松手复制但**保留高亮、停在原处**（copy-pipe-no-clear）
 *   - 在选择模式里单击：清掉高亮；人在最底部时顺带退出选择模式（回到正常交互）
 *   - 选完直接打字：由前端在下一次按键前请求退出选择模式（见 index.js terminal:input 的 exitCopyMode），
 *     按键照常进 CLI —— tmux 的选择模式会吃掉按键，这一步不做，「保留高亮」就是在制造新的坑
 *
 * ⚠ 键绑定是整个 tmux server 全局的，WhatyTerm 与用户自己的 tmux 共用默认 socket。
 *   所以每条都按会话名分支：whatyterm-* 走上面的新行为，其余会话与 tmux 3.6 默认逐字一致。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

export const WT = '#{m:whatyterm-*,#{session_name}}';
// 拖动/双击/三击转发给 CLI 的条件：已在选择模式里（交给 copy-mode 表处理），或「非 WhatyTerm 会话且应用开了鼠标」
export const SEND_TO_APP = `#{||:#{pane_in_mode},#{&&:#{mouse_any_flag},#{!:${WT}}}}`;

const pick = (kind) => `send-keys -X select-${kind} ; run-shell -d 0.3`;

/** tmux 配置文本（source-file 读取；嵌套花括号只有配置文件语法能干净表达） */
export function buildSelectionConf() {
  return `# WhatyTerm 选字/复制绑定（由服务端生成，见 server/services/tmuxSelection.js）
bind-key -T root MouseDrag1Pane if-shell -F "${SEND_TO_APP}" { send-keys -M } { copy-mode -M }
bind-key -T root DoubleClick1Pane select-pane -t = \\; if-shell -F "${SEND_TO_APP}" { send-keys -M } { if-shell -F "${WT}" { copy-mode -H ; ${pick('word')} ; send-keys -X copy-pipe-no-clear } { copy-mode -H ; ${pick('word')} ; send-keys -X copy-pipe-and-cancel } }
bind-key -T root TripleClick1Pane select-pane -t = \\; if-shell -F "${SEND_TO_APP}" { send-keys -M } { if-shell -F "${WT}" { copy-mode -H ; ${pick('line')} ; send-keys -X copy-pipe-no-clear } { copy-mode -H ; ${pick('line')} ; send-keys -X copy-pipe-and-cancel } }
bind-key -T copy-mode MouseDragEnd1Pane if-shell -F "${WT}" { send-keys -X copy-pipe-no-clear } { send-keys -X copy-pipe-and-cancel }
bind-key -T copy-mode DoubleClick1Pane select-pane \\; send-keys -X select-word \\; run-shell -d 0.3 \\; if-shell -F "${WT}" { send-keys -X copy-pipe-no-clear } { send-keys -X copy-pipe-and-cancel }
bind-key -T copy-mode TripleClick1Pane select-pane \\; send-keys -X select-line \\; run-shell -d 0.3 \\; if-shell -F "${WT}" { send-keys -X copy-pipe-no-clear } { send-keys -X copy-pipe-and-cancel }
bind-key -T copy-mode MouseDown1Pane select-pane \\; if-shell -F "${WT}" { send-keys -X clear-selection ; if-shell -F "#{==:#{scroll_position},0}" { send-keys -X cancel } }
`;
}

/** 把绑定装进 tmux server。argv 是 tmux 可执行文件（WSL 下是 ['wsl','tmux']） */
export function installSelectionBindings(argv, execFileSync) {
  const f = path.join(os.tmpdir(), `whatyterm-selection-${process.pid}.conf`);
  fs.writeFileSync(f, buildSelectionConf());
  try {
    execFileSync(argv[0], [...argv.slice(1), 'source-file', f], { stdio: 'pipe', timeout: 5000 });
  } finally {
    fs.rmSync(f, { force: true });
  }
}

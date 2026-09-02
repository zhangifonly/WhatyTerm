/**
 * 活确认菜单探针：判断屏幕上是否存在「正在等待选择」的确认菜单，
 * 而不是对话正文里的问句+编号列表，或已答完消失后残留的关键词。
 *
 * 依据（tests/fixtures/screens/confirm-proceed-eca0a648.txt 实测）：
 * 活菜单必然同时具备、且都贴在屏幕底部：
 *   ① 指针行：❯ 紧跟编号选项（Ink SelectInput 的高亮行）
 *   ② 底部快捷键提示：Esc to cancel / Tab to amend / Enter to confirm 等
 * 对话框被回答后整个消失，不会残留 ❯ 指针行；正文极少有行首 ❯ + 编号。
 *
 * 背景（v1.2.81）：此前确认界面检测只做关键词匹配（最后 5000 字符里找
 * "Do you want to…/1. Yes"），台账实测 1142 次自动选择里 1138 次落账时
 * 屏上根本没有菜单——按键落在空输入框/运行中的 CLI 上，空转率 99.5%~100%
 * （node scripts/monitor-effectiveness.mjs 的「Claude Code确认界面」与
 * 「检测到确认界面，自动选择选项 1」两行）。
 *
 * ⚠️ 只用于收紧 Claude 侧判定。Codex 确认界面同期实测 84.3% 有效，
 * 其判定路径不要套用本探针。
 *
 * @param {string} cleanContent 已剥 ANSI 的屏幕文本
 * @param {number} tailLen 只看尾部多少字符（对话框永远贴底渲染）
 */
export function isLiveConfirmMenu(cleanContent, tailLen = 1200) {
  const tail = (cleanContent || '').slice(-tailLen);
  // 指针只认 ❯：'>' 是转录里引用行/输入框的前缀，会把历史消息误认成菜单。
  // 行首允许出现对话框边框 │（旧版 Claude Code 把菜单画在圆角框里：│ ❯ 1. Yes）
  const hasPointer = /^[\s│|]*❯\s*\d+\.\s+\S/m.test(tail);
  const hasFooterHint = /Esc to \w+|Enter to confirm|Tab to amend/i.test(tail);
  return hasPointer && hasFooterHint;
}

/**
 * 近距确认菜单判别器（v1.2.89）：问句与首个编号选项相距 ≤400 字符。
 * 台账实测（Codex确认界面族）：2780 条有效样本全命中，470/473 空转样本不命中
 * ——scrollback 里答完的旧菜单，问句与残留文本拉开距离后即不再命中。
 * 与 ActionOutcome 落账的 hadConfirmMenu 用同一正则（它就是数据来源），
 * 修改必须两处同步——所以只在这里定义一份。
 */
export const CONFIRM_MENU_NEAR = /(Do you want to|Would you like to)[\s\S]{0,400}?[❯>]?\s*1\.\s+\S/i;
export function hasNearbyConfirmMenu(content) {
  return CONFIRM_MENU_NEAR.test(content || '');
}

/**
 * Codex 活确认菜单判据（v1.2.90）：结构铁证，不靠脆弱的问句-选项距离。
 * 背景：v1.2.89 用「问句与选项相距 ≤400 字符」给 Codex 设闸，但 Codex 确认界面
 * 结构是「问句 + Environment + Reason + $ 完整命令回显 + 选项」，命令一长（超长
 * 路径 + 一串函数名）距离就破 400——实测某 decompile 命令 430 字符，真菜单被误杀。
 * 活菜单铁证：尾部同时有底部确认提示行（Press enter to confirm / esc to cancel）
 * 与编号选项行（› / ❯ / > 指针，Codex 用 ›=U+203A）。答完后提示行被新输出推走、
 * 不再在尾部，故能区分 scrollback 里的旧菜单。
 */
export function isCodexLiveConfirm(content) {
  const trimmed = (content || '').replace(/\s+$/, '');
  // footer 必须紧贴屏幕底部：活菜单时它是最后一行；答完后新输出把它推离底部。
  // 仅「在尾部 700 字符内」不够——旧菜单后若新输出少，footer 仍在窗口里会误判活。
  const hasFooter = /Press enter to confirm|Esc to cancel/i.test(trimmed.slice(-150));
  const hasOption = /^[\s│>›❯]*1\.\s+\S/m.test(trimmed.slice(-700));
  return hasFooter && hasOption;
}

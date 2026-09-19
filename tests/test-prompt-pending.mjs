/**
 * 输入框未提交内容 —— 回归测试
 *
 * 背景：CLI 干完活闲下来，但输入框里留着一段没提交的文本：
 *
 *     ✳ Cooked for 6m 8s
 *     ❯ 继续 format 组
 *       ▶▶ auto mode on (shift+tab to cycle) · ← 5 agents
 *
 * 所有"空闲"判据都要求提示符行**是空的**（/^[❯>]\s*$/），于是全部落空，
 * 状态被判成「终端状态不明确」，监控就此停摆 —— 而 CLI 其实正闲着等一个回车。
 * 最常见的成因是上一次自动操作的回车没落地（Claude Code 用 Ink 的 TextInput，
 * 文本与回车必须分两次发）。
 *
 * 两个关键判据：
 *   1. 有未提交内容时该发**回车**，不是再发一次「继续」——
 *      那会把输入框拼成「继续 format 组继续」
 *   2. 只提交**我们自己**打进去的。用户可能正打到一半在思考，
 *      替他按回车会把半截话发出去，比不操作更糟（用户输入暂停只挡 5 秒）
 *
 * 运行：node tests/test-prompt-pending.mjs
 */

const results = { passed: 0, failed: 0, errors: [] };

function test(name, fn) {
  try {
    fn();
    results.passed++;
    console.log(`✅ ${name}`);
  } catch (err) {
    results.failed++;
    results.errors.push({ name, error: err.message });
    console.log(`❌ ${name}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || '不相等'}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}

const { promptPendingText, isEmptyPrompt, hasUnsentInput, isOwnPendingInput } =
  await import('../server/services/promptState.js');
const { AIEngine } = await import('../server/services/AIEngine.js');
const { default: DefaultPlugin } = await import('../server/services/MonitorPlugins/plugins/DefaultPlugin.js');

const engine = new AIEngine();
const plugin = new DefaultPlugin();

/** 复刻截图版式：完成标记 + 更新失败提示 + 提示符行 + 状态栏 + tmux 补空行 */
function screenWith(promptLine) {
  return [
    '  sw/inc 还剩 doc、format、fmtcol 三组。要继续的话，format 组风险最低。',
    '',
    '✳ Cooked for 6m 8s',
    '',
    '                              ✗ Auto-update failed · Run claude doctor',
    '──────────────────────────────────────────────────────',
    promptLine,
    '──────────────────────────────────────────────────────',
    '  ▶▶ auto mode on (shift+tab to cycle) · ← 5 agents',
    '', '', ''
  ].join('\n');
}

// ============ 1. 提示符解析 ============

test('取出提示符行上未提交的文本', () => {
  eq(promptPendingText(screenWith('❯ 继续 format 组')), '继续 format 组');
});

test('空提示符返回空串，而不是 null（要能和"没有提示符"区分开）', () => {
  eq(promptPendingText(screenWith('❯ ')), '');
  eq(isEmptyPrompt(screenWith('❯ ')), true);
  eq(hasUnsentInput(screenWith('❯ ')), false);
});

test('压根没有提示符时返回 null', () => {
  eq(promptPendingText('Sautéing… (2m 13s · esc to interrupt)\n  正在处理'), null);
});

test('分隔线与框线不会被当成提示符行', () => {
  eq(promptPendingText(screenWith('❯ 继续')), '继续', '分隔线干扰了提示符定位');
});

test('旧式 > 提示符同样识别', () => {
  eq(promptPendingText(screenWith('> 继续 format 组')), '继续 format 组');
});

// ============ 2. 只提交自己打进去的 ============

test('没有发送记录时只认完全等于自动指令的；以「继续」开头的用户草稿不算（2026-09-18 实测误提交）', () => {
  eq(isOwnPendingInput('继续', ['继续']), true);
  eq(isOwnPendingInput(' 继续 ', ['继续']), true, '首尾空白不影响');
  eq(isOwnPendingInput('继续 format 组', ['继续']), false, '宁可漏判成用户的，也不替用户提交');
  eq(isOwnPendingInput('继续做上级端的写能力', ['继续']), false, '真实样本：用户在回答 CLI 的提问');
});

test('有发送记录：相等算；屏上截到所发长文本的前一截（≥10 字）算；用户在我们发过的话后面接着打不算', () => {
  eq(isOwnPendingInput('继续做上级端的写能力', ['继续'], '继续'), false, '发过「继续」≠ 用户接着敲的话是我们的');
  const long = '请先把上级端的组织管理与应用下发两块写能力做完，再补对应的接口测试';
  eq(isOwnPendingInput(long, ['继续'], long), true);
  eq(isOwnPendingInput(long.slice(0, 20), ['继续'], long), true, '折行只截到前一截');
  eq(isOwnPendingInput('请先', ['继续'], long), false, '太短的前缀更像用户正在打字');
});

test('用户自己敲的不算 —— 哪怕里面含「继续」二字', () => {
  eq(isOwnPendingInput('帮我看看这个 bug', ['继续']), false);
  eq(isOwnPendingInput('别继续了先停', ['继续']), false, '仅含关键词不等于是我们打的');
});

test('未配置 autoActions 时回落到「继续」', () => {
  eq(isOwnPendingInput('继续', []), true);
  eq(isOwnPendingInput('继续', undefined), true);
});

// ============ 3. 端到端 ============

// 截图场景里「继续 format 组」是监控 AI 替用户回答 CLI 的话（CLI 刚问"要继续的话，format 组风险最低"），
// 有发送记录才认得出是自己的；2026-09-18 起没有发送记录时不再按「继续」前缀认（会误提交用户草稿）
const SENT = { lastSentText: '继续 format 组' };

test('截图场景：卡住的「继续」→ 发回车提交，不再判「状态不明确」', () => {
  const r = engine.preAnalyzeStatus(screenWith('❯ 继续 format 组'), 'claude', null, SENT);
  eq(r?.actionType, 'key', `应发按键，实际 ${r?.actionType}`);
  eq(r?.suggestedAction, 'Enter');
  assert(r?.needsAction, '应提示需要操作');
});

test('绝不在已有内容后再追加「继续」', () => {
  const r = engine.preAnalyzeStatus(screenWith('❯ 继续 format 组'), 'claude', null, SENT);
  assert(!/继续/.test(String(r?.suggestedAction || '')),
    `发了文本会拼成「继续 format 组继续」：${r?.suggestedAction}`);
});

test('用户未提交的内容：不操作，且说明原因', () => {
  const r = engine.preAnalyzeStatus(screenWith('❯ 帮我看看这个 bug 是不是'), 'claude');
  eq(r?.needsAction, false, '不能替用户提交半截话');
  eq(r?.suggestedAction, null);
  assert(/未提交/.test(r?.actionReason || ''), '未说明原因');
});

test('空提示符仍走原来的发「继续」逻辑', () => {
  const r = engine.preAnalyzeStatus(screenWith('❯ '), 'claude');
  eq(r?.actionType, 'text_input');
  eq(r?.suggestedAction, '继续');
});

test('通用策略插件：同一屏不再判「状态不明确」', () => {
  const s = screenWith('❯ 继续 format 组');
  const phase = plugin.detectPhase(s, {});
  eq(phase, 'waiting', `阶段应为 waiting，实际 ${phase}`);
  eq(plugin.analyzeStatus(s, phase, SENT)?.suggestedAction, 'Enter');
  eq(plugin.analyzeStatus(s, phase, {})?.needsAction, false, '没有发送记录时认不出是自己的，就不替用户按回车');
});

test('真实误提交样本：以「继续」开头的用户草稿，两条路径都不按回车', () => {
  const s = screenWith('❯ 继续做上级端的写能力');
  eq(engine.preAnalyzeStatus(s, 'claude', null, { lastSentText: '继续' })?.needsAction, false, 'AIEngine 路径');
  eq(plugin.analyzeStatus(s, plugin.detectPhase(s, {}), { lastSentText: '继续' })?.needsAction, false, '插件路径');
});

test('通用策略插件：用户内容同样不碰', () => {
  const s = screenWith('❯ 帮我看看这个 bug 是不是');
  const r = plugin.analyzeStatus(s, plugin.detectPhase(s, {}), {});
  eq(r?.needsAction, false);
});

test('运行中不受影响（不能因为屏上有提示符就抢着按回车）', () => {
  const s = 'Sautéing… (2m 13s · esc to interrupt)\n❯ 继续';
  const r = engine.preAnalyzeStatus(s, 'claude');
  assert(r?.suggestedAction !== 'Enter', `运行中被按了回车：${r?.currentState}`);
});

// ============ 4. 靠"实际发出去的文本"认自己（启发式认不出的那类）============
//
// 监控 AI 回答 CLI 提问时会生成任意内容（真实样本：
// 「检查 Clash 里 whaty.org 的分流规则」），光看内容根本认不出是自己打的。
// 所以要跟 lastActionMap 里我们真正发出去的文本比对 —— 那是事实，不是猜测。

test('AI 生成的答复：给了 lastSentText 就能认出是自己的', () => {
  const answer = '检查 Clash 里 whaty.org 的分流规则';
  eq(isOwnPendingInput(answer, ['继续']), false, '光靠启发式本就认不出');
  eq(isOwnPendingInput(answer, ['继续'], answer), true, 'lastSentText 应能认出');
});

test('lastSentText 只匹配前缀，不会把用户另起的话认成自己的', () => {
  eq(isOwnPendingInput('完全不相干的一句话', ['继续'], '检查 Clash 的分流规则'), false);
});

test('端到端：带上 lastSentText 后，AI 答复卡住 → 回车提交', () => {
  const answer = '检查 Clash 里 whaty.org 的分流规则';
  const screen = screenWith('❯ ' + answer);
  eq(engine.preAnalyzeStatus(screen, 'claude')?.needsAction, false, '不给 lastSentText 时应保守不动');
  const r = engine.preAnalyzeStatus(screen, 'claude', null, { lastSentText: answer });
  eq(r?.suggestedAction, 'Enter', '给了 lastSentText 应回车提交');
});

test('lastSentText 对不上时仍然不动（用户后来自己改写了输入）', () => {
  const screen = screenWith('❯ 算了我自己来查');
  const r = engine.preAnalyzeStatus(screen, 'claude', null, { lastSentText: '检查 Clash 的分流规则' });
  eq(r?.needsAction, false);
});

// ============ 4. 输入框里的灰色建议（2026-09-18 Hitech 会话实测停摆） ============
// CLI 干完活会在空输入框里用暗淡样式（SGR 2）预填一句下一步建议，按 Tab/→ 才采纳。
// 剥掉颜色码后与真打进去的字一模一样，于是被当成用户草稿，监控停手不动。
// 下面这行是当时 capture-pane -e 抓到的原始字节。
const GHOST = '\x1b[39m❯ \x1b[2m继续做家长端\x1b[0m';
const { stripPromptSuggestion } = await import('../server/services/promptState.js');
const plainOf = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');

test('真实样本：灰色建议被去掉，输入框按空处理', () => {
  eq(promptPendingText(plainOf(screenWith(GHOST))), '继续做家长端', '对照：不处理时确实会被读成草稿');
  eq(promptPendingText(plainOf(stripPromptSuggestion(screenWith(GHOST)))), '');
});

test('真实样本端到端：不再停手，照常发「继续」', () => {
  const r = engine.preAnalyzeStatus(screenWith(GHOST), 'claude');
  eq(r?.actionType, 'text_input', `应发文本，实际 ${r?.actionType}（${r?.actionReason || ''}）`);
  eq(r?.suggestedAction, '继续');
});

test('真正打进去的字（正常亮度）仍当作用户草稿，不碰', () => {
  const r = engine.preAnalyzeStatus(screenWith('\x1b[39m❯ 继续做家长端\x1b[0m'), 'claude');
  eq(r?.needsAction, false, '不能替用户提交');
});

test('新会话欢迎屏的占位提示 Try "…" 保留（无对话历史，不该自动发「继续」，交给 AI）', () => {
  const s = screenWith('\x1b[39m❯\xa0\x1b[2mTry\x1b[0m \x1b[2m"fix\x1b[0m \x1b[2mlint"\x1b[0m');
  eq(stripPromptSuggestion(s), s);
});

test('逐词分段着色的建议（真实样本 whatyterm-b7d80d07）同样去掉', () => {
  const line = '\x1b[39m❯\xa0\x1b[2m检查\x1b[0m \x1b[2mClash\x1b[0m \x1b[2m里\x1b[0m \x1b[2mwhaty.org\x1b[0m \x1b[2m的分流规则\x1b[0m';
  eq(promptPendingText(plainOf(stripPromptSuggestion(screenWith(line)))), '');
});

test('只动末尾输入框：历史里暗淡的 > 引用行原样保留', () => {
  const screen = '\x1b[2m> 之前问过的一句话\x1b[0m\n  回复正文\n' + screenWith(GHOST);
  assert(stripPromptSuggestion(screen).includes('之前问过的一句话'), '历史行被误删');
});

test('256 色里的 2（38;5;2 绿色）不是暗淡，文字保留', () => {
  eq(plainOf(stripPromptSuggestion('\x1b[38;5;2m❯ 绿色的字\x1b[0m')), '❯ 绿色的字');
});

test('行尾 \\r 保留；无颜色码的输入原样返回', () => {
  eq(stripPromptSuggestion('❯ \x1b[2m建议\x1b[0m\r\n'), '❯ \x1b[2m\x1b[0m\r\n');
  eq(stripPromptSuggestion('❯ 普通文本'), '❯ 普通文本');
  eq(stripPromptSuggestion(''), '');
});

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exit(results.failed ? 1 : 0);

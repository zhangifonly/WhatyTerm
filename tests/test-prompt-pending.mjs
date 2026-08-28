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

test('以自动指令开头的算我们自己的', () => {
  eq(isOwnPendingInput('继续', ['继续']), true);
  eq(isOwnPendingInput('继续 format 组', ['继续']), true);
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

test('截图场景：卡住的「继续」→ 发回车提交，不再判「状态不明确」', () => {
  const r = engine.preAnalyzeStatus(screenWith('❯ 继续 format 组'), 'claude');
  eq(r?.actionType, 'key', `应发按键，实际 ${r?.actionType}`);
  eq(r?.suggestedAction, 'Enter');
  assert(r?.needsAction, '应提示需要操作');
});

test('绝不在已有内容后再追加「继续」', () => {
  const r = engine.preAnalyzeStatus(screenWith('❯ 继续 format 组'), 'claude');
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
  const r = plugin.analyzeStatus(s, phase, {});
  eq(r?.suggestedAction, 'Enter');
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

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exit(results.failed ? 1 : 0);

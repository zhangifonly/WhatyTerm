/**
 * 确认框与选项面板判定 —— 回归测试
 *
 * 曾经在确认分支上加过一层「解析框里的命令、命中危险模式就停手」的安全闸，
 * 但实测误伤过多（rm -f 单文件、AI 清理自己的临时脚本、脚本收尾的
 * `kill $HP; rm -rf "$OUT"`），反复打断自动流程，已按要求整体移除。
 *
 * 本测试锁住：
 *   1. 确认框一律正常自动应答，且源码里不再有破坏性检测残留
 *   2. CLI 提问时不能用机械的「继续」搪塞
 *   3. 选项面板按结构识别（不靠标题白名单），并按能否安全脱身分档处理
 *
 * 运行：node tests/test-confirm-guard.mjs
 */

import fs from 'fs';
import path from 'path';

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

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || '不相等'}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

const { AIEngine } = await import('../server/services/AIEngine.js');
const { hasPendingQuestion } = await import('../server/services/pendingQuestion.js');
const engine = new AIEngine();

/** 构造 Claude Code 的命令确认框（真实版式：框线 + 命令头 + 命令 + 说明 + 问句 + 选项） */
function confirmBox(command, description = '执行该命令', option2 = "Yes, and don't ask again for similar commands") {
  return [
    '╭────────────────────────────────────────────────╮',
    '│ Bash command                                   │',
    '│                                                │',
    `│   ${command}`.padEnd(49) + '│',
    `│   ${description}`.padEnd(49) + '│',
    '│                                                │',
    '│ Do you want to proceed?                        │',
    '│ ❯ 1. Yes                                       │',
    `│   2. ${option2}`.padEnd(49) + '│',
    '│   3. No, and tell Claude what to do differently │',
    '╰────────────────────────────────────────────────╯',
    '   Esc to cancel'
  ].join('\n');
}

function summary() {
  console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
  if (results.failed) {
    console.log('\n失败明细：');
    for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
  }
  process.exit(results.failed ? 1 : 0);
}

// ============ 1. 确认框一律正常自动应答（破坏性检测已整体移除）============
//
// 曾经在这里做过「解析确认框里的命令 → 命中危险模式就停手」的安全闸，
// 实测误伤过多并被要求移除：rm -f 单文件、AI 清理自己的临时脚本、
// `kill $HP; wait $HP 2>/dev/null; rm -rf "$OUT"` 这类脚本收尾，
// 都会把自动流程反复打断。这几条用例防止它悄悄回来。

test('含 rm -rf 的确认框照常自动应答，不再挂起', () => {
  const r = engine.preAnalyzeStatus(confirmBox('rm -rf node_modules'), 'claude');
  eq(r?.actionType, 'select', `不该再拦，实际 ${r?.actionType}`);
  assert(/^[1-9]$/.test(String(r?.suggestedAction)), '应给出选项编号');
  assert(!r?.requireConfirmation, '不该再要求人工确认');
});

test('脚本收尾类命令（kill + rm -rf 变量）同样放行', () => {
  const cmd = 'kill $HP; wait $HP 2>/dev/null; rm -rf "$OUT"';
  eq(engine.preAnalyzeStatus(confirmBox(cmd), 'claude')?.actionType, 'select');
});

test('普通命令确认框行为不变', () => {
  eq(engine.preAnalyzeStatus(confirmBox('npm run build'), 'claude')?.actionType, 'select');
});

test('危险与普通命令拿到相同处理（不再按命令内容区别对待）', () => {
  const a = engine.preAnalyzeStatus(confirmBox('rm -rf /tmp/x'), 'claude');
  const b = engine.preAnalyzeStatus(confirmBox('npm test'), 'claude');
  eq(a?.actionType, b?.actionType);
  eq(a?.suggestedAction, b?.suggestedAction);
});

test('源码里不再有破坏性检测的残留', () => {
  const eng = fs.readFileSync(path.join(process.cwd(), 'server/services/AIEngine.js'), 'utf8');
  const srv = fs.readFileSync(path.join(process.cwd(), 'server/index.js'), 'utf8');
  for (const [name, src] of [['AIEngine.js', eng], ['index.js', srv]]) {
    assert(!/DANGEROUS_PATTERNS/.test(src), `${name} 仍有 DANGEROUS_PATTERNS`);
    assert(!/isDangerousCommand/.test(src), `${name} 仍有 isDangerousCommand`);
    assert(!/_dangerousConfirm/.test(src), `${name} 仍有 _dangerousConfirm*`);
  }
});

test('计划执行确认仍选 1（auto-accept edits）', () => {
  const screen = [
    '│ 实施计划：',
    '│ 1. 清理旧构建产物（会用到 rm -rf dist）',
    '│ 2. 重新构建并发布',
    '│',
    '│ Claude has written up a plan and is ready to execute.',
    '│ Do you want to proceed?',
    '│ ❯ 1. Yes, and auto-accept edits',
    '│   2. Yes, and manually approve edits',
    '│   3. No, keep planning',
    '   Esc to cancel'
  ].join('\n');
  const r = engine.preAnalyzeStatus(screen, 'claude');
  eq(r?.actionType, 'select');
  eq(r?.suggestedAction, '1', 'Plan 执行应选 1');
});

// ============ 5. 内容问题不能用「继续」搪塞 ============

test('「是否需要…？」会被识别为待答问题，从而升级给 AI 作答', () => {
  const screen = [
    '我已经把 3 个接口改完了。',
    '是否需要我把对应的单元测试也补上？',
    '',
    '> '
  ].join('\n');
  // 规则层仍会给出「继续」——这是设计如此，拦截发生在 analyzeStatus 里：
  // 只要 (规则层是机械「继续」) 且 (屏上有待答问题)，就丢弃规则结果改问 AI。
  // 所以真正要锁的是这个复合条件成立，而不是规则层本身的输出。
  const r = engine.preAnalyzeStatus(screen, 'claude');
  const mechanicalContinue = r && r.needsAction && r.actionType === 'text_input'
    && /^继续/.test(String(r.suggestedAction || ''));
  assert(mechanicalContinue, '前置条件：规则层给出机械「继续」');
  assert(hasPendingQuestion(screen),
    '「是否需要 X？」未被识别为待答问题，机械「继续」会直接发出去');
});

test('原先那条把「是否需要」硬答继续的规则已删除', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'server/services/AIEngine.js'), 'utf8');
  assert(!/isNeedQuestion/.test(src),
    '规则仍在：它会抢在通用判定之前返回「继续」，屏蔽掉 AI 升级');
});

test('「是否继续？」仍可自动答继续（这个问题「继续」确实是有效答案）', () => {
  const screen = '当前批次已处理完，是否继续处理下一批？\n\n> ';
  const r = engine.preAnalyzeStatus(screen, 'claude');
  eq(r?.suggestedAction, '继续', '这类问题不该被误伤');
});

// ============ 6. 选项面板识别（不靠标题白名单）============
//
// 起因：截图里 /model 的选择菜单挂在屏上，监控判成「等待输入 → 发继续」。
// 根因是面板识别原本是一张**标题白名单**（Select Model|Style|Theme、Settings/Status/Config…），
// Claude Code 每加一个 slash 面板就漏一个；漏掉后屏幕被面板占满，通用判定看到光标当空闲，
// 于是往 Ink 的 SelectInput 里打「继续」——既选不中任何项，也推不动工作。

/** 造一个编号选项面板；footer 为空表示不提供 Esc 取消 */
function panel(title, desc, items, footer = 'Enter to confirm · Esc to cancel') {
  const body = items.map((t, i) => `${i === 1 ? '  › ' : '    '}${i + 1}. ${t}`);
  return ['  ' + title, '  ' + desc, ''].concat(body, ['', footer ? '  ' + footer : '']).join('\n');
}

const MODEL_PANEL = panel('Select model',
  'Switch between Claude models. Your pick becomes the default for new sessions.',
  ['Default (recommended)   Opus 5 with 1M context',
   'Opus (1M context) ✓     Opus 5 with 1M context',
   'Fable                   Fable 5',
   'Sonnet                  Sonnet 5',
   'Haiku                   Haiku 4.5'],
  'Enter to set as default · s to use this session only · Esc to cancel');

test('/model 面板 → 按 Esc 关掉，绝不发「继续」', () => {
  const r = engine.preAnalyzeStatus(MODEL_PANEL, 'claude');
  eq(r?.actionType, 'key');
  eq(r?.suggestedAction, 'Escape');
});

test('面板套上框线 + tmux 补空行 + 底部状态栏，仍能认出', () => {
  const boxed = MODEL_PANEL.split('\n').map(l => '│ ' + l.padEnd(72) + '│').join('\n');
  const screen = '╭' + '─'.repeat(74) + '╮\n' + boxed + '\n╰' + '─'.repeat(74) + '╯'
    + '\n  ? for shortcuts                      accept edits on' + '\n'.repeat(10);
  eq(engine.preAnalyzeStatus(screen, 'claude')?.suggestedAction, 'Escape');
});

test('白名单没有的新面板（/agents 之类）也能认出——这是原来漏掉的那一类', () => {
  const screen = panel('Select agent', 'Pick an agent to run.',
    ['general-purpose  通用', 'code-reviewer  审查', 'Explore  检索'])
    + '\n\n> \n  ? for shortcuts                      accept edits on';
  const r = engine.preAnalyzeStatus(screen, 'claude');
  eq(r?.suggestedAction, 'Escape', '未知面板仍被判成空闲并发了「继续」');
});

test('面板没提供 Esc 取消 → 不猜按键，交给 AI 判断', () => {
  const screen = panel('Choose a migration path', 'Pick one to continue.',
    ['原地升级', '新建后迁移', '暂不处理'], '↑/↓ to select') + '\n\n> ';
  const r = engine.preAnalyzeStatus(screen, 'claude');
  eq(r?.actionType, 'warning', '不该给出按键');
  eq(r?._needsAiJudgement, true, '应标记为需要 AI 读屏');
  assert(!/继续/.test(String(r?.suggestedAction || '')), '仍然发了「继续」');
});

test('AI 输出里的编号列表不算菜单（不能因为过度识别把正常空闲判死）', () => {
  const screen = [
    '剩余 5 处占位都依赖尚未翻译的目录枚举 /stat：',
    '    1. DirectoryItem.get/getFileStatus 后端未译',
    '    2. Directory.open/getVolumeInfo 依赖 VolumeDevice.getMountPath',
    '    3. File 的 copy/move/replace 五个静态方法后端也没译',
    '    4. 我把它们改成直接返回 E_NOSYS 并注明待补点',
    '    5. 而不是继续 console.warn 再返回成功',
    '',
    '验证：四文件单文件 tsc 零错误；startup 1601 不变。',
    '',
    '> ',
    '  ? for shortcuts                              accept edits on'
  ].join('\n');
  const r = engine.preAnalyzeStatus(screen, 'claude');
  eq(r?.actionType, 'text_input', '普通空闲被误判成面板了');
  eq(r?.suggestedAction, '继续');
});

test('权限确认菜单仍走选项分支（有 Yes 语义，我们看得懂）', () => {
  const r = engine.preAnalyzeStatus(confirmBox('npm run build'), 'claude');
  eq(r?.actionType, 'select');
});

test('正在跑的时候即使屏上有编号也不打扰', () => {
  const screen = 'Sautéing… (2m 13s · esc to interrupt)\n  1. 步骤一\n  2. 步骤二';
  eq(engine.preAnalyzeStatus(screen, 'claude')?.needsAction, false);
});

// ============ 7. AI 不可用时的降级状态不能自相矛盾 ============

test('降级为「请人工处理」时必须清掉建议操作', () => {
  // escalated 里带着规则层那句「继续」。安全闸只拦自动发送，拦不住用户在界面上手点执行——
  // 若不清掉，界面会在"请人工回答"旁边并排显示「建议操作：继续」，点一下就把
  // 我们刚判定为答非所问的那句话发出去了。
  const escalated = {
    needsAction: true, actionType: 'text_input', suggestedAction: '继续',
    currentState: 'Claude Code空闲', actionReason: '空闲，发送继续'
  };
  const r = engine._pendingQuestionStatus(escalated, 'claude');
  eq(r.actionType, 'warning');
  eq(r.suggestedAction, null, '建议操作没清掉，手点执行会发出「继续」');
  eq(r.requireConfirmation, true);
});

test('面板类降级保留面板自己的状态描述（不套用"正在提问"文案）', () => {
  const panelStatus = {
    needsAction: true, actionType: 'warning', suggestedAction: null,
    currentState: 'CLI 选项面板开着（Choose a migration path）',
    actionReason: '屏上是一个 3 项的选项面板', _needsAiJudgement: true
  };
  const r = engine._pendingQuestionStatus(panelStatus, 'claude');
  assert(/选项面板/.test(r.currentState), `面板状态被套成了提问文案：${r.currentState}`);
  assert(/人工/.test(r.actionReason), '未说明需要人工处理');
});

test('没有待升级的状态时返回 null（不凭空造状态）', () => {
  eq(engine._pendingQuestionStatus(null, 'claude'), null);
});

// ============ 8. 真实截图回归 ============
//
// 用户第三次报「当前模型判断还是错误的」时的实际屏幕：正文 + background agents 行 +
// /model 回显 + 完整面板 + tmux 尾部补空行。当时线上跑的是三天前的旧进程，
// 判成了「等待输入 → 发继续」。这条用例把这一屏钉死。

test('真实 /model 面板屏（含正文与 background agents 行）判为按 Esc', () => {
  const screen = [
    '五、 我的建议',
    '',
    '这个包不投。 真要打政法/政务信息化这条线， 正确的进入方式是先做有涉密集成资质总包的技术分包。',
    '',
    '如果你还是想投， 成本是 5 万保证金占 90 天 + 一周编标人力， 那是另一笔账。',
    '',
    '✳ Waiting for 12 background agents to finish',
    '',
    '› /model',
    '  ────────────────────────────────────────────────────────────',
    '',
    '  Select model',
    '  Switch between Claude models. Your pick becomes the default for new sessions.',
    '  --model.',
    '',
    '    1. Default (recommended)   Opus 5 with 1M context · Best for everyday, complex tasks',
    '  › 2. Opus (1M context) ✓     Opus 5 with 1M context · Best for everyday, complex tasks',
    '    3. Fable                   Fable 5 · Most capable for your hardest and longest-running tasks',
    '    4. Sonnet                  Sonnet 5 · Efficient for routine tasks',
    '    5. Haiku                   Haiku 4.5 · Fastest for quick answers',
    '',
    '  ● High effort (default) ←/→ to adjust',
    '',
    '  Enter to set as default · s to use this session only · Esc to cancel',
    '', '', '', '', '', '', '', ''
  ].join('\n');
  const r = engine.preAnalyzeStatus(screen, 'claude');
  eq(r?.actionType, 'key', `应按 Esc 关面板，实际 ${r?.actionType}/${r?.suggestedAction}`);
  eq(r?.suggestedAction, 'Escape');
});

test('「Waiting for N background agents」不会把面板判成运行中而放过', () => {
  const screen = [
    '✳ Waiting for 12 background agents to finish',
    '',
    '  Select model',
    '    1. Default (recommended)',
    '  › 2. Opus (1M context) ✓',
    '    3. Fable',
    '',
    '  Enter to set as default · Esc to cancel'
  ].join('\n');
  eq(engine.preAnalyzeStatus(screen, 'claude')?.suggestedAction, 'Escape');
});

summary();

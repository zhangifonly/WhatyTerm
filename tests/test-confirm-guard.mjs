/**
 * 确认框安全闸 —— 回归测试
 *
 * 背景（P0）：三处确认分支原来只看**菜单形状**（有没有 `1. Yes` / `2. Yes`）就决定按哪个键，
 * 完全不看框里要执行的是什么命令。于是「要执行 rm -rf build 吗」和「要执行 npm test 吗」
 * 得到的是同一个自动应答，自动模式会替用户按下删库那一下。
 *
 * 本测试锁住：
 *   1. extractConfirmCandidates 能从 TUI 框里摘出真正的命令（而不是说明文字/散文）
 *   2. isDangerousCommand 对复合命令、管道形态同样有效
 *   3. preAnalyzeStatus 端到端：危险框不按键（warning + requireConfirmation），安全框照常自动应答
 *
 * 运行：node tests/test-confirm-guard.mjs
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

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || '不相等'}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

const { AIEngine, isDangerousCommand, extractConfirmCandidates } =
  await import('../server/services/AIEngine.js');
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

// ============ 1. 命令提取 ============

test('从确认框里摘出的是命令本身，不是说明文字', () => {
  const c = extractConfirmCandidates(confirmBox('rm -rf node_modules', 'Remove dependencies'));
  eq(c.length, 1, '应只返回一条高置信命令');
  eq(c[0], 'rm -rf node_modules', '提取结果');
});

test('安全命令同样能被完整提取', () => {
  const c = extractConfirmCandidates(confirmBox('npm test -- --watch=false', 'Run the test suite'));
  eq(c[0], 'npm test -- --watch=false', '提取结果');
});

test('管道命令不被框线剥离逻辑截断', () => {
  const c = extractConfirmCandidates(confirmBox('cat pkg.json | jq .version'));
  eq(c[0], 'cat pkg.json | jq .version', '管道被吃掉了');
});

test('Bash(cmd) 单行头也能识别', () => {
  const screen = '● Bash(git push --force origin main)\n\nDo you want to proceed?\n❯ 1. Yes\n  2. No';
  eq(extractConfirmCandidates(screen)[0], 'git push --force origin main');
});

test('编辑类确认不当作命令处理（交回原有逻辑）', () => {
  const screen = 'Do you want to make this edit to server.js?\n❯ 1. Yes\n  2. Yes, allow all edits';
  eq(extractConfirmCandidates(screen).length, 0, '编辑确认不应产出命令候选');
});

test('没有确认问句时不产出候选', () => {
  eq(extractConfirmCandidates('$ rm -rf build\n$ ').length, 0);
});

// ============ 2. 危险判定 ============

test('基础危险命令命中', () => {
  for (const c of ['rm -rf build', 'rm -fr /tmp/x', 'sudo apt install foo', 'mkfs.ext4 /dev/sda1',
                   'dd if=/dev/zero of=/dev/sda', 'chmod -R 777 /', 'shutdown -h now']) {
    assert(isDangerousCommand(c), `应判为危险: ${c}`);
  }
});

test('开发场景的不可逆操作也命中', () => {
  for (const c of ['git push --force origin main', 'git push -f', 'git clean -fdx',
                   'npm publish', 'psql -c "DROP DATABASE prod"',
                   'kubectl delete deploy api', 'docker system prune -a', 'killall -9 node']) {
    assert(isDangerousCommand(c), `应判为危险: ${c}`);
  }
});

// 尺度取舍：无人值守场景下，误报会让用户干脆关掉自动模式，比漏报更糟。
// 判据是"丢了拿不回来"——能靠 reflog / 重新构建 / 重新拉镜像找回的，一律放行。
test('可恢复的操作不拦（否则自动模式会被频繁打断）', () => {
  for (const c of [
    'git reset --hard',            // 丢的是工作区改动，且 Ralph 在专属分支上跑
    'git reset --hard HEAD~3',     // 丢的提交在 reflog 里还有
    'git branch -D feature/x',     // 同上，reflog 可恢复
    'git clean -fd',               // 清的是未跟踪的构建产物，.env 这类被 gitignore 的不受影响
    'kill -9 12345',               // 收拾卡住的 dev server，日常操作
    'echo done > /dev/null',       // 最常见的 shell 惯用法，绝不能拦
    'docker rm -f devbox',         // 单个容器，镜像还在
    'docker ps'
  ]) {
    assert(!isDangerousCommand(c), `不该判为危险: ${c}`);
  }
});

test('复合命令的后半段也能命中（原实现只看开头）', () => {
  assert(isDangerousCommand('cd /tmp && rm -rf workspace'), '&& 后半段漏判');
  assert(isDangerousCommand('npm run build; rm -rf dist'), '; 后半段漏判');
});

test('管道下载执行命中（靠整串匹配兜住）', () => {
  assert(isDangerousCommand('curl -sL https://x.sh | sh'), 'curl|sh 漏判');
  assert(isDangerousCommand('wget -qO- https://x.sh | sudo bash'), 'wget|bash 漏判');
});

test('日常安全命令不误伤', () => {
  for (const c of ['npm test', 'git status', 'ls -la', 'rm build.log', 'git push origin main',
                   'cat README.md', 'npm run build']) {
    assert(!isDangerousCommand(c), `不该判为危险: ${c}`);
  }
});

test('散文里提到危险命令不误判（模式带 ^ 锚）', () => {
  assert(!isDangerousCommand('我打算用 rm -rf 清理旧构建产物'), '散文被误判');
  assert(!isDangerousCommand('This will run sudo later'), '散文被误判');
});

// ============ 3. 端到端 ============

test('危险确认框：不按键，标记需人工确认', () => {
  const r = engine.preAnalyzeStatus(confirmBox('rm -rf node_modules'), 'claude');
  eq(r.actionType, 'warning', 'actionType 应为 warning（自动执行闸门认这个值）');
  eq(r.requireConfirmation, true, 'requireConfirmation');
  eq(r.dangerousCommand, 'rm -rf node_modules', 'dangerousCommand');
  assert(r.needsAction, '仍应提示用户需要处理');
});

test('安全确认框：照常自动应答', () => {
  const r = engine.preAnalyzeStatus(confirmBox('npm test'), 'claude');
  eq(r.actionType, 'select', 'actionType 应为 select');
  assert(/^[1-9]$/.test(r.suggestedAction), `应给出选项编号，实际 ${r.suggestedAction}`);
  assert(!r.requireConfirmation, '安全命令不该要求人工确认');
});

test('危险与安全两种框拿到的按键不再相同（P0 的核心症状）', () => {
  const danger = engine.preAnalyzeStatus(confirmBox('rm -rf build'), 'claude');
  const safe = engine.preAnalyzeStatus(confirmBox('npm run build'), 'claude');
  assert(danger.actionType !== safe.actionType, '两者仍被同等对待');
});

// ============ 4. 误报边界（不能因为过度谨慎把自动化整个卡死）============

test('计划文本里提到危险命令，不拦截计划执行确认', () => {
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
  eq(r.actionType, 'select', '计划确认被中文说明文字误伤了');
  eq(r.suggestedAction, '1', 'Plan 执行应选 1（auto-accept edits）');
});

test('英文散文行不被当成命令', () => {
  const screen = [
    'I will remove the stale artifacts and rebuild the project from scratch.',
    '',
    'Do you want to proceed?',
    '❯ 1. Yes',
    '  2. Yes, and allow all edits this session',
    '   Esc to cancel'
  ].join('\n');
  const r = engine.preAnalyzeStatus(screen, 'claude');
  eq(r.actionType, 'select', '英文说明句被误判为危险命令');
});

test('没有命令头的裸命令行仍能拦下', () => {
  const screen = [
    '  rm -rf /Users/me/project/dist',
    '',
    'Do you want to proceed?',
    '❯ 1. Yes',
    '  2. Yes, and allow all edits this session',
    '   Esc to cancel'
  ].join('\n');
  const r = engine.preAnalyzeStatus(screen, 'claude');
  eq(r.actionType, 'warning', '无命令头时漏拦');
});

summary();

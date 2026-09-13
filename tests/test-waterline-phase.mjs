/**
 * Auto Memory 三步闭环状态机 —— 单元测试
 *
 * 手册（auto_memory_presentation.html）要求的闭环：
 *   ① 收尾写记忆(handoff) → ② 带目标 /compact → ③ 新上下文先读 MEMORY.md 再续(resume)
 *
 * 关键约束（用户两条决策）：
 *   - 补全三步闭环，不能只做收尾
 *   - 收尾「确认写完」后才自动 /compact；太久没写完只告警不压缩（轮数兜底）
 *
 * 本测试锁住 decideWaterlinePhase 的相变、off/warn 封顶、水位回落复位、
 * 以及 isMemoryWritten 的措辞识别与轮数兜底。
 *
 * 运行：node tests/test-waterline-phase.mjs
 */

import {
  decideWaterlinePhase, isMemoryWritten, readContextWaterline,
  WARN_USED_PCT, HANDOFF_USED_PCT, HANDOFF_WAIT_ROUNDS,
  HANDOFF_PROMPT, RESUME_PROMPT,
} from '../server/services/contextWaterline.js';

const results = { passed: 0, failed: 0, errors: [] };

// ⚠️ 必须 await：老实现直接 fn() 不等待，async 测试体里的断言失败会变成
//    未处理的 Promise rejection 被静默吞掉，测试报「通过」而其实没跑完 ——
//    假通过比没测更危险。所有 test 调用点改为 await test(...)。
const pending = [];
function test(name, fn) {
  const p = (async () => {
    try {
      await fn();
      results.passed++;
      console.log(`✅ ${name}`);
    } catch (err) {
      results.failed++;
      results.errors.push({ name, error: err.message });
      console.log(`❌ ${name}`);
    }
  })();
  pending.push(p);
  return p;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

const auto = (o) => decideWaterlinePhase({ mode: 'auto', ...o });

// ---------- 底栏三种文案（漏一种就等于闭环在高水位会话上永不触发）----------
test('读数：旧版 "Context left until auto-compact: N%" 按剩余转已用', () => {
  assert(readContextWaterline('Context left until auto-compact: 12%') === 88);
});
test('读数：新版 "N% until auto-compact" 按剩余转已用', () => {
  assert(readContextWaterline('9% until auto-compact') === 91);
});
test('读数："N% context used" 是已用，直接用不做 100- 转换', () => {
  // 实测 4 个真实高水位会话底栏写的就是这个；若误按剩余处理，100 会变成 0，
  // 判成"水位充足"正好反了 —— 最需要交接的时候反而彻底不触发。
  assert(readContextWaterline('100% context used') === 100, '100% context used 必须读成已用 100');
  assert(readContextWaterline('99% context used') === 99);
});
test('读数：认不出的文案返回 null，绝不臆造', () => {
  assert(readContextWaterline('随便一段没有水位的正文') === null);
  assert(readContextWaterline('') === null);
  assert(readContextWaterline(null) === null);
});
// ⚠️ 这条原来断言 `Context low (0% remaining)` 应返回 null——那是**错的期望**：
// 它是 CLI 2.1.270 关掉 autocompact 时的底栏文案（反解自二进制），
// 而且是唯一「CLI 不会自救」的分支，最该触发交接。现已支持，故断言反过来。
test('读数：Context low (N% remaining) 是关闭 autocompact 的底栏，必须认', () => {
  assert(readContextWaterline('Context low (0% remaining) · Run /compact') === 100);
  assert(readContextWaterline('Context low (5% remaining)') === 95);
});
test('读数：模块级 /g 正则跨调用不残留 lastIndex（连调结果必须恒定）', () => {
  const got = [0, 1, 2, 3].map(() => readContextWaterline('100% context used'));
  assert(got.every((v) => v === 100), `连调结果漂移：${got.join(',')}`);
});
test('读数：满水位 100% 能触发收尾（回归——曾因失配返回 null 而永不触发）', () => {
  const r = auto({ usedPercent: readContextWaterline('100% context used'), isIdle: true, phase: 'idle' });
  assert(r.level === 'handoff', JSON.stringify(r));
});

// ---------- ① idle → handoff ----------
test('水位充足时无动作、阶段归 idle', () => {
  const r = auto({ usedPercent: 50, isIdle: true, phase: 'idle' });
  assert(r.level === 'none' && r.nextPhase === 'idle', JSON.stringify(r));
});
test('水位偏高但未达交接线：只告警，仍 idle', () => {
  const r = auto({ usedPercent: WARN_USED_PCT + 1, isIdle: true, phase: 'idle' });
  assert(r.level === 'warn' && r.nextPhase === 'idle', JSON.stringify(r));
});
test('达交接线且空闲：发收尾，进 handoff_sent', () => {
  const r = auto({ usedPercent: HANDOFF_USED_PCT, isIdle: true, phase: 'idle' });
  assert(r.level === 'handoff' && r.nextPhase === 'handoff_sent', JSON.stringify(r));
});
test('达交接线但运行中：不打断，仅告警、留在 idle', () => {
  const r = auto({ usedPercent: HANDOFF_USED_PCT + 5, isIdle: false, phase: 'idle' });
  assert(r.level === 'warn' && r.nextPhase === 'idle', JSON.stringify(r));
});

// ---------- ② handoff_sent → compact ----------
test('收尾后记忆未写完：不压缩，停在 handoff_sent', () => {
  const r = auto({ usedPercent: 90, isIdle: true, phase: 'handoff_sent', memoryWritten: false });
  assert(r.level === 'warn' && r.nextPhase === 'handoff_sent', JSON.stringify(r));
});
test('收尾后记忆写完且空闲：发 /compact，进 compact_sent', () => {
  const r = auto({ usedPercent: 90, isIdle: true, phase: 'handoff_sent', memoryWritten: true });
  assert(r.level === 'compact' && r.nextPhase === 'compact_sent', JSON.stringify(r));
});

// ---------- ③ compact_sent → resume ----------
test('压缩进行中：等待，停在 compact_sent', () => {
  const r = auto({ usedPercent: 90, isIdle: false, phase: 'compact_sent', isCompacting: true });
  assert(r.level === 'warn' && r.nextPhase === 'compact_sent', JSON.stringify(r));
});
test('压缩结束且空闲：发恢复指令，进 resumed', () => {
  const r = auto({ usedPercent: 40, isIdle: true, phase: 'compact_sent', isCompacting: false });
  assert(r.level === 'resume' && r.nextPhase === 'resumed', JSON.stringify(r));
});

// ---------- 水位回落复位 ----------
test('已恢复后水位仍高：等回落，停在 resumed', () => {
  const r = auto({ usedPercent: 85, isIdle: true, phase: 'resumed' });
  assert(r.level === 'warn' && r.nextPhase === 'resumed', JSON.stringify(r));
});
test('水位回落到安全区：除 compact_sent 外都复位到 idle', () => {
  // compact_sent 是例外：压缩成功后水位必然回落，但闭环还差最后一步 resume，
  // 不能被回落复位拦截（否则「先读 MEMORY.md 再续」永远发不出去）。
  for (const phase of ['idle', 'handoff_sent', 'resumed']) {
    const r = auto({ usedPercent: WARN_USED_PCT - 1, isIdle: true, phase });
    assert(r.nextPhase === 'idle' && r.level === 'none', `${phase}: ${JSON.stringify(r)}`);
  }
});
test('compact_sent 遇水位回落不复位，仍推进到 resume（闭环收口）', () => {
  const r = auto({ usedPercent: WARN_USED_PCT - 1, isIdle: true, phase: 'compact_sent', isCompacting: false });
  assert(r.level === 'resume' && r.nextPhase === 'resumed', JSON.stringify(r));
});

// ---------- off / warn 模式封顶 ----------
test('off 模式：任何水位都不动作', () => {
  const r = decideWaterlinePhase({ mode: 'off', usedPercent: 99, isIdle: true, phase: 'idle' });
  assert(r.level === 'none' && r.nextPhase === 'idle', JSON.stringify(r));
});
test('warn 模式：达交接线也只告警、不发指令', () => {
  const r = decideWaterlinePhase({ mode: 'warn', usedPercent: 95, isIdle: true, phase: 'idle' });
  assert(r.level === 'warn', JSON.stringify(r));
});

// ---------- 无读数 ----------
test('无水位读数：不动作、保持当前阶段', () => {
  const r = auto({ usedPercent: null, isIdle: true, phase: 'handoff_sent' });
  assert(r.level === 'none' && r.nextPhase === 'handoff_sent', JSON.stringify(r));
});

// ---------- isMemoryWritten 措辞 + 轮数兜底 ----------
test('回复含"已更新记忆文件"：判为写完', () => {
  assert(isMemoryWritten('已更新记忆文件 context-waterline-handoff.md', 1) === true);
});
test('回复含 memory/xxx.md 路径：判为写完', () => {
  assert(isMemoryWritten('写入了 memory/foo-bar.md', 1) === true);
});
test('普通回复不误判为写完', () => {
  assert(isMemoryWritten('我继续处理下一个文件', 1) === false);
});
test('轮数兜底：措辞不匹配但等待≥阈值也判写完（防卡死）', () => {
  assert(isMemoryWritten('嗯', HANDOFF_WAIT_ROUNDS) === true);
  assert(isMemoryWritten('嗯', HANDOFF_WAIT_ROUNDS - 1) === false);
});


// ================= v1.2.98 审计修复的回归锁 =================
// 构造一屏真实形态的底栏：水位行在**倒数第 5 个非空行**（实测如此，不是末行）。
const screen = (bar) => ['前面的正文', '更多正文', '', '─'.repeat(60), bar,
  '─'.repeat(60), '❯', '─'.repeat(60), '  ⏵⏵ auto mode on · esc to interrupt'].join('\r\n');

test('读数：底栏逐 token 分色（capture-pane -e）也要认——不剥码必失配', () => {
  const colored = '\x1b[38;5;246m100%\x1b[39m \x1b[38;5;246mcontext\x1b[39m \x1b[38;5;246mused\x1b[39m';
  assert(readContextWaterline(screen(colored)) === 100, '逐 token 分色漏读');
  const colored2 = '\x1b[38;5;246m8%\x1b[39m \x1b[38;5;246muntil\x1b[39m \x1b[38;5;246mauto-compact\x1b[39m';
  assert(readContextWaterline(screen(colored2)) === 92);
});
test('读数：窄屏截断（wrap:truncate 截在词中）仍要认', () => {
  assert(readContextWaterline(screen('100% context us')) === 100);
  assert(readContextWaterline(screen('8% until auto-comp')) === 92);
});
test('读数：底栏在倒数第 5 个非空行也要认（窗口不能只取末 3 行）', () => {
  assert(readContextWaterline(screen('40% context used')) === 40);
});
test('读数：屏上出现源码/单测里的字面量不得被当成真读数（WebTmux 自身开发时天天发生）', async () => {
  const fs = await import('node:fs');
  // 本模块注释里就写着 `100% context used`；单测文件里也有 88 这个数（=HANDOFF_USED_PCT，正好踩线）
  assert(readContextWaterline(fs.readFileSync('server/services/contextWaterline.js', 'utf8')) === null,
    '本模块源码被当成屏幕时读出了假水位');
  assert(readContextWaterline(fs.readFileSync('tests/test-waterline-phase.mjs', 'utf8')) === null,
    '单测文件被当成屏幕时读出了假水位');
});
test('读数：工具输出行（⎿ 53: ...）不得冒充底栏', () => {
  assert(readContextWaterline(['正文', '  ⎿ 53: 100% context used', '❯'].join('\r\n')) === null);
});

// ---------- 记忆判据：必须是完成式，且不能被自己的指令回显骗到 ----------
test('记忆判据：收尾/恢复指令自身的回显不得判成"写完了"（否则一轮就误发 /compact）', () => {
  assert(isMemoryWritten(HANDOFF_PROMPT, 0) === false, '收尾指令回显自证写完');
  assert(isMemoryWritten(RESUME_PROMPT, 0) === false, '恢复指令回显自证写完');
});
test('记忆判据：未来句/反问/只是读过，都不算写完', () => {
  assert(isMemoryWritten('接下来我会把结论写入记忆文件 MEMORY.md。', 0) === false, '未来句');
  assert(isMemoryWritten('要我把这些写进 MEMORY.md 吗？', 0) === false, '反问');
  assert(isMemoryWritten('读取 MEMORY.md 后发现主题列表已过期。', 0) === false, '只是读了');
  assert(isMemoryWritten('写入记忆失败：权限不足', 0) === false, '失败');
  assert(isMemoryWritten('不需要更新记忆', 0) === false, '否定');
});
test('记忆判据：真的写完了要认（中英文各形态）', () => {
  assert(isMemoryWritten('已更新记忆文件 memory/foo.md', 0) === true);
  assert(isMemoryWritten('已把进度写入记忆', 0) === true);
  assert(isMemoryWritten('记忆文件已同步完毕', 0) === true);
  assert(isMemoryWritten('I have updated the memory files.', 0) === true);
  assert(isMemoryWritten('Saved to memory: progress and next steps.', 0) === true);
});


// ---------- 结构不变量：阶段只许在「确认发出」后落地 ----------
// 这条锁的是 index.js 的代码结构，不是纯函数行为。老实现在决策处就翻阶段，
// 而决策点与发送点之间有 5 处 continue，被拦掉就丢步且阶段已推进 →
// 3 轮兜底放行 → 记忆一字未写就 /compact。防的就是有人把赋值挪回去。
test('结构：_waterlinePhase 的写入必须都在五处 continue 出口之后（提议+确认两段式）', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync('server/index.js', 'utf8').split('\n');
  const lineOf = (pred) => src.reduce((acc, l, i) => (pred(l) ? [...acc, i + 1] : acc), []);
  // 提议点：决策处只挂 _waterlineNextPhase，不写 _waterlinePhase
  const proposeLines = lineOf((l) => l.includes('_waterlineNextPhase:'));
  assert(proposeLines.length === 1, `提议点应恰好 1 处，实际 ${proposeLines.length}`);
  // 真正的写入点（排除注释行）
  const writeLines = lineOf((l) => /session\._waterlinePhase\s*=/.test(l) && !/^\s*\/\//.test(l.trim()));
  assert(writeLines.length === 2, `写入点应恰好 2 处（compact 直发 + 文本发送），实际 ${writeLines.length}: ${writeLines}`);
  // 每个写入点都必须晚于提议点——即"先提议、后落地"
  for (const w of writeLines) {
    assert(w > proposeLines[0], `写入点 ${w} 早于提议点 ${proposeLines[0]}，阶段又回到"先翻后发"了`);
  }
  // 落地点必须紧跟发送后的落账公共尾巴。lastActionMap.set 有三处
  //（preAnalyze / ai_cache / ai 三条发送路径），水位只改写 preResult，
  // 而 preResult 非空时走的就是 preAnalyze 那条，所以只需一个落地点，
  // 但它必须真的贴着某个落账点——取最近的那个比较。
  const commitTails = lineOf((l) => l.includes('lastActionMap.set(session.id'));
  assert(commitTails.length >= 1, '找不到 lastActionMap.set 落账点');
  const textCommit = writeLines[writeLines.length - 1];
  const nearest = commitTails.reduce((a, b) =>
    Math.abs(b - textCommit) < Math.abs(a - textCommit) ? b : a);
  assert(Math.abs(textCommit - nearest) < 20,
    `文本分支的阶段落地(${textCommit})应紧跟最近的落账点(${nearest})，否则不是"确认发出"语义`);
});

await Promise.all(pending);  // 等所有（含 async）测试跑完再汇总
console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exit(results.failed ? 1 : 0);

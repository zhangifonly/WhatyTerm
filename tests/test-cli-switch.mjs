/**
 * 普通会话换 CLI（server/services/cliSwitch.js）。Codex 屏幕样本是 codex-cli 0.160.0 实抓（tests/fixtures/screens/codex-*）。
 *   ① Codex 屏幕：空闲 / 草稿 / 运行中 / 一轮结束 / 信任目录 判对；草稿只认非暗色（占位文字是暗色）
 *   ② 交接指令：Claude 要写记忆并说明更新了哪些记忆文件（复用「记忆写完了」判据）；Codex 不提记忆；都要求不再写代码
 *   ③ 第一句：说明换了人、附摘要、规则文件与记忆在哪；没摘要时如实说
 *   ④ Codex 回复：只认 sinceMs 之后、本目录的 task_complete；首行很长也读得到 cwd；跨零点也找得到
 *   ⑤ Claude 记忆目录：项目配置指定的优先；「两个都读」设置文件内容正确
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { codexPendingText, isCodexInputReady, isTrustPrompt, switchHandoffPrompt, switchFirstMessage, codexTurnSince, claudeTurnSince, claudeMemoryDir, ensureBothRulesSettings }
  from '../server/services/cliSwitch.js';
import { isMemoryWritten } from '../server/services/contextWaterline.js';

let pass = 0, fail = 0;
const test = (n, fn) => { try { fn(); pass++; console.log(`✅ ${n}`); } catch (e) { fail++; console.log(`❌ ${n}\n    ${e.message}`); } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); };
const fx = (n) => fs.readFileSync(new URL(`./fixtures/screens/${n}`, import.meta.url), 'utf8').replace(/\n/g, '\r\n');   // 读屏函数给的是 \r\n

test('① Codex 屏幕判读（含色码与 \\r\\n）', () => {
  const r = (n) => [codexPendingText(fx(n)), isCodexInputReady(fx(n)), isTrustPrompt(fx(n))];
  eq(r('codex-idle.ansi.txt'), ['', true, false], '空闲（带色码）');
  eq(r('codex-idle.txt'), ['', true, false], '空闲（纯文本）');
  eq(r('codex-pending.ansi.txt')[0], 'hello draft', '草稿');
  eq(r('codex-running.txt').slice(1), [false, false], '运行中不算就绪');
  eq(r('codex-done.txt'), ['', true, false], '一轮结束');
  eq(r('codex-trust.txt').slice(1), [false, true], '信任目录');
  eq(isTrustPrompt(fx('claude-trust.txt')), true, 'Claude 的信任目录（默认项是 No, exit，绝不能替人回车）');
  const dimDraft = fx('codex-idle.ansi.txt').replace('\x1b[2mAsk Codex to do anything', 'Ask Codex to do anything');
  eq(codexPendingText(dimDraft), 'Ask Codex to do anything', '同样的字不是暗色就是草稿');
});

test('② 交接指令', () => {
  const c = switchHandoffPrompt('claude', 'codex'), x = switchHandoffPrompt('codex', 'claude');
  eq([/Auto Memory/.test(c), /更新了哪些记忆文件/.test(c), /不要继续写代码/.test(c), /Codex/.test(c)], [true, true, true, true], 'Claude → Codex');
  eq([/Auto Memory|记忆文件/.test(x), /Claude Code/.test(x)], [false, true], 'Codex → Claude 不提记忆');
  // 自指防护：指令回显本身不能被当成「写完了」
  eq(isMemoryWritten(c, 0), false, '指令回显不算写完');
});

test('③ 第一句', () => {
  const m = switchFirstMessage({ from: 'claude', to: 'codex', receipt: '进度：sum 已完成\n下一步：mean', rulesFiles: ['CLAUDE.md'], memoryDir: '/m' });
  eq([/刚才由 Claude Code 开发，现在换成你（Codex）/.test(m), /项目规则在 CLAUDE\.md/.test(m), /记忆在 \/m/.test(m), m.endsWith('下一步：mean')], [true, true, true, true], '内容');
  eq(/没给出交接摘要/.test(switchFirstMessage({ from: 'codex', to: 'claude', receipt: '' })), true, '没摘要如实说');
});

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-switch-'));
test('④ Codex 回复：只认之后、本目录；长首行；跨零点', () => {
  const now = Date.now();
  const day = (ms) => { const d = new Date(ms); return path.join(TMP, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')); };
  const write = (ms, name, cwd, events) => {
    fs.mkdirSync(day(ms), { recursive: true });
    const meta = JSON.stringify({ type: 'session_meta', payload: { cwd, instructions: 'x'.repeat(300_000) } });
    fs.writeFileSync(path.join(day(ms), name), [meta, ...events.map((e) => JSON.stringify(e))].join('\n') + '\n');
  };
  const tc = (ms, text) => ({ timestamp: new Date(ms).toISOString(), type: 'event_msg', payload: { type: 'task_complete', last_agent_message: text } });
  write(now, 'rollout-a.jsonl', '/proj', [tc(now - 60e3, '旧的'), tc(now + 10, '交接摘要')]);
  write(now, 'rollout-b.jsonl', '/other', [tc(now + 20, '别的目录')]);
  eq(codexTurnSince('/proj', now, TMP), { done: true, text: '交接摘要', file: path.join(day(now), 'rollout-a.jsonl') }, '本目录、之后的');
  eq(codexTurnSince('/proj', now + 1000, TMP).done, false, '还没答完');
  // 开始时在昨天、文件在今天的目录（跨零点）
  eq(codexTurnSince('/proj', now - 86400e3, TMP).done, true, '跨零点');
});

test('④ Claude 回复：等到 turn_duration 才算答完，只取这一轮 end_turn 的文字', () => {
  const now = Date.now();
  const dir = path.join(TMP, '.claude', 'projects', '-proj');
  fs.mkdirSync(dir, { recursive: true });
  const at = (ms) => new Date(now + ms).toISOString();
  const L = (o) => JSON.stringify(o);
  const head = [
    L({ type: 'user', timestamp: at(10), message: { content: '<pasted_content>交接指令</pasted_content> 按上面这段的要求做。' } }),
    L({ type: 'assistant', timestamp: at(20), message: { stop_reason: 'tool_use', content: [{ type: 'text', text: '我先更新记忆' }, { type: 'tool_use' }] } }),
    L({ type: 'user', timestamp: at(30), message: { content: [{ type: 'tool_result' }] } }),
  ];
  const f = path.join(dir, 's.jsonl');
  fs.writeFileSync(f, head.join('\n') + '\n');
  eq(claudeTurnSince('/proj', now, TMP).done, false, '还在干活（屏幕上看着像答完了也不算）');
  fs.appendFileSync(f, [L({ type: 'assistant', timestamp: at(40), message: { stop_reason: 'end_turn', content: [{ type: 'thinking' }, { type: 'text', text: '交接摘要：下一步做 mean' }] } }),
    L({ type: 'system', subtype: 'turn_duration', timestamp: at(41) })].join('\n') + '\n');
  eq(claudeTurnSince('/proj', now, TMP), { done: true, text: '交接摘要：下一步做 mean', file: f }, '答完');
  eq(claudeTurnSince('/proj', now + 100, TMP).done, false, '之前那轮不算');
});

test('⑤ Claude 记忆目录与「两个都读」设置', () => {
  const proj = path.join(TMP, 'p');
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.claude', 'settings.local.json'), JSON.stringify({ autoMemoryDirectory: '/custom/mem' }));
  eq(claudeMemoryDir(proj, TMP), '/custom/mem', '项目配置指定的优先');
  eq(claudeMemoryDir(path.join(TMP, 'none'), TMP), '', '没有就空着，不编路径');
  const f = ensureBothRulesSettings(TMP);
  eq(JSON.parse(fs.readFileSync(f, 'utf8')).pluginConfigs['agents-md@builtin'].options.instructionFiles, 'claude-md-and-agents-md', '设置内容');
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);

/**
 * 长程换执行者 E2E：A 做第一阶段，B 接着做第二阶段（真服务 + 真 CLI，会花钱）。
 *   第一阶段（A）：写 sum.js + 测试，并立一条项目规矩「每个 .js 第一行是 // 规则版本 R7」，写进它平时读的规则文件
 *   第二阶段（B，续跑）：写 mean.js 复用 sum —— 需求里**不提**那条规矩，看 B 自己从规则文件 / 记忆里接上没有
 * 检查：B 开的是新对话（不拿 A 的对话 id 去续）、开场复述得出 A 的进度、新文件遵守规矩、复用了 sum、
 *      测试全过、规则文件只有一份（没有新建另一份把原来的遮住）、监督者跟着换成 B。
 * 运行：node scripts/e2e-longrun-switch.mjs claude codex   （或 codex claude）
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { sandboxBase } from '../server/services/LongRunLaunch.js';

const [A, B] = [process.argv[2] || 'claude', process.argv[3] || 'codex'];
const { io } = await import(path.resolve('node_modules/socket.io-client/build/esm-debug/index.js'));
const NAME = `wtsw${A}to${B}e2e`;
const ROOT = path.join(sandboxBase(), NAME);
if (fs.existsSync(ROOT)) throw new Error(`测试目录已存在，先确认里面不是你的东西再删：${ROOT}`);
const REQ1 = ['# 需求', '',
  '在项目根目录写 `sum.js`，导出 `sum(numbers)`：返回数组各项之和，空数组返回 0，遇到非数字抛 TypeError；再写 `sum.test.js`，用 `node:test` 覆盖这三种情况。',
  '这个项目有一条规矩：**每个 .js 文件的第一行必须是注释 `// 规则版本 R7`**。把这条规矩写进项目的规则文件（你平时会自动读的那个），以后写的代码都照做。',
  '不要引入依赖。`node --test` 全部通过就算完成。'].join('\n');
const REQ2 = ['# 需求', '',
  '新增 `mean.js`，导出 `mean(numbers)`：求平均值，**复用 `sum.js` 里的 `sum`** 计算；空数组抛 RangeError。再写 `mean.test.js` 覆盖正常与空数组两种情况。',
  '`node --test` 全部通过（包括原有的测试）就算完成。'].join('\n');

let fail = 0;
const ok = (n, c, d = '') => { console.log(`${c ? '✅' : '❌'} ${n} ${c ? '' : d}`); if (!c) fail++; };
const s = io('http://127.0.0.1:3928', { transports: ['websocket'] });
await new Promise((r) => s.on('connect', r));
const call = (ev, d, ms = 120000) => new Promise((r) => { const t = setTimeout(() => r({ ok: false, error: '超时' }), ms); s.emit(ev, d, (x) => { clearTimeout(t); r(x); }); });
const events = [];
s.on('longrun:event', (ev) => {
  events.push(ev);
  if (['send', 'result'].includes(ev.kind)) console.log(`   · ${ev.kind} ${ev.label || ''} ${ev.exit_reason || ''}${ev.kind === 'send' ? (ev.resume ? '（续）' : '（新对话）') : ''}`);
});
const runPhase = async (label, opts) => {
  const from = events.length;
  const r = await call('longrun:start', { projectName: NAME, ...opts, maxLegs: 12, noAsk: true });
  if (!r.ok) throw new Error(`${label} 启动失败：${r.error}`);
  const done = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 25 * 60 * 1000);
    const h = (ev) => { if (ev.kind === 'finished') { clearTimeout(t); s.off('longrun:event', h); resolve(ev); } };
    s.on('longrun:event', h);
  });
  return { task: r.task, done, evs: events.slice(from) };
};
const read = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { return ''; } };
let entryId = null;
try {
  console.log(`== 第一阶段：${A}`);
  const p1 = await runPhase('第一阶段', { requirementText: REQ1, mode: 'start', executor: A });
  entryId = p1.task.sessionId;
  ok(`第一阶段（${A}）收工`, /project_done/.test(JSON.stringify(p1.done)), JSON.stringify(p1.done).slice(0, 300));
  const rules1 = ['CLAUDE.md', 'AGENTS.md'].filter((f) => fs.existsSync(path.join(ROOT, f)));
  console.log(`   第一阶段后的规则文件：${rules1.join('、') || '（没有）'}；规矩写在：${['CLAUDE.md', 'AGENTS.md'].filter((f) => /R7/.test(read(f))).join('、') || '规则文件里没有'}${/R7/.test(fs.readdirSync(path.join(ROOT, '.memory')).map((f) => read(`.memory/${f}`)).join('')) ? '；.memory 里也有' : ''}`);

  console.log(`== 第二阶段：${B}（续跑）`);
  const p2 = await runPhase('第二阶段', { requirementText: REQ2, mode: 'resume', projectRoot: ROOT, executor: B });
  ok('自检写明换了执行者', JSON.stringify(p2.task.selfCheck).includes('换执行者'), '');
  ok(`监督者跟着换成 ${B}`, B === 'claude' ? !p2.task.supervisor?.cli : p2.task.supervisor?.cli === B, JSON.stringify(p2.task.supervisor));
  // 事件订阅在启动回执之后才挂上，开头那几条推送收不到：从 loop.log 核对派发顺序
  const log = read('.run/loop.log');
  const phase2 = log.slice(log.lastIndexOf('换执行者：先让上一执行者'));
  ok(`换人前先让 ${A} 续回它的对话收尾`, /发送「换执行者前收尾（.+）」（续同一会话）/.test(phase2), phase2.slice(0, 300));
  ok('收尾之后新执行者开的是新对话（不拿上一执行者的对话 id 去续）', /发送「新对话开始提示词」（新会话）/.test(phase2), '');
  ok('收尾后记忆里有上一阶段的进度（提到 sum）', /sum/i.test(fs.readdirSync(path.join(ROOT, '.memory')).map((f) => read(`.memory/${f}`)).join('')), '');
  const brief = p2.evs.find((e) => e.kind === 'result' && e.label === '新对话开始提示词')?.text || '';
  ok('开场复述得出上一阶段的进度（提到 sum）', /sum/i.test(brief), brief.slice(0, 300));
  console.log(`   开场复述：${brief.replace(/\s+/g, ' ').slice(0, 220)}`);
  ok(`第二阶段（${B}）收工`, /project_done/.test(JSON.stringify(p2.done)), JSON.stringify(p2.done).slice(0, 300));
  const mean = read('mean.js');
  ok('mean.js 复用了 sum', /require\(['"]\.\/sum(\.js)?['"]\)|from ['"]\.\/sum(\.js)?['"]/.test(mean), mean.slice(0, 200));
  ok('需求没提的规矩照样遵守（mean.js / mean.test.js 第一行是 // 规则版本 R7）',
    /^\/\/ 规则版本 R7/.test(mean) && /^\/\/ 规则版本 R7/.test(read('mean.test.js')), `${mean.split('\n')[0]} | ${read('mean.test.js').split('\n')[0]}`);
  let out = '';
  try { out = execFileSync('node', ['--test'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { out = `失败：${e.stdout || e.message}`; }
  ok('node --test 全过（含第一阶段的测试）', /[#ℹ] fail 0/.test(out) && /[#ℹ] pass [4-9]/.test(out), out.slice(-300));
  const rules2 = ['CLAUDE.md', 'AGENTS.md'].filter((f) => fs.existsSync(path.join(ROOT, f)));
  ok('规则文件只有一份（没有新建另一份把原来的遮住）', rules2.length <= 1, rules2.join('、'));
} catch (e) {
  fail++; console.log(`❌ ${e.message}`);
} finally {
  if (entryId) s.emit('session:delete', entryId);
  await new Promise((r) => setTimeout(r, 2000));
  s.close();
  console.log(`\n项目留在 ${ROOT} 供查看（确认后可手动删除）`);
  console.log(`=== ${fail ? `${fail} 项失败` : '全部通过'} ===`);
  process.exit(fail ? 1 : 0);
}

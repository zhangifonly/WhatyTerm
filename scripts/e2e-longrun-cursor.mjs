/**
 * 长程 + Cursor 执行者 E2E：真服务 + 真 cursor-agent（Cursor 订阅）+ 真监督者（claude CLI，CC Switch 当前配置，会花一点钱）。
 * 场景：新建长程项目，执行者选 Cursor，需求是一个小 JS 模块 + 测试 →
 *      自检里写明执行者是 Cursor → 开场初始化记忆库（.memory/MEMORY.md 被建出来，说明改写后的提示词它照做了）→
 *      主线干活期间插一句话 → 插话在工具间隙生效、续同一段对话发进去 → 项目做完，测试真能跑过 → 费用记 $0（订阅）。
 * 运行：node scripts/e2e-longrun-cursor.mjs
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { sandboxBase } from '../server/services/LongRunLaunch.js';

const { io } = await import(path.resolve('node_modules/socket.io-client/build/esm-debug/index.js'));
const NAME = 'wtlrcursore2e';
const ROOT = path.join(sandboxBase(), NAME);
if (fs.existsSync(ROOT)) throw new Error(`测试目录已存在，先确认里面不是你的东西再删：${ROOT}`);
const REQ = [
  '# 需求', '',
  '在项目根目录写一个 `sum.js`，导出 `sum(numbers)`：返回数组各项之和，空数组返回 0，遇到非数字抛 TypeError。',
  '再写 `sum.test.js`，用 Node 自带的 `node:test` 和 `node:assert` 覆盖上面三种情况。',
  '`node --test` 全部通过就算完成。不要引入任何依赖，不要建 package.json 以外的配置。',
].join('\n');

let fail = 0;
const ok = (n, c, d = '') => { console.log(`${c ? '✅' : '❌'} ${n} ${c ? '' : d}`); if (!c) fail++; };
const s = io('http://127.0.0.1:3928', { transports: ['websocket'] });
await new Promise((r) => s.on('connect', r));
const call = (ev, d, ms = 60000) => new Promise((r) => { const t = setTimeout(() => r({ ok: false, error: '超时' }), ms); s.emit(ev, d, (x) => { clearTimeout(t); r(x); }); });
const events = [];
let injected = false, taskId = null, entryId = null;
s.on('longrun:event', (ev) => {
  events.push(ev);
  if (ev.kind === 'send' || ev.kind === 'result' || ev.kind === 'inject.applied' || ev.kind === 'exec.inject.sent') console.log(`   · ${ev.kind} ${ev.label || ev.exit_reason || ev.text || ''}`.slice(0, 160));
  // 主线第一发里出现工具调用就插一句话（只插一次）
  if (!injected && taskId && ev.kind === 'exec.tool' && events.some((e) => e.kind === 'send' && /需求|继续完成项目/.test(e.label || ''))) {
    injected = true;
    call('longrun:inject', { taskId, text: '补充一条：sum.js 顶部加一行注释「// 由长程 E2E 生成」。' });
  }
});
try {
  const r = await call('longrun:start', { projectName: NAME, requirementText: REQ, mode: 'start', executor: 'cursor', maxLegs: 12, noAsk: true });
  if (!r.ok) throw new Error(`启动失败：${r.error}`);
  taskId = r.task.id;
  entryId = r.task.sessionId || null;
  ok('自检里写明执行者是 Cursor', JSON.stringify(r.task.selfCheck || []).includes('Cursor CLI'), JSON.stringify(r.task.selfCheck).slice(0, 300));
  const done = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 25 * 60 * 1000);
    s.on('longrun:event', (ev) => { if (ev.kind === 'finished') { clearTimeout(t); resolve(ev); } });
  });
  ok('长程正常收工', done && /project_done|PROJECT_DONE|done/i.test(JSON.stringify(done)), JSON.stringify(done).slice(0, 400));
  ok('记忆库建在 .memory/（改写后的提示词它照做了）', fs.existsSync(path.join(ROOT, '.memory', 'MEMORY.md')));
  ok('插话发出且被执行者收到', injected && events.some((e) => e.kind === 'inject.applied')
    && /由长程 E2E 生成/.test(fs.readFileSync(path.join(ROOT, 'sum.js'), 'utf8')));
  let testOut = '';
  try { testOut = execFileSync('node', ['--test'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { testOut = `失败：${e.stdout || e.message}`; }
  // Node 24 默认报告器是 spec 格式（ℹ pass 3 / ℹ fail 0），老版本是 TAP（# pass 3 / # fail 0），两种都认
  ok('交付物：node --test 真能跑过', /[#ℹ] fail 0/.test(testOut) && /[#ℹ] pass [1-9]/.test(testOut), testOut.slice(-400));
  const results = events.filter((e) => e.kind === 'result');
  ok('每发都续同一段 Cursor 对话或按交接开新对话，费用记 $0（订阅）', results.length > 0 && results.every((e) => e.cost_usd === 0),
    JSON.stringify(results.map((e) => [e.label, e.exit_reason, e.cost_usd])));
  console.log(`   共 ${results.length} 发：${results.map((e) => `${e.label}→${e.exit_reason}`).join('，')}`);
} catch (e) {
  fail++; console.log(`❌ ${e.message}`);
} finally {
  if (taskId) await call('longrun:stop', { taskId, reason: 'E2E 结束' }, 10000);
  // 长程开跑时为这个目录建的会话条目（只删测试自己的：目录名是测试专用的）
  if (entryId) s.emit('session:delete', entryId);
  await new Promise((r) => setTimeout(r, 2000));
  s.close();
  console.log(`\n项目留在 ${ROOT} 供查看（确认后可手动删除）`);
  console.log(`=== ${fail ? `${fail} 项失败` : '全部通过'} ===`);
  process.exit(fail ? 1 : 0);
}

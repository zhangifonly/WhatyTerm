/**
 * 长程 + 非 Claude 执行者 E2E：真服务 + 真 CLI + 真监督者（会花一点钱 / credits）。
 * 场景：新建长程项目，选执行者，需求是一个小 JS 模块 + 测试 →
 *      自检里写明执行者 → 开场初始化记忆库（.memory/MEMORY.md 被建出来，说明改写后的提示词它照做了）→
 *      主线干活期间插一句话 → 插话在工具间隙生效、续同一段对话发进去 → 项目做完，测试真能跑过 → 计费口径对。
 * 运行：node scripts/e2e-longrun-executor.mjs cursor | kiro | opencode [CC Switch 的 Claude 供应商 id（opencode 必填）]
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { sandboxBase } from '../server/services/LongRunLaunch.js';

const { io } = await import(path.resolve('node_modules/socket.io-client/build/esm-debug/index.js'));
const EXECUTOR = process.argv[2] || 'cursor';
const PROVIDER = process.argv[3] || '';
const LABEL = { cursor: 'Cursor CLI', kiro: 'Kiro CLI', opencode: 'OpenCode' }[EXECUTOR];
if (!LABEL) throw new Error(`不认识的执行者：${EXECUTOR}`);
if (EXECUTOR === 'opencode' && !PROVIDER) throw new Error('opencode 要给一个 CC Switch 的第三方 Claude 供应商 id');
const NAME = `wtlr${EXECUTOR}e2e`;
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
  const r = await call('longrun:start', { projectName: NAME, requirementText: REQ, mode: 'start', executor: EXECUTOR, providerId: PROVIDER || undefined, maxLegs: 12, noAsk: true }, 120000);
  if (!r.ok) throw new Error(`启动失败：${r.error}`);
  taskId = r.task.id;
  entryId = r.task.sessionId || null;
  ok(`监督者也用 ${LABEL}`, r.task.supervisor?.cli === EXECUTOR, JSON.stringify(r.task.supervisor));
  ok(`自检里写明执行者是 ${LABEL}`, JSON.stringify(r.task.selfCheck || []).includes(LABEL), JSON.stringify(r.task.selfCheck).slice(0, 300));
  const done = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 25 * 60 * 1000);
    s.on('longrun:event', (ev) => { if (ev.kind === 'finished') { clearTimeout(t); resolve(ev); } });
  });
  // 监督者真被调用过：收工判定写在 loop.log 里
  ok('监督者给出了判定', /监督者: 判定/.test(fs.readFileSync(path.join(ROOT, '.run', 'loop.log'), 'utf8')));
  ok('长程正常收工', done && /project_done|PROJECT_DONE|done/i.test(JSON.stringify(done)), JSON.stringify(done).slice(0, 400));
  ok('记忆库建在 .memory/（改写后的提示词它照做了）', fs.existsSync(path.join(ROOT, '.memory', 'MEMORY.md')));
  ok('插话发出且被执行者收到', injected && events.some((e) => e.kind === 'inject.applied')
    && /由长程 E2E 生成/.test(fs.readFileSync(path.join(ROOT, 'sum.js'), 'utf8')));
  let testOut = '';
  try { testOut = execFileSync('node', ['--test'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { testOut = `失败：${e.stdout || e.message}`; }
  // Node 24 默认报告器是 spec 格式（ℹ pass 3 / ℹ fail 0），老版本是 TAP（# pass 3 / # fail 0），两种都认
  ok('交付物：node --test 真能跑过', /[#ℹ] fail 0/.test(testOut) && /[#ℹ] pass [1-9]/.test(testOut), testOut.slice(-400));
  const results = events.filter((e) => e.kind === 'result');
  // 计费口径：Cursor 订阅不记钱；Kiro 不记美元但有 credits；OpenCode 按价格表估算美元
  const billing = {
    cursor: ['费用记 $0（订阅）', results.length > 0 && results.every((e) => e.cost_usd === 0)],
    kiro: ['美元记 0、credits 如实记下', results.length > 0 && results.every((e) => e.cost_usd === 0) && results.some((e) => e.credits > 0)],
    opencode: ['按价格表估算美元', results.some((e) => e.cost_usd > 0)],
  }[EXECUTOR];
  ok(billing[0], billing[1], JSON.stringify(results.map((e) => [e.label, e.exit_reason, e.cost_usd, e.credits])));
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

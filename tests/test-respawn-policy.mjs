/**
 * Electron 内置服务异常退出后自动重拉：退避、快速失败熔断、主动停止不重拉。
 *
 * 运行: node tests/test-respawn-policy.mjs
 */

import fs from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { RespawnPolicy } = require('../electron/respawnPolicy.cjs');

let pass = 0, fail = 0;
const test = (name, fn) => { try { fn(); pass++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n    ${e.message}`); } };
const assert = (c, m) => { if (!c) throw new Error(m || '断言失败'); };

/** 模拟：起 → 跑 ran 毫秒 → 异常退出，返回决定 */
function crash(p, t, ran) { p.onStart(t.now); t.now += ran; return p.onExit(t.now, {}); }

test('主动停止（退出应用 / stopServer）不重拉', () => {
  const p = new RespawnPolicy();
  p.onStart(0);
  assert(p.onExit(60_000, { stopping: true }).action === 'none');
});

test('跑了很久后异常退出：1 秒后重拉；一直跑得住就一直 1 秒（退避归零）', () => {
  const p = new RespawnPolicy(); const t = { now: 0 };
  for (let i = 0; i < 6; i++) {
    const d = crash(p, t, 3_600_000);
    assert(d.action === 'restart' && d.delayMs === 1000, JSON.stringify(d));
  }
});

test('连续快速失败：退避 1→2→4→8 秒，第 5 次放弃并说明原因（不无限重拉）', () => {
  const p = new RespawnPolicy(); const t = { now: 0 };
  const delays = [];
  let d;
  for (let i = 0; i < 5; i++) { d = crash(p, t, 2000); if (d.action === 'restart') delays.push(d.delayMs); }
  assert(delays.join() === '1000,2000,4000,8000', delays.join());
  assert(d.action === 'giveup' && /连续 5 次/.test(d.reason), JSON.stringify(d));
});

test('退避封顶 30 秒；中间有一次跑稳了，快速失败计数清零', () => {
  const p = new RespawnPolicy({ maxFastFails: 100 }); const t = { now: 0 };
  let d;
  for (let i = 0; i < 10; i++) d = crash(p, t, 1000);
  assert(d.delayMs === 30_000, `没封顶：${d.delayMs}`);
  const q = new RespawnPolicy(); const u = { now: 0 };
  for (let i = 0; i < 4; i++) crash(q, u, 1000);
  crash(q, u, 60_000);                                   // 跑稳一次
  for (let i = 0; i < 4; i++) d = crash(q, u, 1000);
  assert(d.action === 'restart', '跑稳过一次后又从头计快速失败，不该这么快放弃');
});

const MAIN = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
test('接线：close 时按策略重拉；stopServer 先置主动停止并取消待重拉；重拉前再次确认没在停止', () => {
  const close = MAIN.slice(MAIN.indexOf("proc.on('close'"), MAIN.indexOf("serverProcess.on('error'"));
  assert(/respawnPolicy\.onExit\(Date\.now\(\), \{ stopping: serverStopping \}\)/.test(close), 'close 没走重拉策略');
  assert(/setTimeout\(\(\) => \{ if \(!serverStopping\) startServer\(\); \}, decision\.delayMs\)/.test(close), '重拉前没再确认');
  assert(/dialog\.showErrorBox/.test(close), '放弃时没告诉用户');
  const stop = MAIN.slice(MAIN.indexOf('function stopServer()'), MAIN.indexOf('function stopServer()') + 200);
  assert(/serverStopping = true;[\s\S]*clearTimeout\(respawnTimer\)/.test(stop), 'stopServer 没标记主动停止');
  const start = MAIN.slice(MAIN.indexOf('function startServer()'), MAIN.indexOf('function stopServer()'));
  assert(/serverStopping = false;\s*respawnPolicy\.onStart\(Date\.now\(\)\)/.test(start), 'startServer 没复位/记启动时刻');
});

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);

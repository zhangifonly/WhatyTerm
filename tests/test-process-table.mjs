/**
 * 进程表快照与 ps 限流 —— 回归测试
 *
 * 现场（2026-09-17）：macOS 的 ps 串行执行，启动时 35 个会话同时 ps，全部撞 3 秒超时，
 * 读不到任何会话的 claude 进程环境变量（日志 32 条 "readClaudeProcessEnv 失败"）。
 *
 * 运行: node tests/test-process-table.mjs
 */

import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import { parseProcessTable, paneProcesses, createProcessSnapshot, createLimiter } from '../server/services/processTable.js';

const execAsync = promisify(exec);
const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
async function test(name, fn) {
  try { await fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await test('解析进程表：路径里带空格的 comm 完整保留，坏行跳过', () => {
  const rows = parseProcessTable('  10  1 10 /Applications/Some App.app/claude\nbad\n 11 10 10 zsh\n');
  assert(rows.length === 2 && rows[0].comm === '/Applications/Some App.app/claude' && rows[1].ppid === 10);
});

await test('pane 下的进程 = 自身 + 直接子进程 + 同进程组（与 pgrep -P / pgrep -g 一致，不递归）', () => {
  const rows = parseProcessTable([
    '200 1 200 zsh', '201 200 201 claude', '202 201 201 node', '203 1 200 bg-in-group', '204 202 204 grandchild', '300 1 300 other',
  ].join('\n'));
  const got = paneProcesses(rows, '200').map((r) => r.pid);
  assert(JSON.stringify(got) === '[200,201,203]', `实际 ${JSON.stringify(got)}`);
});

await test('与真实 pgrep 对拍：本机每个 tmux pane 的候选进程集合一致', async () => {
  let panes = [];
  try { panes = execSync('tmux list-panes -a -F "#{pane_pid}"', { encoding: 'utf8' }).trim().split('\n').filter(Boolean).slice(0, 8); } catch { /* 没有 tmux */ }
  if (!panes.length) { console.log('   ⊘ 本机没有 tmux 会话'); return; }
  const rows = parseProcessTable(execSync('ps -Ao pid=,ppid=,pgid=,comm=', { encoding: 'utf8', maxBuffer: 1 << 24 }));
  for (const pane of panes) {
    const viaPgrep = new Set([pane, ...execSync(`{ pgrep -P ${pane}; pgrep -g ${pane}; } 2>/dev/null || true`, { encoding: 'utf8', shell: '/bin/bash' })
      .trim().split('\n').filter(Boolean)].map(Number));
    const viaTable = new Set(paneProcesses(rows, pane).map((r) => r.pid));
    // 两次取样之间可能有进程起落，只比较两边都还活着的
    const liveNow = new Set(parseProcessTable(execSync('ps -Ao pid=,ppid=,pgid=,comm=', { encoding: 'utf8', maxBuffer: 1 << 24 })).map((r) => r.pid));
    const a = [...viaPgrep].filter((p) => liveNow.has(p)).sort().join(',');
    const b = [...viaTable].filter((p) => liveNow.has(p)).sort().join(',');
    assert(a === b, `pane ${pane}: pgrep=${a} 进程表=${b}`);
  }
});

await test('快照 single-flight：并发调用只跑一次 ps，ttl 内复用，过期后重取', async () => {
  let runs = 0;
  const snap = createProcessSnapshot(async () => { runs += 1; await sleep(50); return '1 0 1 launchd'; }, 100);
  const all = await Promise.all(Array.from({ length: 35 }, () => snap()));
  assert(runs === 1 && all.every((r) => r.length === 1), `并发 35 次应只跑 1 次，实际 ${runs}`);
  await snap();
  assert(runs === 1, 'ttl 内应复用');
  await sleep(120);
  await snap();
  assert(runs === 2, '过期后应重取');
});

await test('限流：同时最多 n 个在跑，排队的按顺序执行，异常不卡住队列', async () => {
  const limit = createLimiter(2);
  let active = 0, peak = 0;
  const order = [];
  const job = (i, fail) => limit(async () => {
    active += 1; peak = Math.max(peak, active);
    await sleep(20);
    active -= 1; order.push(i);
    if (fail) throw new Error('x');
    return i;
  });
  const res = await Promise.allSettled([job(0), job(1, true), job(2), job(3), job(4)]);
  assert(peak === 2, `峰值并发应为 2，实际 ${peak}`);
  assert(res[1].status === 'rejected' && res[4].value === 4 && order.length === 5, '失败的任务不能卡住后面的');
});

await test('复现启动现场：35 个调用方同时要进程表并各读一次环境变量，3 秒超时下全部成功', async () => {
  if (process.platform === 'win32') return;
  const snap = createProcessSnapshot(async () => (await execAsync('ps -Ao pid=,ppid=,pgid=,comm=', { timeout: 10000, maxBuffer: 1 << 24 })).stdout);
  const limit = createLimiter(2);
  const t0 = Date.now();
  const res = await Promise.allSettled(Array.from({ length: 35 }, async () => {
    const rows = await snap();
    assert(rows.length > 10, '进程表为空');
    return limit(() => execAsync(`ps eww -p ${process.pid} 2>/dev/null || true`, { timeout: 3000, maxBuffer: 4 << 20 }));
  }));
  const failed = res.filter((r) => r.status === 'rejected');
  assert(!failed.length, `${failed.length}/35 失败: ${failed[0]?.reason?.message}`);
  console.log(`   35 路共耗时 ${Date.now() - t0}ms`);
});

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

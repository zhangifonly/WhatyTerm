/**
 * 长程编排：进程连坐 —— 真进程实测
 *
 * 原版实测过不连坐的后果：编排器被强杀后执行者又无人监管跑了 30 分钟。
 * 这里用真进程验证：假"WebTmux"被 kill -9 后，执行者整个进程组（含它起的孙进程）
 * 在几秒内被看门进程带走；而 WebTmux 活着时执行者不受影响。
 *
 * 运行: node tests/test-longrun-jobguard.mjs
 */

import { spawn } from 'child_process';
import { available, adoptProcessGroup, killProcessGroup, report } from '../server/services/LongRunJobGuard.js';

const results = { passed: 0, failed: 0, errors: [] };
const pending = [];
function test(name, fn) {
  const p = (async () => {
    try { await fn(); results.passed++; console.log(`✅ ${name}`); }
    catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
  })();
  pending.push(p);
  return p;
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** 造一个执行者：自成进程组，带一个孙进程（模拟它起的 dev server） */
function fakeExecutor() {
  const p = spawn('sh', ['-c', 'sleep 300 & echo $!; wait'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  return new Promise((resolve) => {
    p.stdout.once('data', (b) => resolve({ proc: p, grandchild: Number(String(b).trim()) }));
  });
}
/** 造一个假 WebTmux：只是一个活着的进程 */
function fakeServer() {
  return spawn(process.execPath, ['-e', 'setInterval(()=>{},1e6)'], { stdio: 'ignore' });
}

if (!available()) {
  console.log(`⊘ 本平台不支持进程组连坐：${report()}`);
  process.exit(0);
}

test('WebTmux 被 kill -9 后，执行者整组（含孙进程）被带走', async () => {
  const server = fakeServer();
  const { proc, grandchild } = await fakeExecutor();
  try {
    assert(adoptProcessGroup(proc, server.pid), '应托管成功');
    await sleep(1500);
    assert(alive(proc.pid) && alive(grandchild), 'WebTmux 活着时执行者不该被动');
    process.kill(server.pid, 'SIGKILL');
    let gone = false;
    for (let i = 0; i < 80 && !gone; i++) {           // 最多 8 秒
      await sleep(100);
      gone = !alive(proc.pid) && !alive(grandchild);
    }
    assert(gone, `8 秒内执行者未被连坐：主进程 ${alive(proc.pid) ? '还在' : '已退'}，孙进程 ${alive(grandchild) ? '还在' : '已退'}`);
  } finally {
    killProcessGroup(proc, 'SIGKILL');
    try { process.kill(server.pid, 'SIGKILL'); } catch { /* 已退 */ }
  }
});

test('执行者自己退出后，看门进程也退（不堆积）', async () => {
  const server = fakeServer();
  const { proc } = await fakeExecutor();
  try {
    const before = Date.now();
    adoptProcessGroup(proc, server.pid);
    await sleep(300);
    killProcessGroup(proc, 'SIGKILL');
    // 看门进程每秒采样一次，发现整组不在就自行退出；它是 detached 的，找它的 pid 要靠 ps
    await sleep(2500);
    const { execSync } = await import('child_process');
    const leftover = execSync(`ps -Ao pid,command | grep longrun-jobguard-watch | grep " ${proc.pid}$" | grep -v grep || true`)
      .toString().trim();
    assert(!leftover, `看门进程没退: ${leftover}（${Date.now() - before}ms）`);
  } finally {
    try { process.kill(server.pid, 'SIGKILL'); } catch { /* 已退 */ }
  }
});

test('killProcessGroup 连孙进程一起杀（只杀主进程会留下孤儿）', async () => {
  const { proc, grandchild } = await fakeExecutor();
  killProcessGroup(proc, 'SIGKILL');
  await sleep(300);
  assert(!alive(grandchild), '孙进程应随进程组一起被杀');
});

await Promise.all(pending);
console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

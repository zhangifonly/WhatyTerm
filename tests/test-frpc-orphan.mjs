/**
 * FRP 隧道：孤儿 frpc 清理 —— 回归测试
 *
 * 现场（2026-09-17）：服务收到 SIGTERM 直接退出，frpc 被 launchd 收养继续占着隧道名，
 * 重启后新 frpc 每 30 秒报一次 "proxy already exists"。
 * 这里锁两件事：只杀"同一份配置 + 父进程是 launchd"的孤儿；活着的实例的 frpc 一个都不能碰。
 *
 * 运行: node tests/test-frpc-orphan.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import frpTunnel, { findOrphanFrpc } from '../server/services/FrpTunnel.js';

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
async function test(name, fn) {
  try { await fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

await test('识别规则：同一配置 + ppid=1 才算孤儿；别的配置、活父进程、同名非 frpc 都不算', () => {
  const CFG = '/Users/x/.webtmux/frpc.toml';
  const ps = [
    `  101     1 /app/server/bin/darwin/frpc -c ${CFG}`,           // 孤儿 ✓
    `  102  4242 /app/server/bin/darwin/frpc -c ${CFG}`,           // 活实例的子进程 ✗
    `  103     1 /app/server/bin/darwin/frpc -c /other/frpc.toml`, // 别的配置 ✗
    `  104     1 /bin/zsh -c grep frpc -c ${CFG}`,                  // 命令行里提到 frpc 的 shell ✗
    `  105     1 frpc -c ${CFG}`,                                   // 裸名 ✓
    `  106     1 /app/frpc-helper -c ${CFG}`,                       // 名字只是以 frpc 开头 ✗
    'garbage line',
  ].join('\n');
  const got = findOrphanFrpc(ps, CFG);
  assert(JSON.stringify(got) === '[101,105]', `实际 ${JSON.stringify(got)}`);
  assert(findOrphanFrpc('', CFG).length === 0 && findOrphanFrpc(ps, '').length === 0);
});

await test('真进程：孤儿被结束，活实例的 frpc 不受影响', async () => {
  if (process.platform === 'win32') { console.log('   ⊘ Windows 不走 frpc 进程'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frpc_orphan_'));
  const fake = path.join(dir, 'frpc');
  const cfg = path.join(dir, 'frpc.toml');
  const keep = path.join(dir, 'keep.js');
  fs.writeFileSync(cfg, '');
  fs.writeFileSync(keep, 'setInterval(() => {}, 1 << 30);\n');
  // 用 argv0 让 ps 里显示成「<dir>/frpc keep.js -c <cfg>」。⚠ 不能用 shell 脚本 exec sleep：exec 会替换进程映像，ps 里只剩 sleep
  const launch = path.join(dir, 'launch.js');
  fs.writeFileSync(launch, `const c = require('child_process').spawn(process.execPath, [${JSON.stringify(keep)}, '-c', ${JSON.stringify(cfg)}],
    { argv0: ${JSON.stringify(fake)}, detached: true, stdio: 'ignore' }); console.log(c.pid); c.unref();\n`);
  // 孤儿：中间进程起了它就退出，它被 launchd 收养
  const orphan = Number(spawnSync(process.execPath, [launch], { encoding: 'utf8' }).stdout.trim());
  // 活实例的子进程：父进程就是本测试进程
  const kept = spawn(process.execPath, [keep, '-c', cfg], { argv0: fake, stdio: 'ignore' });
  try {
    await sleep(300);
    const ppid = spawnSync('/bin/ps', ['-o', 'ppid=', '-p', String(orphan)], { encoding: 'utf8' }).stdout.trim();
    assert(ppid === '1', `孤儿没造出来，ppid=${ppid}`);
    const saved = frpTunnel.configPath;
    frpTunnel.configPath = cfg;
    let killed;
    try { killed = await frpTunnel.killOrphanFrpc(); } finally { frpTunnel.configPath = saved; }
    await sleep(200);
    assert(killed.includes(orphan) && !alive(orphan), `孤儿应被结束: killed=${killed} alive=${alive(orphan)}`);
    assert(!killed.includes(kept.pid) && alive(kept.pid), '活实例的 frpc 不能碰');
  } finally {
    try { process.kill(orphan, 'SIGKILL'); } catch { /* 已退出 */ }
    kept.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test('退出信号处理会先结束 frpc 子进程（源码守卫：三个信号都走同一个处理函数）', () => {
  const src = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  const fn = src.match(/function shutdownOnSignal\(sig\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert(/frpTunnel\?\.killChildSync\?\.\(\)/.test(fn) && fn.indexOf('killChildSync') < fn.indexOf('process.exit'), '结束 frpc 必须在 process.exit 之前');
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    assert(src.includes(`process.on('${sig}', () => shutdownOnSignal('${sig}'));`), `${sig} 没走 shutdownOnSignal`);
  }
});

await test('启动 frpc 前先清孤儿（源码守卫：kill -9 与崩溃跑不到信号处理，只能靠这里兜底）', () => {
  const src = fs.readFileSync(new URL('../server/services/FrpTunnel.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('async _startFrpcProcess('));
  const call = body.indexOf('await this.killOrphanFrpc()');
  assert(call > 0 && call < body.indexOf('spawn(frpcPath'), '必须在 spawn frpc 之前 await 清理');
});

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
// FrpTunnel 的依赖在导入时会挂定时器，显式退出
process.exit(results.failed ? 1 : 0);

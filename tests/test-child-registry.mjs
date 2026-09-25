/**
 * 服务异常退出后，下次启动清理它留下的孤儿子进程 —— 只清确认是自己的。
 *
 * 由来（2026-09-26 00:37）：服务被 SIGKILL（退出钩子跑不到），留下一个 `caffeinate -dis` 让 Mac 永不休眠。
 * 同时每个 Claude CLI 自己也开着 `caffeinate -i -t 300` —— 按命令名清理会误杀它们。
 *
 * 运行: node tests/test-child-registry.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { ChildRegistry, classifyRecorded, psInfo, START_TOLERANCE_MS } from '../server/services/ChildRegistry.js';

let pass = 0, fail = 0;
const queue = [];
const test = (name, fn) => queue.push([name, fn]);
const assert = (c, m) => { if (!c) throw new Error(m || '断言失败'); };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'childreg-'));
let n = 0;
const file = () => path.join(TMP, `s${n++}.json`);

const REC = { pid: 17216, kind: 'caffeinate', match: 'caffeinate -dis', startedAt: 1_000_000 };
test('判定：进程没了 → gone；命令和启动时间都对 → ours；任一不对 → reused（PID 被复用给了别人）', () => {
  assert(classifyRecorded(REC, null) === 'gone');
  assert(classifyRecorded(REC, { command: 'caffeinate -dis -w 99', startedAt: 1_000_000 + 999 }) === 'ours');
  assert(classifyRecorded(REC, { command: 'caffeinate -i -t 300', startedAt: 1_000_000 }) === 'reused', 'Claude CLI 的 caffeinate 被当成我们的');
  assert(classifyRecorded(REC, { command: 'caffeinate -dis', startedAt: 1_000_000 + START_TOLERANCE_MS + 1000 }) === 'reused',
    'PID 复用：同名命令但启动时间不对，也不能杀');
});

/** 写一份「上一个服务」的登记文件 */
function prevFile(state) { const f = file(); fs.writeFileSync(f, JSON.stringify(state)); return f; }
const PREV = { pid: 4242, startedAt: 500_000, cleanExit: false, children: [
  REC,
  { pid: 20001, kind: 'frpc', match: '/x/frpc.toml', startedAt: 600_000 },
  { pid: 20002, kind: 'cloudflared', match: '--url http://localhost:3928', startedAt: 700_000 },
] };

function registry(f, liveList) {
  const killed = [];
  const live = new Map(liveList.map((l) => [l.pid, l]));
  const r = new ChildRegistry({ file: f, ps: (pids) => new Map(pids.filter((p) => live.has(p)).map((p) => [p, live.get(p)])),
    kill: (pid, sig) => killed.push([pid, sig]) });
  return { r, killed };
}

test('上次异常退出：只杀对得上的遗留进程，PID 被复用的不动', () => {
  const f = prevFile(PREV);
  const { r, killed } = registry(f, [
    { pid: 17216, command: 'caffeinate -dis', startedAt: 1_000_500 },                  // 我们的孤儿
    { pid: 20001, command: 'vim notes.txt', startedAt: 600_000 },                      // PID 被复用
    // 20002 已经不在了
  ]);
  const rep = r.recoverAtStartup();
  assert(rep.abnormal && rep.prevPid === 4242, JSON.stringify(rep));
  assert(JSON.stringify(killed) === JSON.stringify([[17216, 'SIGTERM']]), `杀了：${JSON.stringify(killed)}`);
  assert(rep.cleaned.map((c) => c.kind).join() === 'caffeinate');
  const now = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert(now.pid === process.pid && now.children.length === 0 && now.cleanExit === false, '没换成本次的登记');
});

test('上次正常退出 → 什么都不杀', () => {
  const { r, killed } = registry(prevFile({ ...PREV, cleanExit: true }), [{ pid: 17216, command: 'caffeinate -dis', startedAt: 1_000_000 }]);
  const rep = r.recoverAtStartup();
  assert(!rep.abnormal && killed.length === 0, JSON.stringify({ rep, killed }));
});

test('上一个服务其实还活着（重复启动）→ 一个都不动，也不覆盖它的登记', () => {
  const f = prevFile(PREV);
  const { r, killed } = registry(f, [
    { pid: 4242, command: 'node server/index.js', startedAt: 500_000 },
    { pid: 17216, command: 'caffeinate -dis', startedAt: 1_000_000 },
  ]);
  const rep = r.recoverAtStartup();
  assert(!rep.abnormal && rep.skipped && killed.length === 0, JSON.stringify({ rep, killed }));
  r.track({ pid: 1, once() {} }, 'x', 'x');
  assert(JSON.parse(fs.readFileSync(f, 'utf8')).pid === 4242, '重复启动的实例覆盖了正在运行那个的登记');
});

test('登记与注销：子进程退出后自动从表里删掉；正常退出标记 cleanExit', async () => {
  const f = file();
  const r = new ChildRegistry({ file: f });
  r.recoverAtStartup();
  const p = r.track(spawn('sleep', ['30']), 'sleep', 'sleep 30');
  assert(JSON.parse(fs.readFileSync(f, 'utf8')).children.some((c) => c.pid === p.pid), '没登记');
  p.kill();
  await new Promise((res) => p.once('exit', res));
  await new Promise((res) => setTimeout(res, 20));
  assert(JSON.parse(fs.readFileSync(f, 'utf8')).children.length === 0, '退出后没注销');
  r.markCleanExit();
  assert(JSON.parse(fs.readFileSync(f, 'utf8')).cleanExit === true);
});

test('真实 ps：能读出进程的启动时间与命令（本机 ps 默认中文日期，必须 LC_ALL=C）', () => {
  const me = psInfo([process.pid]).get(process.pid);
  assert(me && /node/.test(me.command), JSON.stringify(me));
  const realStart = Date.now() - process.uptime() * 1000;
  assert(Math.abs(me.startedAt - realStart) <= START_TOLERANCE_MS, `解析出的启动时间偏差太大：${me.startedAt} vs ${realStart}`);
  // 列表里混一个不存在的 pid（恢复时上一个服务的 pid 必然已死）：存活的那个照样要查得到
  assert(psInfo([999999, process.pid]).get(process.pid), 'macOS ps -p 遇到不存在的 pid 整条不输出 —— 又退回 -p 了？');
});

test('端到端：真起一个子进程登记后「服务被强杀」，下个实例把它清掉', async () => {
  const f = file();
  const a = new ChildRegistry({ file: f });
  a.recoverAtStartup();
  const child = a.track(spawn('sleep', ['60'], { detached: true, stdio: 'ignore' }), 'sleep', 'sleep 60');
  child.unref();
  // 模拟上一个服务已死：把登记里的服务 pid 换成一个不存在的
  const st = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(f, JSON.stringify({ ...st, pid: 999999 }));
  const rep = new ChildRegistry({ file: f }).recoverAtStartup();
  await new Promise((res) => setTimeout(res, 300));
  let alive = true; try { process.kill(child.pid, 0); } catch { alive = false; }
  assert(rep.cleaned.some((c) => c.pid === child.pid) && !alive, `没清掉：${JSON.stringify(rep)} alive=${alive}`);
});

test('登记的服务启动时间是进程真实启动时间，不是模块加载时刻（负载高时两者差过容差，会误判活着的服务已死）', async () => {
  // 等进程跑满容差之后再构造，模块加载时刻与真实启动时间才拉得开
  const need = START_TOLERANCE_MS / 1000 + 1.5;
  if (process.uptime() < need) await new Promise((res) => setTimeout(res, (need - process.uptime()) * 1000));
  const r = new ChildRegistry({ file: file() });
  const real = psInfo([process.pid]).get(process.pid).startedAt;
  assert(Math.abs(r.state.startedAt - real) <= START_TOLERANCE_MS, `记的 ${r.state.startedAt}，ps 看到 ${real}`);
});

const IDX = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
test('接线：恢复在任何 spawn 之前；信号退出标记干净；三类子进程都登记；caffeinate 随服务退出', () => {
  const at = IDX.indexOf('childRegistry.recoverAtStartup()');
  assert(at > 0 && at < IDX.indexOf('const app = express()'), '恢复不在最前面');
  assert(/function shutdownOnSignal[\s\S]{0,120}childRegistry\?\.markCleanExit\(\)/.test(IDX), '收到信号正常退出没标记，下次会误当异常');
  const src = (f) => fs.readFileSync(new URL(`../server/services/${f}`, import.meta.url), 'utf8');
  assert(/childRegistry\.track\(spawn\('caffeinate', \['-dis', '-w', String\(process\.pid\)\]/.test(src('SleepPreventionService.js')), 'caffeinate');
  assert(/childRegistry\.track\(spawn\(frpcPath/.test(src('FrpTunnel.js')), 'frpc 没登记');
  assert(/childRegistry\.track\(spawn\(cloudflaredPath/.test(src('CloudflareTunnel.js')), 'cloudflared 没登记');
});

for (const [name, fn] of queue) {
  try { await fn(); pass++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n    ${e.message}`); }
}
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);

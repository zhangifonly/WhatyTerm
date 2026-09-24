/**
 * FRP 选服务器：地址稳定优先。
 *
 * 由来（2026-09-24）：每次启动挑最快的，847ms 对 848ms 就让域名在 frp 与 frp-lax01 间翻，
 * 手机主屏幕图标与推送订阅绑在域名上，一翻就 404。
 *
 * 运行: node tests/test-frp-pick.mjs
 */

import fs from 'fs';
import { pickFrpServer, SLACK_MS } from '../server/services/frp/pickServer.js';

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function test(name, fn) {
  try { fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}
const R = (name, latency) => ({ server: { name }, latency });

test('上次那台仍可用：哪怕慢一点也继续用（实测 1ms 的差距曾让域名翻过去）', () => {
  const p = pickFrpServer([R('US-LAX02', 848), R('US-LAX01', 847)], 'US-LAX02');
  assert(p.server.name === 'US-LAX02' && p.reason === 'sticky', JSON.stringify(p));
  const q = pickFrpServer([R('US-LAX02', 1400), R('US-LAX01', 200)], 'US-LAX02');
  assert(q.server.name === 'US-LAX02', '慢 1.2 秒仍在容忍范围内，不该换');
});

test('上次那台不可用或慢得离谱才换，换就换最快的', () => {
  assert(pickFrpServer([R('A', 900), R('C', 300)], 'B').server.name === 'C', '上次的不在可用列表里');
  const p = pickFrpServer([R('A', 300 + SLACK_MS + 1), R('C', 300)], 'A');
  assert(p.server.name === 'C' && p.reason === 'fastest', JSON.stringify(p));
});

test('首次没有记录：按配置顺序取第一台可用的，不看延迟抖动', () => {
  const p = pickFrpServer([R('US-LAX02', 900), R('US-KC01', 100), R('US-LAX01', 50)], null);
  assert(p.server.name === 'US-LAX02' && p.reason === 'config-order', JSON.stringify(p));
});

test('隧道检测连续失败重连：避开当前那台（TCP 通不代表隧道通，不避开会永远粘回坏的）', () => {
  const p = pickFrpServer([R('US-LAX02', 100), R('US-LAX01', 900)], 'US-LAX02', { avoid: 'US-LAX02' });
  assert(p.server.name === 'US-LAX01' && p.reason === 'avoid', JSON.stringify(p));
  const only = pickFrpServer([R('US-LAX02', 100)], 'US-LAX02', { avoid: 'US-LAX02' });
  assert(only.server.name === 'US-LAX02', '只剩它一台可用时仍要连它，总比没隧道强');
});

test('全不可用返回 null；脏数据不炸', () => {
  assert(pickFrpServer([], 'A') === null && pickFrpServer(null, null) === null);
  assert(pickFrpServer([null, R('A', NaN), R('B', 10)], null).server.name === 'B');
});

test('接线：FrpTunnel 用 pickFrpServer 选、不再按延迟排序，并记下所选服务器', () => {
  const src = fs.readFileSync(new URL('../server/services/FrpTunnel.js', import.meta.url), 'utf8');
  const from = src.indexOf('async _selectFastestServer(');
  assert(from > 0, '找不到选服务器的函数 —— 锚点失效时必须报错，不能切出空串让后面的断言空过');
  const fn = src.slice(from, src.indexOf('_createConfig(server)', from));
  assert(/pickFrpServer\(available, lastName, \{ avoid \}\)/.test(fn), '没用共享的选择规则');
  assert(!/\.sort\(/.test(fn), '又按延迟排序了 —— 配置顺序会被打乱，首次选择又变成看抖动');
  assert(/writeFileSync\(FRP_LAST_SERVER_PATH/.test(fn), '没记下所选服务器，下次启动还会翻');
  // 检测失败重连那一处：avoid 必须在 stop() 之前取（stop 会清空 selectedServer），并传给 start
  const re = src.slice(src.indexOf('隧道连续 3 次检测失败'));
  const at = (t) => re.indexOf(t);
  assert(at('const failed = this.selectedServer?.name') > 0 && at('const failed') < at('this.stop()'),
    '当前服务器名要在 stop() 之前取，否则取到的是 null，等于没避开');
  assert(/this\.start\(null, \{ avoid: failed \}\)/.test(re), '检测失败重连没避开当前服务器');
});

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

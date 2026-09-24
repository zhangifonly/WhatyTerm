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

test('全不可用返回 null；脏数据不炸', () => {
  assert(pickFrpServer([], 'A') === null && pickFrpServer(null, null) === null);
  assert(pickFrpServer([null, R('A', NaN), R('B', 10)], null).server.name === 'B');
});

test('接线：FrpTunnel 用 pickFrpServer 选、不再按延迟排序，并记下所选服务器', () => {
  const src = fs.readFileSync(new URL('../server/services/FrpTunnel.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async _selectFastestServer()'), src.indexOf('_createConfig(server)'));
  assert(/pickFrpServer\(available, lastName\)/.test(fn), '没用共享的选择规则');
  assert(!/\.sort\(/.test(fn), '又按延迟排序了 —— 配置顺序会被打乱，首次选择又变成看抖动');
  assert(/writeFileSync\(FRP_LAST_SERVER_PATH/.test(fn), '没记下所选服务器，下次启动还会翻');
});

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

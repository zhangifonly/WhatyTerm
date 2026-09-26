/**
 * 左下角 📱（远程访问二维码）按钮不该因为备用隧道停掉而消失。
 *
 * 由来（2026-09-26）：付费用户启动时 FRP 与 Cloudflare 并行建立，FRP 成功就停掉 Cloudflare。
 * 服务端日志的真实顺序：FRP 已建立 → Cloudflare 已建立 → 使用 FRP → 停止 Cloudflare → Cloudflare 进程退出。
 * 退出时广播的 tunnel:disconnected 不带类型，前端一律清空地址 → 📱 消失（每次服务启动都会）。
 *
 * 运行: node tests/test-tunnel-state.mjs
 */

import fs from 'fs';
import { nextTunnelView, tunnelTypeOf } from '../src/utils/tunnelState.js';

let pass = 0, fail = 0;
const test = (name, fn) => { try { fn(); pass++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n    ${e.message}`); } };
const assert = (c, m) => { if (!c) throw new Error(m || '断言失败'); };

const FRP = 'https://webtmux-zhangzhen.frp.whaty.org';
const CF = 'https://albert-suit-deny-selecting.trycloudflare.com';
const run = (events, start = { url: '' }) => events.reduce((v, e) => nextTunnelView(v, e), start).url;

test('类型识别：trycloudflare.com 是 Cloudflare，其余是 FRP', () => {
  assert(tunnelTypeOf(CF) === 'cloudflare' && tunnelTypeOf(FRP) === 'frp' && tunnelTypeOf('') === '');
  assert(tunnelTypeOf('https://evil.com/?x=.trycloudflare.com') === 'frp', '路径里带字样不该算 Cloudflare');
});

test('启动真实顺序（新服务端，事件带 type）：FRP → CF 建立 → CF 停掉，最后显示 FRP', () => {
  assert(run([
    { kind: 'connected', url: FRP, type: 'frp' },
    { kind: 'connected', url: CF, type: 'cloudflare' },
    { kind: 'disconnected', type: 'cloudflare' },
  ]) === FRP);
});

test('旧服务端（Cloudflare 事件不带 type）同样不清掉 FRP；CF 先到 FRP 后到也显示 FRP', () => {
  assert(run([{ kind: 'connected', url: FRP }, { kind: 'connected', url: CF }, { kind: 'disconnected' }]) === FRP);
  assert(run([{ kind: 'connected', url: CF }, { kind: 'connected', url: FRP, type: 'frp' }, { kind: 'disconnected' }]) === FRP);
});

test('真断开要清：只有 Cloudflare 时它退出 → 清空；FRP 断开 → 清空；之后重连 → 恢复', () => {
  assert(run([{ kind: 'connected', url: CF, type: 'cloudflare' }, { kind: 'disconnected', type: 'cloudflare' }]) === '');
  assert(run([{ kind: 'disconnected', type: 'frp' }], { url: FRP }) === '');
  assert(run([{ kind: 'disconnected', type: 'frp' }, { kind: 'connected', url: FRP, type: 'frp' }], { url: FRP }) === FRP);
});

test('页面刷新时从接口拿到 FRP 地址（没有 type）后，Cloudflare 的迟到断开不影响它', () => {
  assert(run([{ kind: 'disconnected' }], { url: FRP }) === FRP);
});

const APP = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const CFT = fs.readFileSync(new URL('../server/services/CloudflareTunnel.js', import.meta.url), 'utf8');
test('接线：前端两个事件都走 nextTunnelView；Cloudflare 事件带 type；停止时只清自己存的地址', () => {
  assert(/socket\.on\('tunnel:disconnected', \(data\) => \{[\s\S]{0,200}nextTunnelView\(\{ url: cur \}, \{ kind: 'disconnected', type: data\?\.type \}\)/.test(APP), '断开事件还是无条件清空');
  assert(/socket\.on\('tunnel:connected', \(data\) => \{[\s\S]{0,200}nextTunnelView\(/.test(APP), '连接事件没走统一规则');
  assert(/emit\('tunnel:disconnected', \{ type: 'cloudflare' \}\)/.test(CFT) && /emit\('tunnel:connected', \{ url: this\.tunnelUrl, type: 'cloudflare' \}\)/.test(CFT), 'Cloudflare 事件没带类型');
  const stop = CFT.slice(CFT.indexOf('  stop() {'), CFT.indexOf('  getUrl() {'));
  assert(/this\._clearSavedUrlIfMine\(\)/.test(stop) && !/this\._saveTunnelUrl\(''\)/.test(stop), '停止时还会把 FRP 存的地址抹掉');
});

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);

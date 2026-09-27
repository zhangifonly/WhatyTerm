/**
 * 远程设备登录一次、7 天内免登录（服务重启也不丢）；桌面端可查看、可退出。
 *
 * 由来（2026-09-26）：express-session 默认存内存、签名密钥每次启动随机生成，服务一重启手机就要重新登录，
 * cookie 上写的 7 天形同虚设。今天服务重启了十几次，手机每次都得重新扫码。
 *
 * 运行: node tests/test-device-trust.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { DeviceTrust, DEVICE_TTL_MS, readCookie, describeDevice } from '../server/services/DeviceTrust.js';

let pass = 0, fail = 0;
const test = (name, fn) => { try { fn(); pass++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n    ${e.message}`); } };
const assert = (c, m) => { if (!c) throw new Error(m || '断言失败'); };
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'devtrust-')), 'devices.json');
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

test('登录发令牌；服务「重启」（新实例读同一文件）后凭令牌仍认得这台设备', () => {
  const f = tmp();
  const { token, device } = new DeviceTrust({ file: f }).issue({ ua: IPHONE, ip: '1.2.3.4', method: '扫码' });
  const after = new DeviceTrust({ file: f });
  assert(after.verify(token)?.id === device.id, '重启后不认了 —— 又要重新登录');
  assert(device.name === 'iPhone · Safari' && device.method === '扫码', JSON.stringify(device));
});

test('文件里只存令牌的哈希：看到文件也拿不到令牌；文件权限仅本人可读', () => {
  const f = tmp();
  const { token } = new DeviceTrust({ file: f }).issue({ ua: IPHONE });
  const raw = fs.readFileSync(f, 'utf8');
  assert(!raw.includes(token), '令牌明文落盘了');
  if (process.platform !== 'win32') assert((fs.statSync(f).mode & 0o777) === 0o600, '文件权限不是 600');
});

test('7 天到期：到期前认，到期后不认并自动清掉；使用不续期（一周校验一次）', () => {
  let now = 1_000_000;
  const t = new DeviceTrust({ file: tmp(), now: () => now });
  const { token } = t.issue({ ua: IPHONE });
  now += DEVICE_TTL_MS - 60_000;
  assert(t.verify(token), '到期前就不认了');
  now += 2 * 60_000;
  assert(!t.verify(token) && t.list().length === 0, '到期后还认，或没清掉');
});

test('桌面端退出某台设备：它立即失效，另一台不受影响；列表不带令牌哈希', () => {
  const t = new DeviceTrust({ file: tmp() });
  const a = t.issue({ ua: IPHONE, method: '扫码' });
  const b = t.issue({ ua: 'Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile', method: '密码' });
  assert(t.list().length === 2 && t.list().every((d) => !('tokenHash' in d)), '列表里带了令牌哈希');
  assert(t.revoke(a.device.id) && !t.verify(a.token) && t.verify(b.token), '退出一台影响了另一台，或没退掉');
  assert(!t.has(a.device.id) && t.has(b.device.id));
});

test('手机上点退出：按自己的令牌注销；错误令牌、空令牌都不认', () => {
  const t = new DeviceTrust({ file: tmp() });
  const a = t.issue({ ua: IPHONE });
  assert(!t.verify('forged') && !t.verify('') && t.revokeToken(a.token) && !t.verify(a.token));
});

test('读 Cookie 头；设备名识别常见手机浏览器', () => {
  assert(readCookie('a=1; wt_device=abc%2Fdef; b=2', 'wt_device') === 'abc/def' && readCookie('', 'x') === '');
  assert(describeDevice('Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile') === 'Android · Chrome');
  assert(describeDevice('Mozilla/5.0 (iPhone) MicroMessenger/8.0') === 'iPhone · 微信');
});

const IDX = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
test('接线：所有远程登录方式都发令牌；HTTP 与 socket 都凭令牌恢复、且都检查设备是否已被退出；管理接口只对本机', () => {
  for (const m of ['密码', '账号', '微信', '扫码']) assert(IDX.includes(`grantLogin(req, res, '${m}'`), `${m}登录没发设备令牌`);
  assert((IDX.match(/!deviceTrust\.has\(req\.session\.deviceId\)/g) || []).length === 2, 'HTTP 或 socket 没检查设备是否已被退出');
  assert(/io\.use\(\(socket, next\) => \{[\s\S]{0,1600}deviceTrust\.verify\(readCookie\(req\.headers\.cookie, DEVICE_COOKIE\)/.test(IDX), 'socket 连接不认设备令牌');
  for (const r of ["app.get('/api/auth/devices'", "app.post('/api/auth/devices/:id/revoke'"]) {
    const at = IDX.indexOf(r);
    assert(at > 0 && /if \(!isLocalRequest\(req\)\) return res\.status\(403\)/.test(IDX.slice(at, at + 200)), `${r} 没限制只能本机调用`);
  }
  assert(/s\.emit\('auth:revoked'\); s\.disconnect\(true\)/.test(IDX), '退出后没有断开它现有的连接');
});

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);

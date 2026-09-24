/**
 * 手机推送：前端开关 + 接线。纯逻辑跑真代码，接线处用行为或结构守卫。
 *
 * 运行: node tests/test-mobile-push.mjs
 */

import fs from 'fs';
import { pushSupport, keyToBytes } from '../src/mobile/usePush.js';
import { sessionFromUrl } from '../src/mobile/deepLink.js';
import { LongRunService } from '../server/services/LongRunService.js';

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function test(name, fn) {
  try { fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15';
const env = ({ ua = IPHONE, standalone = false, push = false } = {}) => ({
  navigator: { userAgent: ua, standalone, ...(push ? { serviceWorker: {} } : {}) },
  ...(push ? { PushManager: {}, Notification: {} } : {}),
  matchMedia: () => ({ matches: standalone }),
});

test('环境判定：iPhone 的 Safari 标签页里要提示「先加到主屏幕」，而不是笼统说不支持', () => {
  assert(pushSupport(env()) === 'needs-homescreen', pushSupport(env()));
  assert(pushSupport(env({ standalone: true, push: true })) === 'ok');
  assert(pushSupport(env({ ua: 'Android Chrome', push: true })) === 'ok');
  assert(pushSupport(env({ ua: 'Android 老浏览器' })) === 'unsupported');
  // iPad 新系统伪装成 Mac：靠触点数认出来
  const ipad = env({ ua: 'Macintosh' }); ipad.navigator.platform = 'MacIntel'; ipad.navigator.maxTouchPoints = 5;
  assert(pushSupport(ipad) === 'needs-homescreen', 'iPadOS 被当成电脑了');
});

test('公钥转换：base64url（无填充、-_）能还原出原字节', () => {
  const bytes = Uint8Array.from({ length: 65 }, (_, i) => (i * 37 + 250) % 256);
  const b64url = Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert(Buffer.from(keyToBytes(b64url)).equals(Buffer.from(bytes)), '还原出的字节不一致');
});

test('深链：?session= 能取到；没有或乱写返回 null', () => {
  assert(sessionFromUrl('/m/?session=abc%20d') === 'abc d');
  assert(sessionFromUrl('https://h.example/m/?x=1&session=s9') === 's9');
  assert(sessionFromUrl('/m/') === null && sessionFromUrl(undefined) === null);
});

test('广播：推送观察者出错不能打断广播（编排不能因为发通知失败而断）', () => {
  const emitted = [];
  const svc = new LongRunService({ io: { emit: (ev, j) => emitted.push([ev, j]) } });
  svc.onTask = () => { throw new Error('推送炸了'); };
  const origErr = console.error; console.error = () => {};
  try { svc._broadcast({ id: 't', toJSON: () => ({ id: 't', state: 'running' }) }); }
  finally { console.error = origErr; }
  assert(emitted.length === 1 && emitted[0][0] === 'longrun:task', '广播没发出去');
  let got = null;
  svc.onTask = (j, getBrief) => { got = { j, getBrief }; };
  svc._broadcast({ id: 't', toJSON: () => ({ id: 't', state: 'running' }) });
  assert(got?.j?.id === 't' && typeof got.getBrief === 'function', 'onTask 没收到摘要与惰性取快照函数');
});

const IDX = stripComments(read('../server/index.js'));
test('接线：推送路由挂在 /api 认证之后；公钥接口不吐私钥；观察者已挂到长程服务上', () => {
  const auth = IDX.indexOf("app.use('/api', authMiddleware)");
  const key = IDX.indexOf("app.get('/api/push/key'");
  assert(auth > 0 && key > auth, '推送路由在认证之前 —— 谁都能往这台电脑订阅');
  const keyRoute = IDX.slice(key, IDX.indexOf('});', key));
  assert(!/privateKey|vapid\(\)/.test(keyRoute), '公钥接口里碰了私钥');
  assert(/longRunService\.onTask = \(json, getBrief\) => longRunPush\.observe\(json, getBrief\)/.test(IDX), '观察者没挂上');
});

const SW = stripComments(read('../public/m-sw.js'));
test('SW：只做推送不做缓存；每条推送都弹通知（iOS 否则收回权限）；点击带会话跳转', () => {
  assert(!/addEventListener\('fetch'|caches\./.test(SW), 'SW 做了缓存 —— 手机会长期跑旧前端');
  const push = SW.slice(SW.indexOf("addEventListener('push'"), SW.indexOf("addEventListener('notificationclick'"));
  assert(/event\.waitUntil\(self\.registration\.showNotification\(/.test(push), '推送处理没无条件弹通知');
  assert(!/\bif\s*\(/.test(push), '推送处理里出现了条件分支 —— 可能有路径不弹通知');
  assert(/postMessage\(\{ type: 'open-url', url \}\)/.test(SW) && /openWindow\(url\)/.test(SW), '点通知跳不到会话');
});

test('开关：开启时第一个 await 就是请求通知权限（iOS 只认点击同步触发的权限请求）', () => {
  const src = stripComments(read('../src/mobile/usePush.js'));
  const body = src.slice(src.indexOf('const enable = useCallback'));
  const firstAwait = body.slice(body.indexOf('await'));
  assert(firstAwait.startsWith('await Notification.requestPermission()'), '开启流程里权限请求之前还有别的 await');
});

test('移动版：列表顶栏有提醒开关；收到 SW 的 open-url 会打开对应会话；冷启动不闪「会话不存在」', () => {
  const app = read('../src/mobile/MobileApp.jsx');
  assert(/<PushSettings \/>/.test(app), '没放提醒开关');
  assert(/e\.data\?\.type === 'open-url'/.test(app) && /go\(window\.location\.href\)/.test(app), '点通知进来不会打开会话');
  assert(/view === 'detail' && !sessionsData\.loaded/.test(app), '冷启动会先闪一下「会话不存在」');
  const panel = read('../src/mobile/PushSettings.jsx');
  assert(/添加到主屏幕/.test(panel) && /16\.4/.test(panel), 'iPhone 没说清要先加到主屏幕');
});

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

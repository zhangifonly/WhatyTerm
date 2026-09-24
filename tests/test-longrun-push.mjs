/**
 * 长程 → 手机推送。
 *
 * 由来（2026-09-24）：长程本就是你不在电脑前时跑的；它停下来等你、或收工时，
 * 不推给你就只能靠你自己隔一阵去看。只推这两件事，按「边沿」推一次，不按状态刷屏。
 *
 * 运行: node tests/test-longrun-push.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { longRunPushEdge, longRunPushState, longRunPushPayload, LongRunPushNotifier } from '../server/services/longrunPush.js';
import { PushService, hostOf } from '../server/services/PushService.js';

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
const queue = [];
function test(name, fn) { queue.push([name, fn]); }

/** 把一串任务摘要依次喂给边沿判定，返回每一步的结果 */
function edges(seq) {
  let prev;
  return seq.map((t) => { const e = longRunPushEdge(prev, t); prev = longRunPushState(t); return e; });
}
const T = (state, awaitingHuman = false, extra = {}) => ({ id: 'lr1', sandboxName: 'erp', sessionId: 's9', state, awaitingHuman, ...extra });

test('边沿：开始等你推一次，一直等着不重复推；答完后再次等你再推', () => {
  const out = edges([T('running'), T('running', true), T('running', true), T('running', true),
    T('running'), T('running'), T('running', true)]);
  assert(JSON.stringify(out) === JSON.stringify([null, 'waiting', null, null, null, null, 'waiting']), JSON.stringify(out));
});

test('边沿：在跑 → 收工推一次；首次就看到已收工的不推（列表刷新、重放不是新消息）', () => {
  assert(JSON.stringify(edges([T('running'), T('done'), T('done')])) === '[null,"finished",null]');
  assert(JSON.stringify(edges([T('done'), T('failed')])) === '[null,null]', '没见过它在跑，不该报收工');
});

test('边沿：收工后残留的 awaitingHuman 不算在等你（否则收工时会推两条且第一条是错的）', () => {
  assert(JSON.stringify(edges([T('running', true), T('failed', true)])) === '["waiting","finished"]');
  // 关键序列：之前没在等、收工那一刻标志残留 —— 必须报收工，不能误报成"在等你"
  assert(JSON.stringify(edges([T('running'), T('failed', true)])) === '[null,"finished"]',
    JSON.stringify(edges([T('running'), T('failed', true)])));
});

test('边沿：第一次看到就已在等你，要推（服务端刚起、任务刚挂起时第一次广播就是等人）', () => {
  assert(longRunPushEdge(undefined, T('running', true)) === 'waiting');
});

test('内容：等你 → 标题带项目名，正文是需要你提供的东西（单行、截断），点开直达该会话', () => {
  const brief = { needHuman: { needs: `部署用哪家云\n${'很长'.repeat(200)}`, question: '完整问题原文不该进推送' } };
  const p = longRunPushPayload('waiting', T('running', true), brief);
  assert(p.title.includes('erp') && p.title.includes('等你'), p.title);
  assert(p.body.startsWith('部署用哪家云') && !p.body.includes('\n') && p.body.length <= 120, p.body);
  assert(p.url === '/m/?session=s9', p.url);
  assert(p.urgency === 'high', '等你要高优先级（手机省电模式下也要尽快到）');
  const bare = longRunPushPayload('waiting', T('running', true), null);
  assert(bare.body.includes('点开回答'), '取不到问题也要有能看懂的正文');
});

test('内容：收工 → 按停机原因给标题，正文是发次与花费；topic 合法且同一任务一致', () => {
  const t = T('done', false, { report: { stop: 'project_done', legs: 7, cost_usd: 4.2 } });
  const p = longRunPushPayload('finished', t);
  assert(p.title.startsWith('✅') && p.body.includes('7 发') && p.body.includes('$4.20'), `${p.title} / ${p.body}`);
  const e = longRunPushPayload('finished', T('failed', false, { report: { stop: 'error' } }));
  assert(e.title.startsWith('❌'), e.title);
  const weird = longRunPushPayload('finished', T('done', false, { id: 'a/b:c'.repeat(20) }));
  assert(/^[A-Za-z0-9_-]{1,32}$/.test(weird.topic), `topic 只能是 URL 安全字符且 ≤32：${weird.topic}`);
  assert(longRunPushPayload('waiting', t).topic === p.topic, '同一任务的两种通知要同 topic，离线时新的顶掉旧的');
});

/** 假推送：记下发了什么 */
function fakePush(subs = 1) {
  const sent = [];
  return { sent, list: () => Array.from({ length: subs }, (_, i) => ({ endpoint: `e${i}` })),
    send: async (p) => { sent.push(p); return { sent: subs, removed: 0, failed: 0, errors: [] }; } };
}
const quiet = { log() {}, error() {} };

test('观察者：几十次广播只推边沿那几次；快照只在要推"等你"时才取', () => {
  const push = fakePush();
  const n = new LongRunPushNotifier({ push, log: quiet });
  let briefCalls = 0;
  const getBrief = () => { briefCalls += 1; return { needHuman: { needs: '选云' } }; };
  for (let i = 0; i < 30; i++) n.observe(T('running', false, { legs: i }), getBrief);
  for (let i = 0; i < 10; i++) n.observe(T('running', true), getBrief);
  for (let i = 0; i < 10; i++) n.observe(T('done'), getBrief);
  assert(push.sent.length === 2, `应只推 2 条，实际 ${push.sent.length}`);
  assert(briefCalls === 1, `快照应只取 1 次，实际 ${briefCalls}（看板几百 KB，不能每次广播都取）`);
});

test('观察者：没人订阅就不取快照、不发；取快照出错照样推', () => {
  const none = fakePush(0);
  let called = false;
  const n = new LongRunPushNotifier({ push: none, log: quiet });
  n.observe(T('running', true), () => { called = true; });
  assert(!called && none.sent.length === 0, '没订阅时不该做任何事');
  const push = fakePush();
  const n2 = new LongRunPushNotifier({ push, log: quiet });
  n2.observe(T('running', true), () => { throw new Error('看板没了'); });
  assert(push.sent.length === 1 && push.sent[0].body.includes('点开回答'), '取不到问题也得推');
});

// ── PushService：真实临时目录 + 假发送器 ──────────────────────────
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wt-push-'));
const SUB = (n) => ({ endpoint: `https://web.push.apple.com/${n}`, keys: { p256dh: `p${n}`, auth: `a${n}` } });
function fakeSender(codes = {}) {
  const calls = [];
  return { calls, generateVAPIDKeys: () => ({ publicKey: `PUB${calls.length}`, privateKey: 'PRIV' }),
    sendNotification: async (s, body, opts) => {
      calls.push({ endpoint: s.endpoint, body: JSON.parse(body), opts });
      const c = codes[s.endpoint];
      if (c) { const e = new Error('x'); e.statusCode = c; e.body = `code ${c}`; throw e; }
    } };
}

test('VAPID：首次生成并落盘（仅本人可读），之后复用同一把 —— 换了钥匙所有手机都要重开', () => {
  const dir = tmp();
  const a = new PushService({ dir, sender: fakeSender() });
  const k1 = a.publicKey();
  const mode = fs.statSync(path.join(dir, 'vapid.json')).mode & 0o777;
  if (process.platform !== 'win32') assert(mode === 0o600, `私钥文件权限应为 600，实际 ${mode.toString(8)}`);
  const b = new PushService({ dir, sender: { generateVAPIDKeys: () => { throw new Error('不该再生成'); } } });
  assert(b.publicKey() === k1, '重启后换了公钥');
});

test('订阅：同一台设备重复开启只留一份；非 https 或缺字段的拒收', () => {
  const s = new PushService({ dir: tmp(), sender: fakeSender() });
  s.subscribe(SUB(1)); s.subscribe(SUB(1)); s.subscribe(SUB(2));
  assert(s.list().length === 2, `应 2 台，实际 ${s.list().length}`);
  for (const bad of [null, { endpoint: 'http://evil/1', keys: { p256dh: 'p', auth: 'a' } }, { endpoint: 'https://x/1', keys: {} }]) {
    let threw = false; try { s.subscribe(bad); } catch { threw = true; }
    assert(threw, `该拒收：${JSON.stringify(bad)}`);
  }
  assert(s.unsubscribe(SUB(1).endpoint) === 1 && !s.has(SUB(1).endpoint) && s.has(SUB(2).endpoint));
});

test('发送：410/404 的失效订阅自动删，500 之类的临时失败保留；only 只发给那一台', async () => {
  const sender = fakeSender({ [SUB(2).endpoint]: 410, [SUB(3).endpoint]: 404, [SUB(4).endpoint]: 500 });
  const s = new PushService({ dir: tmp(), sender });
  [1, 2, 3, 4].forEach((i) => s.subscribe(SUB(i)));
  const r = await s.send({ title: 't', topic: 'lr-x', urgency: 'high' });
  assert(r.sent === 1 && r.removed === 2 && r.failed === 1, JSON.stringify(r));
  assert(s.list().map((x) => x.endpoint).join() === [SUB(1), SUB(4)].map((x) => x.endpoint).join(), '删错了');
  assert(r.errors[0].startsWith('web.push.apple.com') && !r.errors[0].includes('/4 '), '日志不该带完整 endpoint');
  const o = sender.calls[0].opts;
  assert(o.topic === 'lr-x' && o.urgency === 'high' && o.TTL > 0 && o.vapidDetails.privateKey === 'PRIV', JSON.stringify(o));
  assert(/^https:\/\/|^mailto:/.test(o.vapidDetails.subject), 'VAPID subject 必须是 https: 或 mailto:');
  sender.calls.length = 0;
  await s.send({ title: 'only' }, { only: SUB(4).endpoint });
  assert(sender.calls.length === 1 && sender.calls[0].endpoint === SUB(4).endpoint, '测试推送发给了别的设备');
});

test('hostOf：只露主机名', () => {
  assert(hostOf('https://fcm.googleapis.com/fcm/send/abc') === 'fcm.googleapis.com' && hostOf('坏') === '?');
});

for (const [name, fn] of queue) {
  try { await fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}
console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

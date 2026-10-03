/**
 * OpenCode 接入（server/services/opencodeCli.js）。屏幕样本是 opencode 1.18.34 实抓（tests/fixtures/screens/opencode-*）。
 *   ① 欢迎屏 / 运行中 / 确认框 / 一轮结束 判对；欢迎屏标 fresh、输入框有没发出的字标 pending（两者都不发「继续」）
 *   ② 确认框高亮：带色码时认出 Allow once / 被移到 Allow always；纯文本看不出高亮 → null（不能替人回车）
 *   ③ 别的 CLI 的屏（Claude、Kiro）不认成 OpenCode
 *   ④ 由 CC Switch 供应商生成配置：模型挑选、Bearer、官方登录与拿不到模型时如实报错
 *   ⑤ 启动命令：有会话配置才带 OPENCODE_CONFIG，路径做 shell 转义
 *   ⑥ 用量：只算 since 之后、本目录（realpath）的消息；有 cost 用 cost，没有按价格算，缺价标不完整
 *   ⑦ 历史项目：子代理会话、已归档的不算
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { detectOpencodeState, looksLikeOpencode, buildOpencodeConfig, opencodeStartCommand, sessionOpencodeConfig,
  opencodeUsage, listOpencodeProjectDirs } from '../server/services/opencodeCli.js';

let pass = 0, fail = 0;
const test = (n, fn) => { try { fn(); pass++; console.log(`✅ ${n}`); } catch (e) { fail++; console.log(`❌ ${n}\n    ${e.message}`); } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); };
const fx = (n) => fs.readFileSync(new URL(`./fixtures/screens/${n}`, import.meta.url), 'utf-8');

test('① 四种实抓屏幕判对，欢迎屏标 fresh', () => {
  eq(detectOpencodeState(fx('opencode-idle.txt')), { state: 'idle', fresh: true, pending: false }, '欢迎屏');
  eq(detectOpencodeState(fx('opencode-idle.ansi.txt')), { state: 'idle', fresh: true, pending: false }, '欢迎屏（带色码）');
  eq(detectOpencodeState(fx('opencode-running.txt')), { state: 'running' }, '运行中');
  eq(detectOpencodeState(fx('opencode-done.txt')), { state: 'idle', fresh: false, pending: false }, '一轮结束（宽屏，右侧有边栏）');
  eq(detectOpencodeState(fx('opencode-pending.txt')), { state: 'idle', fresh: false, pending: true }, '输入框里有没发出的字');
});

test('② 确认框高亮只认色码', () => {
  eq(detectOpencodeState(fx('opencode-confirm.ansi.txt')), { state: 'confirm', highlighted: 'once' }, '默认高亮 Allow once');
  eq(detectOpencodeState(fx('opencode-confirm-moved.ansi.txt')), { state: 'confirm', highlighted: 'always' }, '右移到 Allow always');
  eq(detectOpencodeState(fx('opencode-confirm.txt')), { state: 'confirm', highlighted: null }, '纯文本看不出高亮');
  eq(detectOpencodeState(fx('opencode-confirm-narrow.ansi.txt')), { state: 'confirm', highlighted: 'once' }, '80 列窄窗口（选项行和快捷键挤在一行）');
});

test('③ 所有 OpenCode 样本都认得出；Claude / Kiro 的屏不认成 OpenCode', () => {
  for (const f of fs.readdirSync(new URL('./fixtures/screens/', import.meta.url))) {
    const s = fx(f);
    if (f.startsWith('opencode-')) eq(looksLikeOpencode(s), true, f);
    else { eq(looksLikeOpencode(s), false, f); eq(detectOpencodeState(s), null, `${f} 状态`); }
  }
});

const ENV = { ANTHROPIC_BASE_URL: 'https://relay.example.com/', ANTHROPIC_AUTH_TOKEN: 'tok-placeholder' };
test('④ 生成配置：按偏好挑 Claude 模型、只列 Claude 系、Bearer 与 x-api-key 都带', () => {
  const r = buildOpencodeConfig({ name: 'Relay', env: ENV, models: ['gpt-5.6', 'claude-sonnet-4-6', 'claude-opus-5-5', 'claude-haiku-4-5-20251001'] });
  eq(r.ok, true, 'ok');
  eq(r.model, 'claude-opus-5-5', '偏好顺序');
  const p = r.config.provider.ccswitch;
  eq(p.options.baseURL, 'https://relay.example.com/v1', 'baseURL 去尾斜杠加 /v1');
  eq(p.options.apiKey, 'tok-placeholder', 'apiKey');
  eq(p.options.headers, { Authorization: 'Bearer tok-placeholder' }, 'AUTH_TOKEN 按 Bearer');
  eq(Object.keys(p.models), ['claude-sonnet-4-6', 'claude-opus-5-5', 'claude-haiku-4-5-20251001'], '不列 gpt');
  eq(r.config.small_model, 'ccswitch/claude-haiku-4-5-20251001', '小模型用 haiku');
  eq(r.config.model, 'ccswitch/claude-opus-5-5', '默认模型');
});

test('④ 地址已带 /v1/messages 或 /v1：不重复拼接', () => {
  for (const u of ['https://a.example.com/v1/messages', 'https://a.example.com/v1/', 'https://a.example.com'])
    eq(buildOpencodeConfig({ name: 'X', env: { ANTHROPIC_BASE_URL: u, ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL: 'm' } }).config.provider.ccswitch.options.baseURL,
      'https://a.example.com/v1', u);
});

test('④ ANTHROPIC_MODEL 优先；API_KEY 不加 Bearer；官方登录、无密钥、无模型如实报错', () => {
  const r = buildOpencodeConfig({ name: 'X', env: { ANTHROPIC_BASE_URL: 'https://a.example.com', ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL: 'my-model' }, models: [] });
  eq([r.ok, r.model, r.config.provider.ccswitch.options.headers], [true, 'my-model', undefined], '指定模型');
  eq(buildOpencodeConfig({ name: 'O', env: {} }).ok, false, '官方登录');
  eq(buildOpencodeConfig({ name: 'N', env: { ANTHROPIC_BASE_URL: 'https://a.example.com' } }).ok, false, '无密钥');
  const none = buildOpencodeConfig({ name: 'M', env: ENV, models: ['gpt-5.6'] });
  eq([none.ok, /ANTHROPIC_MODEL/.test(none.error)], [false, true], '没有 Claude 模型也没指定：不编名字');
});

test('⑤ 启动命令：有会话配置才带 OPENCODE_CONFIG', () => {
  const home = "/h/o'k";
  const cfg = sessionOpencodeConfig('abc-123', home);
  eq(opencodeStartCommand({ id: 'abc-123' }, { home, exists: () => false }), 'opencode -c', '没配置跟随全局');
  eq(opencodeStartCommand({ id: 'abc-123' }, { home, exists: (p) => p === cfg }),
    `OPENCODE_CONFIG='/h/o'\\''k/.webtmux/sessions/abc-123/opencode/opencode.json' opencode -c`, '带配置、单引号转义');
  eq(opencodeStartCommand({ id: 'a;rm' }, { home, exists: () => true }), 'opencode -c', '非法 id 不进命令');
  eq(opencodeStartCommand({ id: 'abc-123' }, { home, exists: () => false, resume: false }), 'opencode', '不续接');
});

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-test-'));
const PROJ = path.join(TMP, 'proj');            // macOS 上 tmpdir 是 /var/…，OpenCode 记的是 realpath /private/var/…
fs.mkdirSync(PROJ);
const DB = path.join(TMP, 'opencode.db');
{
  const db = new Database(DB);
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, time_updated INTEGER, time_archived INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);`);
  const ses = db.prepare('INSERT INTO session VALUES (?,?,?,?,?)');
  ses.run('s1', null, fs.realpathSync(PROJ), 5000, null);
  ses.run('s2', null, '/w/other', 9000, null);
  ses.run('s3', 's1', '/w/subagent-only', 9500, null);
  ses.run('s4', null, '/w/archived', 9600, 1);
  const msg = db.prepare('INSERT INTO message VALUES (?,?,?,?)');
  const asst = (model, cost, input, output, reasoning = 0, done) => JSON.stringify({ role: 'assistant', modelID: model, cost,
    tokens: { input, output, reasoning, cache: { read: 1000, write: 0 } }, time: { completed: done } });
  msg.run('m0', 's1', 100, asst('m-a', 0, 1e6, 0, 0, 150));             // since 之前：不算
  msg.run('m1', 's1', 1000, asst('m-a', 0, 1e6, 1e6, 0, 1100));         // 按价格：1×2 + 1×10 + 0.001×1 = 12.001
  msg.run('m2', 's1', 3000, asst('m-b', 0.5, 10, 10, 0, 3100));          // 自带 cost
  msg.run('m3', 's1', 4000, asst('m-x', 0, 10, 10, 5, 4100));            // 缺价
  msg.run('m4', 's1', 4500, JSON.stringify({ role: 'user', tokens: { input: 99 } }));
  msg.run('m5', 's2', 4500, asst('m-a', 7, 1, 1, 0, 4600));              // 别的目录
  db.close();
}
const PRICES = { 'm-a': { in: 2, out: 10, cacheRead: 1, cacheWrite: 0 } };
const priceOf = (m) => (u) => (PRICES[m] ? (u.input * PRICES[m].in + u.output * PRICES[m].out + u.cacheRead * PRICES[m].cacheRead) / 1e6 : null);

test('⑥ 用量：since 之后、本目录；cost 优先，没有按价格算；缺价标不完整', () => {
  const u = opencodeUsage(PROJ, { since: 500, dayStart: 2000, priceOf }, { dbPath: DB });
  eq(Math.round(u.usd * 1000) / 1000, 12.501, '累计 = 12.001 + 0.5（缺价的不记 0 以外的数）');
  eq(u.todayUsd, 0.5, '今天（dayStart 之后完成的）');
  eq([u.incomplete, u.unknownModels], [true, ['m-x']], '缺价');
  eq(u.byModel.map((m) => m.model), ['m-a', 'm-b', 'm-x'], '分模型');
  eq(u.byModel[2].output_tokens, 15, 'reasoning 计入 output');
  eq(u.model, 'm-x', '最近用的模型');
});

test('⑥ 库不存在：返回零而不是抛错', () => {
  eq(opencodeUsage(PROJ, { priceOf }, { dbPath: path.join(TMP, 'none.db') }).usd, 0, '无库');
});

test('⑦ 历史项目：子代理会话、已归档的不算，新的在前', () => {
  eq(listOpencodeProjectDirs({ dbPath: DB }).map((p) => p.path), ['/w/other', fs.realpathSync(PROJ)], '目录');
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);

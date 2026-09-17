/**
 * 长程编排：监督者 LLM 调用（AIEngine.callClaudeMessages）—— 本地假 API 实测
 *
 * 对应原版 llm_client.LLMClient.complete 的调用约定（审计 G17）：
 *   system 位置放判定提示词（第一块保留 Claude Code 身份，Relay 伪装要求）、temperature 0、
 *   max_tokens 4000、回传真实 stop_reason、网络/5xx/429 重试、其它 4xx 不重试、单次超时。
 *
 * 运行: node tests/test-longrun-llm-call.mjs
 */

import http from 'http';
import { AIEngine } from '../server/services/AIEngine.js';

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
async function test(name, fn) {
  try { await fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}

/** 起一个按脚本回复的假 API。script 每项 {status, body, delayMs}，用完重复最后一项 */
async function fakeApi(script) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      hits.push({ headers: req.headers, body: raw ? JSON.parse(raw) : null });
      const step = script[Math.min(hits.length - 1, script.length - 1)];
      setTimeout(() => {
        res.writeHead(step.status, { 'content-type': 'application/json' });
        res.end(typeof step.body === 'string' ? step.body : JSON.stringify(step.body));
      }, step.delayMs || 0);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/v1/messages`;
  return { url, hits, close: () => new Promise((r) => server.close(r)) };
}

/** 不构造完整 AIEngine（会加载配置），只借原型方法与模型兜底 */
const call = (opts) => AIEngine.prototype.callClaudeMessages.call({ _getModelsToTry: () => ['fallback-model'] }, opts);
const ok = (over = {}) => ({ status: 200, body: {
  content: [{ type: 'text', text: '{"verdict":' }, { type: 'thinking', thinking: 'x' }, { type: 'text', text: '"continue"}' }],
  stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 3 }, ...over } });
const cfg = (url) => ({ apiUrl: url, apiKey: 'sk-test', model: 'claude-opus-5' });

await test('请求体：判定提示词在 system 位置（第一块保留伪装身份）、temperature 0、max_tokens 4000', async () => {
  const api = await fakeApi([ok()]);
  try {
    await call({ config: cfg(api.url), system: '你是监督者', user: '执行者说完了' });
    const { body, headers } = api.hits[0];
    assert(body.system.length === 2 && /Claude Code/.test(body.system[0].text), '第一块应是 Claude Code 身份');
    assert(body.system[1].text === '你是监督者', '判定提示词应在 system 第二块，不是拼进 user');
    assert(body.messages[0].content === '执行者说完了', 'user 原样');
    assert(body.temperature === 0 && body.max_tokens === 4000 && body.model === 'claude-opus-5', JSON.stringify(body));
    assert(headers['x-app'] === 'cli' && headers.authorization === 'Bearer sk-test', '伪装头与鉴权要带上');
  } finally { await api.close(); }
});

await test('返回真实 stop_reason 与用量；多个文本块按原版拼接（换行连接）', async () => {
  const api = await fakeApi([ok({ stop_reason: 'max_tokens' })]);
  try {
    const r = await call({ config: cfg(api.url), system: 's', user: 'u' });
    assert(r.stopReason === 'max_tokens', `stop_reason 要透传，实际 ${r.stopReason}（原先恒为 end_turn，截断分支永远命中不了）`);
    assert(r.text === '{"verdict":\n"continue"}' && r.inputTokens === 12 && r.outputTokens === 3, JSON.stringify(r));
  } finally { await api.close(); }
});

await test('500 与 429 会重试并最终成功；400 不重试', async () => {
  const flaky = await fakeApi([{ status: 500, body: 'boom' }, { status: 429, body: 'slow down' }, ok()]);
  try {
    const r = await call({ config: cfg(flaky.url), system: 's', user: 'u', backoffMs: 10 });
    assert(flaky.hits.length === 3 && r.text.includes('continue'), `应重试到成功，实际请求 ${flaky.hits.length} 次`);
  } finally { await flaky.close(); }
  const bad = await fakeApi([{ status: 400, body: 'bad request' }, ok()]);
  try {
    let e = null;
    try { await call({ config: cfg(bad.url), system: 's', user: 'u', backoffMs: 10 }); } catch (x) { e = x; }
    assert(e && e.message.includes('HTTP 400') && bad.hits.length === 1, `4xx 不该重试（重试同样的请求不会有不同结果），实际 ${bad.hits.length} 次`);
  } finally { await bad.close(); }
});

await test('超时计入重试，全部失败时报出尝试次数与最后错误', async () => {
  const slow = await fakeApi([{ ...ok(), delayMs: 400 }]);
  try {
    let e = null;
    try { await call({ config: cfg(slow.url), system: 's', user: 'u', timeoutMs: 100, maxRetries: 1, backoffMs: 10 }); } catch (x) { e = x; }
    assert(e && e.message.includes('2 次尝试') && e.message.includes('超时'), `实际: ${e?.message}`);
  } finally { await slow.close(); }
});

await test('凭据缺失时立刻报错并指向 CC Switch', async () => {
  let e = null;
  try { await call({ config: { apiUrl: '', apiKey: '' }, system: 's', user: 'u' }); } catch (x) { e = x; }
  assert(e && e.message.includes('CC Switch'), `实际: ${e?.message}`);
});

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const x of results.errors) console.log(`  • ${x.name}\n    ${x.error}`);
// AIEngine 的依赖在导入时就挂了文件监视与子进程，事件循环不会自己空，必须显式退出
process.exit(results.failed ? 1 : 0);

#!/usr/bin/env node
/**
 * 结构化输出（tool_use）请求/响应链路测试
 *
 * 覆盖 _callClaudeApiWithModel 的四件事，全部用打桩的 fetch，不发真实请求：
 *   1. structured 时请求体带 tools + tool_choice，且 max_tokens ≥ 1024
 *   2. 响应里的 tool_use.input 被序列化成纯 JSON 交给下游（structured 标记为 true）
 *   3. 中转站不支持 tools 返 400 时，自动去掉 tools 重试一次并成功
 *   4. 不传 structured 时请求体里不出现 tools（不影响原有供应商）
 * 另外验证 usage/model 形状没被破坏——_recordTokenUsage 依赖它。
 */
const results = { passed: 0, failed: 0, errors: [] };
function test(name, fn) {
  try { fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (e) { results.failed++; results.errors.push({ name, error: e.message }); console.log(`❌ ${name}\n   ${e.message}`); }
}
async function atest(name, fn) {
  try { await fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (e) { results.failed++; results.errors.push({ name, error: e.message }); console.log(`❌ ${name}\n   ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }

const { AIEngine, STATUS_TOOL } = await import('../server/services/AIEngine.js');
const engine = new AIEngine();
await new Promise(r => setTimeout(r, 1200));

const CONFIG = { apiUrl: 'https://example.invalid/v1/messages', apiKey: 'test-key-not-real', model: 'claude-sonnet-4-6' };
const realFetch = globalThis.fetch;
let captured = [];

/** 打桩 fetch：记录请求体，按 responder 返回 */
function stubFetch(responder) {
  captured = [];
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    captured.push({ url, body, headers: opts.headers });
    return responder(body, captured.length);
  };
}
const ok = (payload) => ({ ok: true, status: 200, json: async () => payload });
const bad = (status, text) => ({ ok: false, status, text: async () => text });

const TOOL_REPLY = {
  content: [{ type: 'tool_use', name: STATUS_TOOL.name, input: { currentState: '空闲', needsAction: true, actionType: 'text_input', suggestedAction: '继续' } }],
  usage: { input_tokens: 1200, output_tokens: 42 },
  model: 'claude-sonnet-4-6'
};

console.log('=== 结构化输出链路 ===\n');

await atest('structured 时请求体带 tools + tool_choice，max_tokens ≥ 1024', async () => {
  stubFetch(() => ok(TOOL_REPLY));
  await engine._callClaudeApiWithModel('p', CONFIG, CONFIG.model, { structured: true });
  const b = captured[0].body;
  assert(Array.isArray(b.tools) && b.tools[0].name === STATUS_TOOL.name, '请求体缺少 tools');
  assert(b.tool_choice?.type === 'tool' && b.tool_choice.name === STATUS_TOOL.name, `tool_choice 不对: ${JSON.stringify(b.tool_choice)}`);
  assert(b.max_tokens >= 1024, `max_tokens=${b.max_tokens}，应 ≥1024`);
  // 伪装要素不能因为加 tools 而丢
  assert(Array.isArray(b.system) && /Claude Code/.test(b.system[0].text), '丢了 Claude Code 伪装 system');
  assert(/^user_[0-9a-f]{64}_account__session_/.test(b.metadata?.user_id || ''), `metadata.user_id 形状不对: ${b.metadata?.user_id}`);
});

await atest('tool_use.input 被序列化成纯 JSON，且 usage/model 形状保留', async () => {
  stubFetch(() => ok(TOOL_REPLY));
  const r = await engine._callClaudeApiWithModel('p', CONFIG, CONFIG.model, { structured: true });
  assert(r.structured === true, 'structured 标记应为 true');
  const parsed = JSON.parse(r.text); // 必须是可直接 JSON.parse 的纯净字符串
  assert(parsed.suggestedAction === '继续', `text 内容不对: ${r.text}`);
  assert(r.usage?.output_tokens === 42, 'usage 丢失（_recordTokenUsage 依赖）');
  assert(r.model === 'claude-sonnet-4-6', 'model 丢失');
  // 端到端：解析层能直接吃下
  const st = engine._parseStatusResponse(r.text);
  assert(st?.actionType === 'text_input' && st.suggestedAction === '继续', `解析层结果不对: ${JSON.stringify(st)}`);
});

await atest('响应仅含 tool_use 块（无 text 块）时也能取到内容', async () => {
  // 这是线上实测的真实形状：stop_reason=tool_use，content=["tool_use"]，
  // content[0].text 是 undefined。改动前的 `data.content?.[0]?.text || null`
  // 在这种响应下只能取到 null，整条状态分析直接作废。
  stubFetch(() => ok({ ...TOOL_REPLY, stop_reason: 'tool_use' }));
  const r = await engine._callClaudeApiWithModel('p', CONFIG, CONFIG.model, { structured: true });
  assert(r.text, '仅有 tool_use 块时 text 不该为空');
  assert(JSON.parse(r.text).actionType === 'text_input', `内容不对: ${r.text}`);
});

await atest('中转站不支持 tools（400）时去掉 tools 重试并成功', async () => {
  engine._structuredUnsupported = false;
  stubFetch((body, n) => {
    if (n === 1) { assert(body.tools, '第一次应带 tools'); return bad(400, 'tools not supported'); }
    return ok({ content: [{ type: 'text', text: '{"currentState":"空闲","needsAction":false,"actionType":"none"}' }], usage: { output_tokens: 9 }, model: 'm' });
  });
  const r = await engine._callClaudeApiWithModel('p', CONFIG, CONFIG.model, { structured: true });
  assert(captured.length === 2, `应重试一次，实际请求 ${captured.length} 次`);
  assert(!captured[1].body.tools, '重试请求不该再带 tools');
  assert(r.structured === false, '回退后 structured 应为 false');
  assert(engine._parseStatusResponse(r.text)?.actionType === 'none', '回退后仍应可解析');
  assert(engine._noToolsProviders.has(CONFIG.apiUrl), '应按 apiUrl 记住该供应商不支持，避免反复试探');
});

await atest('不支持记录按 apiUrl 隔离：换供应商仍试 tools', async () => {
  // 上一条已把 CONFIG.apiUrl 标记为不支持
  assert(engine._noToolsProviders.has(CONFIG.apiUrl), '前置条件不成立');
  const other = { ...CONFIG, apiUrl: 'https://good-relay.invalid/v1/messages' };
  stubFetch(() => ok(TOOL_REPLY));
  await engine._callClaudeApi('p', other, { structured: true });
  assert(captured[0].body.tools, '换了供应商就该重新试 tools，不能被别家的 400 连坐');

  // 同时确认坏供应商不再试探（直接不带 tools，一次请求都不浪费在 400 上）
  stubFetch(() => ok({ content: [{ type: 'text', text: '{}' }], usage: null, model: 'm' }));
  await engine._callClaudeApi('p', CONFIG, { structured: true });
  assert(captured.length === 1 && !captured[0].body.tools, `坏供应商不该再带 tools，实际 ${captured.length} 次请求`);
});

await atest('未开 structured 时请求体不含 tools（不影响原有供应商）', async () => {
  stubFetch(() => ok({ content: [{ type: 'text', text: '{}' }], usage: null, model: 'm' }));
  await engine._callClaudeApiWithModel('p', CONFIG, CONFIG.model);
  assert(!captured[0].body.tools, '不该出现 tools');
  assert(!captured[0].body.tool_choice, '不该出现 tool_choice');
});

await atest('非 400/422 的失败仍然抛错（不吞异常）', async () => {
  stubFetch(() => bad(500, 'upstream boom'));
  let threw = false;
  try { await engine._callClaudeApiWithModel('p', CONFIG, CONFIG.model, { structured: true }); }
  catch (e) { threw = /500/.test(e.message); }
  assert(threw, '500 应抛出，且错误信息含状态码');
  assert(captured.length === 1, `500 不该重试，实际 ${captured.length} 次`);
});

globalThis.fetch = realFetch;
console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) { for (const e of results.errors) console.log(`  • ${e.name}: ${e.error}`); }
process.exit(results.failed > 0 ? 1 : 0);

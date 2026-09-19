/**
 * 供应商可用模型发现 —— 开长程时的模型下拉。
 *
 * 由来（Hitech 2026-09-18/19）：两轮长程全败于
 * `503 分组 zhangzong 下模型 claude-fable-5-1 无可用渠道（distributor）`。
 * 在此之前模型只是「高级参数」里一个手输文本框，开跑前没人会去看，填错也无从校验。
 *
 * 这里的铁律：**拿不到清单就说拿不到**。编一份清单（或沿用上一个供应商的）
 * 只会再撞「无可用渠道」，比没有清单更坏。
 *
 * 运行: node tests/test-provider-models.mjs
 */

import fs from 'fs';
import { listProviderModels, parseModelList, modelsUrl, cache, MODELS_TIMEOUT_MS } from '../server/services/ProviderModels.js';

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
async function test(name, fn) {
  cache.clear();
  try { await fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}

/** 假 AIEngine：只提供 CC Switch 解析结果（真实路径也只用这两个方法） */
const engineWith = (claude) => ({
  resolveSessionSettings: () => ({ claude }),
  getSettings: () => ({ claude }),
});
const okFetch = (body, status = 200) => async () => ({ ok: status < 400, status, json: async () => body });

// 实测响应形状（zjz-ai.webtrn.cn 返回 37 个模型的 OpenAI 口径）
const REAL_BODY = { data: [{ id: 'claude-opus-5' }, { id: 'claude-fable-5-1' }, { id: 'claude-opus-4-5' }] };
const REAL_CLAUDE = { apiUrl: 'https://zjz-ai.webtrn.cn', apiKey: 'sk-test', model: 'opus[1m]' };

await test('正常拿到清单：模型名保序去重，供应商配置里的模型也带回去', async () => {
  const r = await listProviderModels({ engine: engineWith(REAL_CLAUDE), fetchImpl: okFetch(REAL_BODY) });
  assert(r.ok === true, JSON.stringify(r));
  assert(r.models.join() === 'claude-opus-5,claude-fable-5-1,claude-opus-4-5', r.models.join());
  assert(r.configured === 'opus[1m]', '配置里的模型要带回来，清单拉不到时人还能选回它');
  assert(r.baseUrl === 'https://zjz-ai.webtrn.cn', r.baseUrl);
});

await test('三种响应口径都要认（OpenAI data / 裸数组 / models 键）', () => {
  assert(parseModelList({ data: [{ id: 'a' }, { id: 'b' }] }).join() === 'a,b');
  assert(parseModelList(['a', 'b']).join() === 'a,b');
  assert(parseModelList({ models: [{ model: 'a' }, { name: 'b' }] }).join() === 'a,b');
  assert(parseModelList({ data: [{ id: 'a' }, { id: 'a' }, { id: ' ' }] }).join() === 'a', '去重且丢空');
  assert(parseModelList(null).length === 0 && parseModelList({}).length === 0, '空值不炸');
});

await test('地址形态各异都要拼对 /v1/models（中转站配法很杂）', () => {
  assert(modelsUrl('https://zjz-ai.webtrn.cn') === 'https://zjz-ai.webtrn.cn/v1/models');
  assert(modelsUrl('https://x.com/v1') === 'https://x.com/v1/models', '带 /v1 不能拼成 /v1/v1/models');
  assert(modelsUrl('https://y.com/api/v1/messages') === 'https://y.com/v1/models', 'Claude Relay 口径');
  assert(modelsUrl('https://z.com/') === 'https://z.com/v1/models', '末尾斜杠');
  assert(modelsUrl('') === '' && modelsUrl(null) === '', '空地址给空串（官方 OAuth）');
});

await test('拿不到清单一律 ok:false + 说明原因，models 必须为空（绝不编）', async () => {
  const cases = [
    ['官方 OAuth 无自定义地址', { apiKey: 'k' }, okFetch(REAL_BODY), /OAuth|自定义 API 地址/],
    ['没有密钥', { apiUrl: 'https://a.com' }, okFetch(REAL_BODY), /密钥/],
    ['供应商 401', REAL_CLAUDE, okFetch({ error: 'bad token' }, 401), /401/],
    ['清单为空', REAL_CLAUDE, okFetch({ data: [] }), /空/],
    ['网络异常', REAL_CLAUDE, async () => { throw new Error('ENOTFOUND a.com'); }, /ENOTFOUND/],
  ];
  for (const [label, claude, fetchImpl, reErr] of cases) {
    cache.clear();
    const r = await listProviderModels({ engine: engineWith(claude), fetchImpl });
    assert(r.ok === false, `${label}: 应为失败`);
    assert(r.models.length === 0, `${label}: 失败时必须给空清单，不能编`);
    assert(reErr.test(r.error || ''), `${label}: 原因说不清楚 →「${r.error}」`);
  }
});

await test('超时要真的中断并如实报，不能挂住界面', async () => {
  // 关键是 signal 必须真被 abort：只写个定时器不调 ctl.abort() 的话，
  // 请求会一直挂着，弹窗永远停在「正在查…」。所以这里等的就是 abort 事件本身。
  let aborted = false;
  const hang = (url, opts) => new Promise((_, rej) => {
    opts.signal.addEventListener('abort', () => {
      aborted = true;
      const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
    });
  });
  // ⚠ 必须给用例自己设一个上限并竞速：不设的话，"永不 abort" 这种写法会让
  //   await 无限挂住 —— 测试进程一起卡死，报不出失败，等于守卫失效。
  const t0 = Date.now();
  const limit = MODELS_TIMEOUT_MS + 3000;
  const r = await Promise.race([
    listProviderModels({ engine: engineWith(REAL_CLAUDE), fetchImpl: hang }),
    new Promise((res) => setTimeout(() => res({ __stuck: true }), limit)),
  ]);
  assert(!r.__stuck, `${limit}ms 内没返回：请求没被中断，弹窗会永远停在「正在查…」`);
  assert(aborted === true, `超时后没有真的 abort 请求 —— 弹窗会一直停在「正在查…」（等了 ${Date.now() - t0}ms）`);
  assert(r.ok === false && /超时/.test(r.error), JSON.stringify(r));
  assert(MODELS_TIMEOUT_MS <= 15000, `超时 ${MODELS_TIMEOUT_MS}ms 太长，界面会干等`);
});

await test('结果与失败都缓存：反复开弹窗不重复打网络，也不重复干等', async () => {
  let calls = 0;
  const counting = async () => { calls += 1; return { ok: true, status: 200, json: async () => REAL_BODY }; };
  const eng = engineWith(REAL_CLAUDE);
  await listProviderModels({ engine: eng, fetchImpl: counting });
  const second = await listProviderModels({ engine: eng, fetchImpl: counting });
  assert(calls === 1, `缓存没生效，打了 ${calls} 次网络`);
  assert(second.cached === true && second.ok === true, JSON.stringify(second));
  const third = await listProviderModels({ engine: eng, fetchImpl: counting, refresh: true });
  assert(calls === 2 && !third.cached, '「重新查询」必须真的绕过缓存');
});

await test('不同供应商各自缓存：换供应商不能沿用上一个的清单', async () => {
  const bodies = {
    p1: { data: [{ id: 'model-a' }] },
    p2: { data: [{ id: 'model-b' }] },
  };
  let which = 'p1';
  const eng = {
    resolveSessionSettings: (_app, id) => ({ claude: { apiUrl: `https://${id}.com`, apiKey: 'k' } }),
    getSettings: () => ({ claude: REAL_CLAUDE }),
  };
  const f = async () => ({ ok: true, status: 200, json: async () => bodies[which] });
  const r1 = await listProviderModels({ engine: eng, providerId: 'p1', fetchImpl: f });
  which = 'p2';
  const r2 = await listProviderModels({ engine: eng, providerId: 'p2', fetchImpl: f });
  assert(r1.models.join() === 'model-a', r1.models.join());
  assert(r2.models.join() === 'model-b', `沿用了上一个供应商的清单 → 会选出个不存在的模型：${r2.models.join()}`);
});

// ── 界面守卫 ─────────────────────────────────────────────────────
const PICKER = fs.readFileSync(new URL('../src/components/longrun/LongRunModelPicker.jsx', import.meta.url), 'utf8');
const NEWTASK = fs.readFileSync(new URL('../src/components/longrun/LongRunNewTask.jsx', import.meta.url), 'utf8');
const ADV = fs.readFileSync(new URL('../src/components/longrun/LongRunAdvanced.jsx', import.meta.url), 'utf8');

await test('守卫：模型选择在主区，不在折叠的高级参数里', () => {
  assert(/<LongRunModelPicker/.test(NEWTASK), '没接进新建弹窗');
  const at = NEWTASK.indexOf('<LongRunModelPicker');
  const advAt = NEWTASK.indexOf('{showAdv &&');
  assert(at > 0 && at < advAt, '模型选择又被塞到高级参数之后了 —— 藏起来等于没有，Hitech 就是这么跑挂的');
  assert(!/执行者模型/.test(ADV), '高级参数里还留着一个模型输入框，两处会打架');
});

await test('守卫：换供应商必须重查清单，且失败时退回手输', () => {
  // 只认「依赖数组里有 providerId 的 useEffect」这一件事，不锁具体写法
  const effects = PICKER.split('useEffect(').slice(1);
  assert(effects.some((e) => /\[providerId\]/.test(e.slice(0, 200))),
    '没有按 providerId 重查 —— 换了供应商还用旧清单，会选出个不存在的模型');
  assert(/providerId: providerId \|\| ''/.test(PICKER), '查询要把 providerId 传下去，否则永远查当前配置');
  assert(/<input value=\{value\}/.test(PICKER), '清单拿不到时必须退回手输，不能让人无法开跑');
  assert(/state\.error/.test(PICKER), '拿不到要说明原因');
});

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

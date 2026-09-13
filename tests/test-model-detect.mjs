/**
 * 模型识别回归测试（v1.3.0）
 *
 * 背景：面板"当前模型"长期显示错。实测 35 个会话里 9 个不一致 ——
 * 显示 glm-5.3-flash / opus[1m] / (空)，而 transcript 里是 claude-opus-5 / claude-sonnet-5。
 * 根因是四条独立缺陷叠加，本文件逐条锁住。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const results = { passed: 0, failed: 0, errors: [] };
const pending = [];
function test(name, fn) {
  const p = (async () => {
    try { await fn(); results.passed++; console.log(`✅ ${name}`); }
    catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
  })();
  pending.push(p);
  return p;
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }

const SRC = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');

// ---------- ① transcript 目录名换算：非字母数字一律换 - ----------
// 老实现只换 [/.]，带下划线的项目路径（GigaPlace_Engine）推算不出目录 →
// transcript 找不到 → 模型探测静默失效 → 回落 settings.json 陈旧值。
const dirName = (wd) => String(wd || '').replace(/[^a-zA-Z0-9]/g, '-');

test('目录名换算：下划线也要变 -（实测 GigaPlace_Engine 因此漏了）', () => {
  assert(dirName('/Users/zhangzhen/Documents/ClaudeCode/GigaPlace_Engine')
    === '-Users-zhangzhen-Documents-ClaudeCode-GigaPlace-Engine', '下划线未转换');
  // 老规则的行为（留作对照，证明这条是真回归点）
  const old = '/Users/zhangzhen/Documents/ClaudeCode/GigaPlace_Engine'.replace(/[/.]/g, '-');
  assert(old !== '-Users-zhangzhen-Documents-ClaudeCode-GigaPlace-Engine', '老规则本该是错的');
});
test('目录名换算：大小写保留、点和斜杠照旧转换', () => {
  assert(dirName('/Users/a/Documents/ClaudeCode/WebTmux') === '-Users-a-Documents-ClaudeCode-WebTmux');
  assert(dirName('/tmp/a.b.c') === '-tmp-a-b-c');
});
test('目录名换算：实现里确实用了共用函数，没有残留 [/.] 写法', () => {
  assert(/function claudeProjectDirName/.test(SRC), '缺少共用函数 claudeProjectDirName');
  assert(!/replace\(\/\[\/\\?\.\]\/g,\s*'-'\)/.test(SRC), '仍有 replace(/[/.]/g) 残留，会再漏带下划线的路径');
  const uses = (SRC.match(/claudeProjectDirName\(workingDir\)/g) || []).length;
  assert(uses >= 2, `共用函数应被两处探测调用，实际 ${uses} 处`);
});

// ---------- ② 周期刷新必须落库 ----------
// 老实现只改内存 + 推前端，服务一重启就回到旧值
//（实测日志刚把 RustCandance 刷成 claude-opus-5，库里仍是 opus[1m]）。
test('周期刷新：改完模型必须 updateSession 落库', () => {
  const i = SRC.indexOf('[模型周期刷新]');
  assert(i > 0, '找不到周期刷新代码');
  const block = SRC.slice(i - 1200, i + 200);
  assert(/sessionManager\.updateSession\(session\)/.test(block),
    '周期刷新没有落库，重启后模型会回到旧值');
});

// ---------- ③ 陈旧 status 快照不得永久压制 transcript ----------
// /status 探针只在用户手动敲 /status 那一刻更新；之后 /model 换了模型也永不刷新。
// 老实现把 status 列进豁免名单 → 陈旧快照永久压住兜底
//（实测 3 个 src=status 显示 glm-5.3-flash，还有 1 个是空值却同样被保护）。
test('周期刷新：豁免名单只剩 relay，status 不再永久压制', () => {
  const i = SRC.indexOf('[模型周期刷新]');
  const block = SRC.slice(i - 1600, i);
  assert(!/\['status',\s*'relay'\]\.includes/.test(block),
    "status 仍在豁免名单里，陈旧快照会永久压住 transcript 兜底");
  assert(/configSource === 'relay'/.test(block), 'relay 应仍然豁免（请求体嗅探，物理同源）');
});

// ---------- ④ 返回值出口统一用 transcript 兜底，断掉竞态 ----------
// 不修这条时：周期刷新纠正后，下一次 getCurrentProvider 又用 global 的
// glm-5.3-flash 写回去，两者来回打 → 面板"时对时错"（实测剩 1~2 个错且在会话间轮换）。
test('getCurrentProvider：buildResult 出口用 transcript 覆盖模型', () => {
  const i = SRC.indexOf('const buildResult = (extras) =>');
  assert(i > 0, '找不到 buildResult');
  const block = SRC.slice(i, i + 1400);
  assert(/probeModelByWorkingDirSync\(workingDir\)/.test(block),
    'buildResult 没有用 transcript 兜底，陈旧 global 值会回写造成竞态');
  assert(/model: finalModel/.test(block), '返回值应使用兜底后的 finalModel');
  assert(/cs !== 'relay'/.test(block), 'relay 应跳过（比 transcript 更即时）');
});
test('同步探测函数存在且只读尾部（不整文件读）', () => {
  assert(/function probeModelByWorkingDirSync/.test(SRC), '缺少同步探测函数');
  const i = SRC.indexOf('function probeModelByWorkingDirSync');
  const block = SRC.slice(i, i + 1200);
  assert(/64 \* 1024/.test(block), '应只读尾部 64KB，避免大文件卡同步路径');
});

// ---------- ⑤ 模型名过滤：<synthetic> 等占位值不得当成模型 ----------
// transcript 里 Claude Code 会写 "model":"<synthetic>"（错误占位/合成消息），
// 实测 cadance 会话最近一条就是它。取到它会显示成模型名。
test('模型名过滤：<synthetic> 等占位值不算模型，真实模型名要认', () => {
  const RE = /^[a-z0-9][\w.:/-]{2,63}$/i;
  for (const bad of ['<synthetic>', '', '?', '<none>']) {
    assert(!RE.test(bad), `占位值 ${JSON.stringify(bad)} 不该被当成模型`);
  }
  for (const good of ['claude-opus-5', 'claude-sonnet-5', 'glm-5.3-flash', 'gpt-5.2-codex', 'kimi-k2']) {
    assert(RE.test(good), `真实模型名 ${good} 应被认出`);
  }
});
test('取值取最后一次出现（transcript 尾部是最新一轮）', () => {
  const tail = '{"model":"claude-sonnet-5"}\n{"model":"<synthetic>"}\n{"model":"claude-opus-5"}';
  let model = null;
  for (const m of tail.matchAll(/"model"\s*:\s*"([^"]+)"/g)) {
    if (/^[a-z0-9][\w.:/-]{2,63}$/i.test(m[1])) model = m[1];
  }
  assert(model === 'claude-opus-5', `应取最后一个合法值，实际 ${model}`);
});

await Promise.all(pending);
console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

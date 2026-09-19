/**
 * 「用了却没导入」的静态守卫。
 *
 * 为什么非要有：2026-09-19 实测事故 —— 我给 server/index.js 加功能时用脚本按
 * 一行旧 import 做锚点做替换，那行早已被别的改动动过，**锚点不存在、替换静默失败**，
 * 于是 `shouldStopMechanicalContinue` / `listProviderModels` 两个导入从未写入，
 * 而调用处照常提交。后果：
 *   - `node --check` 过（语法没问题，未导入是运行期错误）
 *   - 62 个单测全绿（它们直接 import 模块本身，不走 server/index.js 这条路）
 *   - 服务跑起来才炸：`[后台自动操作] 会话 RustCandance 错误:
 *     shouldStopMechanicalContinue is not defined`，自动操作**整轮被 catch 吞掉**，
 *     面板显示「需要操作：继续」但「最近操作：无」，会话就此僵在原地不动。
 *
 * 判据：服务端源码里出现的「本仓库自有服务模块的导出名」，必须在该文件里被导入。
 * 只查自有模块的导出，避免把内建全局和第三方 API 全列一遍。
 *
 * 运行: node tests/test-imports-resolved.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function test(name, fn) {
  try { fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}

/** 收集一个模块文件里的具名导出（function / const / class） */
function namedExports(src) {
  const out = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.add(name);
    }
  }
  return out;
}

/** 收集一个文件里所有被导入的标识符（具名、默认、命名空间） */
function importedNames(src) {
  const out = new Set();
  for (const m of src.matchAll(/import\s+([\s\S]*?)\s+from\s*['"][^'"]+['"]/g)) {
    const clause = m[1];
    const braces = clause.match(/\{([\s\S]*?)\}/);
    if (braces) {
      for (const part of braces[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop().trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) out.add(name);
      }
    }
    // 默认导入 / 命名空间导入：`X from`、`X, { … } from`、`* as X from`
    const head = clause.replace(/\{[\s\S]*?\}/, '').replace(/\*\s+as\s+/, '').split(',')[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(head)) out.add(head);
  }
  // 同文件内自己定义的同名符号也算"有定义"
  for (const m of src.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
  for (const m of src.matchAll(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
  return out;
}

/**
 * 剥掉注释，避免注释里提到的名字被当成调用。
 *
 * ⚠ 刻意**不剥字符串**。第一版顺手加了模板字符串的剥除
 * （/`(?:\\[\s\S]|[^`\\])*`/g），实测把 366k 字符的 index.js 削成 16k ——
 * 文件里有未闭合的反引号/嵌套模板，正则一路贪吃，把真正的调用点连带吞掉，
 * 于是守卫对真实事故一声不响（本该报缺失却全绿）。守卫自身不可靠比没有守卫更坏，
 * 所以宁可留下字符串里的误报风险（还没遇到过），也不要静默漏报。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

// 本仓库自有的服务模块导出名 → 定义它的文件
const OWNED = new Map();
const svcDir = path.join(ROOT, 'server/services');
for (const f of fs.readdirSync(svcDir)) {
  if (!f.endsWith('.js')) continue;
  const src = fs.readFileSync(path.join(svcDir, f), 'utf8');
  for (const name of namedExports(src)) {
    // 太短或过于通用的名字不查，避免与局部变量撞车产生噪音
    if (name.length >= 8 && !OWNED.has(name)) OWNED.set(name, f);
  }
}

const TARGETS = ['server/index.js'];

test('自有服务模块的导出名，用到就必须在该文件导入过', () => {
  assert(OWNED.size > 50, `只收集到 ${OWNED.size} 个导出名，收集逻辑坏了`);
  const missing = [];
  for (const rel of TARGETS) {
    const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        // 自检：剥注释不该把文件削掉一大半。第一版的字符串剥除就是这么静默吃掉代码的
    const code = stripComments(raw);
    assert(code.length > raw.length * 0.5,
      `剥注释后从 ${raw.length} 削到 ${code.length}，剥得太狠 —— 调用点会被吞掉，守卫将静默漏报`);
    const have = importedNames(raw);
    for (const [name, from] of OWNED) {
      if (have.has(name)) continue;
      // 作为函数被调用，或出现在 `name(`/`name)` 这类实参位置才算"用了"
      if (new RegExp(`(?<![.\\w$])${name}\\s*\\(`).test(code)) missing.push(`${rel}: 用了 ${name}()，但没从 services/${from} 导入`);
    }
  }
  assert(missing.length === 0,
    `发现用了却没导入的标识符（运行期才炸，node --check 和现有单测都抓不到）：\n    ` + missing.join('\n    '));
});

test('守卫自身有效性：故意查一个不存在的导出时应当报缺失', () => {
  // 防止上面那条因为正则写坏而永远通过（那样它就成了摆设）
  const fake = 'definitelyMissingHelperName';
  const code = stripComments(`const x = ${fake}(1);`);
  assert(new RegExp(`(?<![.\\w$])${fake}\\s*\\(`).test(code), '调用点识别正则失效了');
  assert(!importedNames(`import { other } from './a.js';`).has(fake), '导入识别正则失效了');
});

test('守卫：监控循环抛异常时要把错误摆到界面上，不能只进控制台', () => {
  // 这次事故里 catch 只 console.error，面板还挂着上一轮的「需要操作：继续」、
  // 「最近操作：无」，用户只看到会话僵住，不知道监控自己已经坏了。
  const src = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
  const at = src.indexOf('[后台自动操作] 会话 ${session.name} 错误:');
  assert(at > 0, '没找到监控循环的 catch');
  const seg = src.slice(at, at + 1600);
  assert(/loop_error/.test(seg), 'catch 里没把错误写进状态缓存，界面看不到监控已坏');
  assert(/emit\('ai:status'/.test(seg), 'catch 里没推 ai:status，正在看这个会话的人不会收到更新');
  assert(/needsAction: false/.test(seg), '出错时必须清掉「需要操作」，否则面板继续显示将自动执行却什么都不做');
});

test('导入识别要覆盖默认、命名空间、别名三种写法', () => {
  const s = [
    "import fs from 'fs';",
    "import * as os from 'os';",
    "import { a as b, c } from './x.js';",
    "import Engine, { helper } from './y.js';",
  ].join('\n');
  const names = importedNames(s);
  for (const n of ['fs', 'os', 'b', 'c', 'Engine', 'helper']) assert(names.has(n), `漏了 ${n}`);
});

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

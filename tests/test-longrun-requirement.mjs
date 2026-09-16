/**
 * 长程编排：需求文档与参考路径解析 —— 回归测试
 *
 * 逐条对译长程编排器 orchestrator/test_requirement.py 的 7 条 case_*，
 * 不合并、不省略、不重新设计。用例名保留原语义。
 *
 * 误报的代价很高：一条被错认成路径的字符串会让整个运行在启动前就停下，
 * 而且提示信息看着莫名其妙（"路径不存在: \u"）。所以重点覆盖
 * **什么不该被当成路径**。
 *
 * 运行: node tests/test-longrun-requirement.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  loadRequirement, renderRefsSection, extraDirsOf, IsolationViolation,
} from '../server/services/LongRunPrompts.js';

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

const TMP = path.join(os.tmpdir(), 'longrun_req_test');

/** 每个用例一块干净的临时目录 */
function freshTmp() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  return fs.realpathSync(TMP);
}

/**
 * 极简假沙箱：只实现 addExtraDir + 受保护根拒绝。
 * 真沙箱在 LongRunSandbox.js（下一个模块），这里只需要它的这一个契约。
 */
function fakeSpec(protectedRoot) {
  return {
    extraDirs: [],
    addExtraDir(p) {
      const rp = path.resolve(p);
      if (protectedRoot && (rp === protectedRoot || rp.startsWith(protectedRoot + path.sep))) {
        throw new IsolationViolation(
          `参考路径位于受保护项目内，拒绝挂载：\n  ${rp}`
        );
      }
      if (!this.extraDirs.includes(rp)) this.extraDirs.push(rp);
      return rp;
    },
  };
}

/** 只解析、不登记时用它取候选路径（对译 Python 里直接调 _candidates） */
function candidatesOf(text) {
  const dir = freshTmp();
  const doc = path.join(dir, '需求.md');
  fs.writeFileSync(doc, text, 'utf8');
  const req = loadRequirement(doc, null);
  // refs 是存在的路径，rejected 是识别出来但用不了的 —— 两者之和才是"被当成路径的"
  return [...req.refs.map((r) => r.path), ...req.rejected.map(([raw]) => raw)];
}

// ── 1. 转义示例不是路径 ──────────────────────────────────────
// 实测踩过：`\u` 被当成 UNC 路径导致运行被拦。
test('转义示例（\\u \\n \\\\）不被当成路径', () => {
  const text = [
    '保持中文原样输出，不要转成 \\u 转义。',
    '也不要出现 \\\\u 或 \\\\n 这类序列。',
    '路径分隔符用 \\\\ 表示。',
  ].join('\n');
  const found = candidatesOf(text);
  assert(found.length === 0, `转义示例被误认成路径: ${JSON.stringify(found)}`);
});

// ── 2. UNC 需两段 ───────────────────────────────────────────
test('UNC 需 \\\\主机\\共享名 两段才算路径', () => {
  const hit = candidatesOf('资料在 \\\\fileserver\\docs\\spec.md 里');
  assert(hit.length === 1, `应识别出 1 条 UNC，实际 ${JSON.stringify(hit)}`);
  assert(/fileserver/.test(hit[0]), `识别内容不对: ${hit[0]}`);
  const none = candidatesOf('用 \\\\ 分隔');
  assert(none.length === 0, `只有反斜杠不该算路径: ${JSON.stringify(none)}`);
});

// ── 3. 相对路径与函数签名都忽略 ───────────────────────────────
// 相对路径不解析：那会把需求里提到的待创建产出（src/cache.py）误当成参考资料。
test('相对路径与函数签名被忽略', () => {
  const text = [
    '产出放 `src/cache.py`，测试放 `tests/test_cache.py`。',
    '装饰器签名 `@cached(ttl=60)`。',
    '另见 ./规范.md 与 ../上级/x.md',
  ].join('\n');
  const found = candidatesOf(text);
  assert(found.length === 0, `不该识别出任何路径: ${JSON.stringify(found)}`);
});

// ── 4. 绝对路径（文件与目录）均识别 ──────────────────────────
test('绝对路径（文件与目录）均识别，文件挂其所在目录', () => {
  const src = freshTmp();
  fs.writeFileSync(path.join(src, 'spec.md'), 'x', 'utf8');
  const sub = path.join(src, '库');
  fs.mkdirSync(sub);
  const doc = path.join(src, '需求.md');
  fs.writeFileSync(doc,
    `规范见 \`${path.join(src, 'spec.md')}\`。\n资料在 ${sub} 目录。\n顺便 https://example.com/x\n`,
    'utf8');

  const spec = fakeSpec(null);
  const req = loadRequirement(doc, spec);
  const paths = req.refs.map((r) => r.path);
  assert(paths.includes(path.join(src, 'spec.md')), `缺文件引用: ${JSON.stringify(paths)}`);
  assert(paths.includes(sub), `缺目录引用: ${JSON.stringify(paths)}`);
  assert(req.urls.length === 1 && req.urls[0] === 'https://example.com/x', `URL 错: ${JSON.stringify(req.urls)}`);
  assert(req.rejected.length === 0, `不该有被拒项: ${JSON.stringify(req.rejected)}`);
  // 文件挂其所在目录，目录挂自身
  assert(spec.extraDirs.includes(src) && spec.extraDirs.includes(sub),
    `挂载目录不对: ${JSON.stringify(spec.extraDirs)}`);
  assert(extraDirsOf(req).includes(src), 'extraDirsOf 应含文件所在目录');
});

// ── 5. 受保护路径必须被拒 ────────────────────────────────────
// 那会给执行者真实记忆库的写权限，是整个隔离设计要防的头号情形。
test('受保护项目内的路径被拒绝挂载', () => {
  const src = freshTmp();
  const guarded = path.join(src, 'guarded_project');
  fs.mkdirSync(path.join(guarded, 'memory'), { recursive: true });
  const doc = path.join(src, '需求.md');
  fs.writeFileSync(doc, `参考 \`${path.join(guarded, 'memory')}\``, 'utf8');

  const spec = fakeSpec(guarded);
  const req = loadRequirement(doc, spec);
  assert(req.refs.length === 0, `受保护路径不该进 refs: ${JSON.stringify(req.refs)}`);
  assert(req.rejected.some(([, why]) => why.includes('受保护')),
    `拒绝原因应含"受保护": ${JSON.stringify(req.rejected)}`);
  assert(spec.extraDirs.length === 0, `不该挂载任何目录: ${JSON.stringify(spec.extraDirs)}`);
});

// ── 6. 绝对路径写错要报告 ────────────────────────────────────
// 用户明确写了完整路径，写错是真错误，不能静默忽略。
test('绝对路径不存在时明确报告', () => {
  const src = freshTmp();
  const doc = path.join(src, '需求.md');
  fs.writeFileSync(doc, '参考 `/nope_xyz_123/spec.md`', 'utf8');
  const req = loadRequirement(doc, fakeSpec(null));
  assert(req.refs.length === 0, '不存在的路径不该进 refs');
  assert(req.rejected.some(([, why]) => why.includes('不存在')),
    `拒绝原因应含"不存在": ${JSON.stringify(req.rejected)}`);
});

// ── 7. 参考清单措辞 ─────────────────────────────────────────
test('参考清单要求用绝对路径读取、不复制', () => {
  const src = freshTmp();
  fs.writeFileSync(path.join(src, 'a.md'), 'x', 'utf8');
  const doc = path.join(src, '需求.md');
  fs.writeFileSync(doc, `见 \`${path.join(src, 'a.md')}\``, 'utf8');
  const section = renderRefsSection(loadRequirement(doc, fakeSpec(null)));
  assert(section.includes('绝对路径'), `措辞缺"绝对路径": ${section}`);
  assert(section.includes('不要把它们复制'), `措辞缺"不要把它们复制": ${section}`);
});

await Promise.all(pending);
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败（对译 7 条）===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

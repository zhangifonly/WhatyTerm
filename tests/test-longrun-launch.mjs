/**
 * 长程编排：启动入口语义（start.py / resume.py / cli_common.load_req）—— 回归测试
 *
 * 沙箱名派生与需求正文拼装与原版 Python **逐字节对拍**（有 python3 时）；
 * 沙箱准备的拒绝分支断言"拒绝时什么都没动"。
 *
 * 运行: node tests/test-longrun-launch.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

// macOS 的临时目录是符号链接（/var → /private/var），沙箱根会被规范化，这里先取真实路径
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'longrun_launch_')));
process.env.LONGRUN_SANDBOX_BASE = BASE;
const L = await import('../server/services/LongRunLaunch.js');
const { orchestratorRoot } = await import('../server/services/LongRunSandbox.js');
const { renderRefsSection } = await import('../server/services/LongRunPrompts.js');

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
async function test(name, fn) {
  try { await fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}
const throwsLaunch = (fn, re) => {
  try { fn(); } catch (e) { assert(e instanceof L.LaunchError, `应抛 LaunchError，实际 ${e.constructor.name}: ${e.message}`);
    assert(!re || re.test(e.message), `报错文案不符: ${e.message}`); return; }
  throw new Error('应当拒绝却通过了');
};

/** 跑原版 Python 片段，拿 stdout（JSON）。没有 python3 或原版不在时返回 null。 */
function python(code) {
  const orch = orchestratorRoot();
  if (!fs.existsSync(path.join(orch, 'start.py'))) return null;
  const r = spawnSync('python3', ['-c', `import sys, json\nsys.path.insert(0, ${JSON.stringify(orch)})\n${code}`],
    { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  if (r.error || r.status !== 0) throw new Error(`python 失败: ${r.error?.message || r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

const NAMES = ['需求.md', '我的 项目!v2.md', '  ...  .md', 'a/b/深 层/说明.txt', 'x'.repeat(60) + '.md',
  'Café—naïve 設計書.md', '__init__.md', 'no_ext', 'emoji😀名.md', '-dash-.md'];

await test('沙箱名派生与 start.py derive_name 逐个一致', () => {
  const py = python(`from start import derive_name\nfrom pathlib import Path\nprint(json.dumps([derive_name(Path(n)) for n in ${JSON.stringify(NAMES)}], ensure_ascii=False))`);
  const js = NAMES.map(L.deriveSandboxName);
  if (!py) { console.log('   ⊘ 无原版可对拍，只查基本规则'); assert(js[0] === '需求' && js[2] === 'project'); return; }
  const diff = NAMES.map((n, i) => (py[i] === js[i] ? null : `${n}: py=${py[i]} js=${js[i]}`)).filter(Boolean);
  assert(diff.length === 0, `与原版不一致:\n  ${diff.join('\n  ')}`);
});

await test('沙箱名不合法时拒绝（路径分隔符、. 与 ..）', () => {
  for (const bad of ['', '.', '..', 'a/b', 'a\\b']) throwsLaunch(() => L.assertSandboxName(bad), /不合法/);
  assert(L.assertSandboxName('ok_名字') === 'ok_名字');
});

await test('新建：同名沙箱非空且未勾删掉重建 → 拒绝，里面的东西原样还在', () => {
  const root = path.join(BASE, 'keepme');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, '成果.txt'), '上一轮的产出');
  throwsLaunch(() => L.prepareFreshSandbox('keepme'), /续跑/);
  assert(fs.readFileSync(path.join(root, '成果.txt'), 'utf8') === '上一轮的产出', '拒绝时不能动已有成果');
});

await test('新建：勾了删掉重建才删；空目录或不存在直接放行', () => {
  const root = path.join(BASE, 'wipe');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'x');
  assert(L.prepareFreshSandbox('wipe', { fresh: true }) === root && !fs.existsSync(root), '应删掉重建');
  fs.mkdirSync(path.join(BASE, 'empty'), { recursive: true });
  assert(L.prepareFreshSandbox('empty') === path.join(BASE, 'empty'), '空目录不算已存在');
  assert(L.prepareFreshSandbox('never') === path.join(BASE, 'never'), '不存在直接放行');
});

await test('续跑：沙箱不存在 → 拒绝并列出已有沙箱；没有记忆文件 → 拒绝', () => {
  throwsLaunch(() => L.checkResumableSandbox('ghost'), /已有沙箱: .*keepme/);
  fs.mkdirSync(path.join(BASE, 'nomem', '.memory'), { recursive: true });
  throwsLaunch(() => L.checkResumableSandbox('nomem'), /没有记忆文件/);
  fs.writeFileSync(path.join(BASE, 'nomem', '.memory', 'MEMORY.md'), '- a');
  assert(L.checkResumableSandbox('nomem') === path.join(BASE, 'nomem'));
});

await test('上次运行痕迹：调用/交接/花费 + 记忆索引前 8 条与剩余条数', () => {
  const root = path.join(BASE, 'prior');
  fs.mkdirSync(path.join(root, '.run'), { recursive: true });
  fs.mkdirSync(path.join(root, '.memory'), { recursive: true });
  fs.writeFileSync(path.join(root, '.run', 'session_state.json'), JSON.stringify({ legs: 7, handoffs: 2, spent_usd: 3.5 }));
  const idx = ['# 索引', ...Array.from({ length: 11 }, (_, i) => `- [条目${i}](f${i}.md) — ${'很长'.repeat(60)}`)];
  fs.writeFileSync(path.join(root, '.memory', 'MEMORY.md'), idx.join('\n'));
  fs.writeFileSync(path.join(root, '.memory', 'f0.md'), 'x');
  const p = L.priorState(root);
  assert(p.legs === 7 && p.handoffs === 2 && p.spentUsd === 3.5 && p.memoryCount === 2, JSON.stringify(p));
  assert(p.memoryIndex.length === 8 && p.moreIndex === 3 && p.memoryIndex[0].length === 96, '前 8 条、每条截 96 字');
  const bare = L.priorState(path.join(BASE, 'ghost'));
  assert(bare.legs === null && bare.memoryCount === 0, '没有痕迹时不报错');
});

await test('参考路径失效默认停止，勾选忽略才放行', () => {
  const req = { rejected: [['/不存在/资料', '路径不存在']] };
  throwsLaunch(() => L.checkRejectedRefs(req), /已停止[\s\S]*忽略/);
  L.checkRejectedRefs(req, { allowMissingRefs: true });
  L.checkRejectedRefs({ rejected: [] });
});

await test('需求预检用真规则：指向受保护项目的参考路径被拒，且不建任何目录', () => {
  const doc = path.join(BASE, 'doc.md');
  fs.writeFileSync(doc, `# 需求\n参考 ${orchestratorRoot()}/README.md\n`);
  const before = fs.readdirSync(BASE).sort().join();
  const req = L.previewRequirement(doc);
  assert(req.rejected.length === 1 && /受保护/.test(req.rejected[0][1]), JSON.stringify(req.rejected));
  assert(fs.readdirSync(BASE).sort().join() === before, '预检不该建目录');
});

await test('需求正文拼装与 start.py / resume.py 逐字节一致（有无参考资料各一）', () => {
  // 参考段用真实渲染结果喂给两边（措辞另有用例锁死），这里只对拍拼装
  const reqs = [{ text: '# 做个待办\n\n要求……\n', refs: [], urls: [], rejected: [] },
    { text: '加导出功能', refs: [], urls: ['https://example.com'], rejected: [] }];
  const cases = reqs.map((r) => ({ text: r.text, refs: renderRefsSection(r) }));
  assert(cases[1].refs.includes('https://example.com'), '参考段应非空，否则有参考资料的分支没测到');
  const py = python(`
class R:
    def __init__(s, t, r): s.text, s.r = t, r
    def render_refs_section(s): return s.r
out = []
for c in ${JSON.stringify(cases)}:
    req = R(c['text'], c['refs'])
    requirement_input = req.text
    refs = req.render_refs_section()
    if refs:
        requirement_input += "\\n\\n---\\n\\n" + refs
    parts = ["以下是新增的需求。这不是重新开始，是在你已有的进度上继续。", "先按上面的要求确认当前进度，再把这部分做完。", "", "---", "", req.text]
    if refs:
        parts += ["", "---", "", refs]
    out.append([requirement_input, "\\n".join(parts)])
print(json.dumps(out, ensure_ascii=False))`);
  cases.forEach((c, i) => {
    const req = reqs[i];
    const js = [L.requirementInput(req), L.requirementInput(req, { resume: true })];
    if (py) {
      assert(js[0] === py[i][0], `新建拼装不一致:\n${JSON.stringify(js[0])}\n${JSON.stringify(py[i][0])}`);
      assert(js[1] === py[i][1], `续跑拼装不一致:\n${JSON.stringify(js[1])}\n${JSON.stringify(py[i][1])}`);
    } else {
      assert(js[1].startsWith('以下是新增的需求。') && js[1].includes(c.text));
    }
  });
});

fs.rmSync(BASE, { recursive: true, force: true });
console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

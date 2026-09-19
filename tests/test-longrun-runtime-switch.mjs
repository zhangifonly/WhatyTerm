/**
 * 运行中换供应商 / 换模型（右侧面板）。
 *
 * 为什么要有：Hitech 那两轮全败于「503 无可用渠道」，当时只能停机、改配置、重开一轮，
 * 已经跑出来的东西白扔。现在跑着就能换。
 *
 * 两条不可违反的约束：
 *   ① **下一发生效，不打断当前这发** —— loop 每次构造 runner 时才读 this.model，
 *      所以改完当前这发照常跑完。若改成立即重启执行者，这一发的成果就丢了。
 *   ② 换供应商必须**真的注入到执行者环境**。执行者继承 process.env、用 CC Switch 全局配置
 *      （childEnv 只做删减不做注入），光改 task.options.providerId 只会让面板显示换了、
 *      而请求照旧发往原来那家 —— 一个假按钮比没有按钮更坏。
 *
 * 运行: node tests/test-longrun-runtime-switch.mjs
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

const SVC = fs.readFileSync(path.join(ROOT, 'server/services/LongRunService.js'), 'utf8');
const LOOP = fs.readFileSync(path.join(ROOT, 'server/services/LongRunLoop.js'), 'utf8');
const IDX = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
const UI = fs.readFileSync(path.join(ROOT, 'src/components/longrun/LongRunRuntimeSwitch.jsx'), 'utf8');
const CARDS = fs.readFileSync(path.join(ROOT, 'src/components/longrun/LongRunSideCards.jsx'), 'utf8');

const seg = (src, from, len = 1600) => {
  const at = src.indexOf(from);
  return at < 0 ? '' : src.slice(at, at + len);
};

test('换模型：改 loop.model 即可，不重启执行者（当前这发的成果不能丢）', () => {
  const body = seg(SVC, 'setModel(taskId, model)');
  assert(body, '没找到 setModel');
  assert(/task\.loop\.model = /.test(body), '没有改 loop.model —— 那下一发还是老模型');
  assert(!/(abort|kill|restart|terminate)\s*\(/i.test(body), '切换时动了进程：当前这发会被打断，成果白扔');
  assert(/下一发生效/.test(body), '没告诉人何时生效');
});

test('换模型：人的选择要计进 triedModels，免得自动恢复又换回来', () => {
  const body = seg(SVC, 'setModel(taskId, model)');
  assert(/triedModels/.test(body), '没计进已试过 —— 自动恢复可能把人刚选的模型换掉');
});

test('换供应商：必须注入执行者环境，否则是个假按钮', () => {
  const body = seg(SVC, 'setProvider(taskId, providerId)', 2200);
  assert(body, '没找到 setProvider');
  assert(/envOverride/.test(body), '只改了 options，没注入环境 —— 面板显示换了，请求还发往原来那家');
  assert(/ANTHROPIC_BASE_URL/.test(body) && /ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY/.test(body),
    '注入的环境变量不全，地址与密钥都要给');
  // loop 侧必须真的把它并进子进程环境
  assert(/\.\.\.\(this\.envOverride \|\| \{\}\)/.test(LOOP) || /this\.envOverride/.test(seg(LOOP, 'env: {')),
    'loop 构造 runner 时没合并 envOverride，注入等于没写');
});

test('换供应商：地址不可用要拒绝，别把长程指到一个跑不通的地方', () => {
  const body = seg(SVC, 'setProvider(taskId, providerId)', 2200);
  assert(/resolveSessionSettings/.test(body), '没从 CC Switch 解析 —— 意味着可能硬编码或凭空取值');
  assert(/没有可用的 API 地址|apiUrl\)\s*return/.test(body), '没校验地址可用性');
  assert(!/sk-[A-Za-z0-9]{10}/.test(body), '疑似硬编码密钥');
});

test('换供应商：作废试过的模型清单（另一家支持的模型不一样）', () => {
  const body = seg(SVC, 'setProvider(taskId, providerId)', 2200);
  assert(/triedModels = /.test(body), '没重置 triedModels —— 会拿上一家的"已试过"去判断这一家');
  assert(/providerFailures = 0/.test(body), '没重置失败计数 —— 新供应商一上来就被当成第 N 次失败');
});

test('两个 socket 接口都在，且只对运行中的任务生效', () => {
  assert(/socket\.on\('longrun:setModel'/.test(IDX), '缺 longrun:setModel');
  assert(/socket\.on\('longrun:setProvider'/.test(IDX), '缺 longrun:setProvider');
  for (const fn of ['setModel(taskId, model)', 'setProvider(taskId, providerId)']) {
    assert(/this\._running\(taskId\)/.test(seg(SVC, fn, 300)), `${fn} 没校验任务在跑`);
  }
});

test('界面：换模型只从清单里选，拿不到清单才退回手填并说明风险', () => {
  assert(/longrun:providerModels/.test(UI), '没查模型清单');
  assert(/models\.ok && models\.models\?\.length/.test(UI), '没有"有清单就用下拉"的判断');
  assert(/无可用渠道/.test(UI), '手填时没提示填错的后果');
  assert(/\[open, currentProviderId\]/.test(UI), '换了供应商没重查模型清单 —— 会选出上一家才有的模型');
});

test('界面：说清下一发生效，以及换供应商的代价', () => {
  assert(/下一发生效/.test(UI), '没说何时生效，人会以为要重启');
  assert(/费用记在那边|发往那一家/.test(UI), '没说清换供应商意味着代码与费用去向变了');
  assert(/自动恢复从不替你换供应商/.test(UI), '没说明自动恢复与手动换的边界');
});

test('界面：只在任务运行中才出现（停机后改它没有意义）', () => {
  assert(/task\?\.state === 'running'/.test(CARDS), '没限定运行中才显示');
  assert(/if \(!running\) return null/.test(UI), '组件自己没兜住 running');
});

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

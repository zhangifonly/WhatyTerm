/**
 * 长程项目与终端会话同目录共存 —— 回归测试
 *
 * 长程项目改放到 ~/Documents/ClaudeCode/<项目名> 后，与传统会话共用目录与根，这里锁住三处串线：
 *   1. 执行者触发的全局 hook 不能算到同目录的终端会话头上（脚本透传标记、服务端丢弃）
 *   2. 按目录清孤儿进程不能按前缀误伤兄弟项目（Foo vs FooBar）
 *   3. 执行者专用配置只经 --settings 传给执行者
 *
 * 运行: node tests/test-longrun-coexist.mjs
 */

import fs from 'fs';
import { isLongRunHookRequest } from '../server/services/HookServer.js';
import HookServer from '../server/services/HookServer.js';
import { isPathWithin, argsMentionDir } from '../server/services/pathBoundary.js';
import { buildArgs } from '../server/services/LongRunRunner.js';

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
async function test(name, fn) {
  try { await fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}

await test('hook 脚本（bash 与 PowerShell）都透传长程标记', () => {
  const hs = Object.create(HookServer.prototype);
  Object.assign(hs, { serverPort: 3928, token: 't' });
  assert(hs._buildBashScript().includes('-H "X-Webtmux-Longrun: ${WEBTMUX_LONGRUN}"'), 'bash 脚本缺长程头');
  assert(hs._buildPowerShellScript().includes('X-Webtmux-Longrun", "$($env:WEBTMUX_LONGRUN)'), 'PowerShell 脚本缺长程头');
});

await test('只有标记为 1 的 hook 被当作长程执行者丢弃；终端会话（变量为空）照常', () => {
  assert(isLongRunHookRequest({ 'x-webtmux-longrun': '1' }));
  assert(isLongRunHookRequest({ 'x-webtmux-longrun': ' 1 ' }));
  for (const v of ['', '0', undefined, 'true']) assert(!isLongRunHookRequest({ 'x-webtmux-longrun': v }), `误判: ${v}`);
  assert(!isLongRunHookRequest({}));
});

await test('服务端 /hooks 在校验令牌之后、分发之前丢弃长程事件（源码守卫）', () => {
  const src = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  const route = src.slice(src.indexOf("app.post('/hooks'"), src.indexOf("app.get('/hooks/status'"));
  const token = route.indexOf('validateToken'), drop = route.indexOf('isLongRunHookRequest(req.headers)'), dispatch = route.indexOf('hookServer.dispatch');
  assert(token >= 0 && drop > token && dispatch > drop, `顺序不对: token=${token} drop=${drop} dispatch=${dispatch}`);
});

await test('路径边界：Foo 不包含 FooBar；本身、子路径、尾斜杠都算', () => {
  const D = '/Users/x/Documents/ClaudeCode/Foo';
  assert(isPathWithin(D, D) && isPathWithin(`${D}/src/a.js`, D) && isPathWithin(`${D}/`, D) && isPathWithin(D, `${D}/`));
  assert(!isPathWithin(`${D}Bar`, D) && !isPathWithin(`${D}Bar/x`, D) && !isPathWithin('/Users/x', D));
  assert(!isPathWithin('', D) && !isPathWithin(D, ''));
});

await test('命令行提到目录：边界之后必须是分隔符或结尾', () => {
  const D = '/Users/x/Documents/ClaudeCode/Foo';
  for (const args of [`node ${D}/node_modules/.bin/vite`, `vite --root ${D}`, `python -m http.server --directory=${D}`, `"${D}"`, `x ${D}:3000`]) {
    assert(argsMentionDir(args, D), `应命中: ${args}`);
  }
  for (const args of [`node ${D}Bar/vite.js`, `node ${D}-old/x`, 'node /other/place']) {
    assert(!argsMentionDir(args, D), `不应命中: ${args}`);
  }
  assert(argsMentionDir('cd /a.b/c', '/a.b') && !argsMentionDir('cd /aXb/c', '/a.b'), '目录里的正则元字符要转义');
});

await test('进程清理用边界判断，不再用 includes / startsWith（源码守卫）', () => {
  const src = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  const start = src.indexOf('function cleanupOrphanProcesses(');
  assert(start >= 0, '找不到 cleanupOrphanProcesses');
  const fn = src.slice(start, start + 6000);
  assert(fn.includes('argsMentionDir(info.args, workDir)') && fn.includes('isPathWithin(cwdOutput, workDir)'), '未改用边界判断');
  assert(!/info\.args\.includes\(workDir\)|cwdOutput\.startsWith\(workDir\)/.test(fn), '仍残留前缀匹配');
});

await test('执行者专用配置经 --settings 传入；没有就不加这个参数', () => {
  const withFile = buildArgs({ sessionId: 's', settingsFile: '/p/.run/executor-settings.json' });
  const i = withFile.indexOf('--settings');
  assert(i > 0 && withFile[i + 1] === '/p/.run/executor-settings.json', withFile.join(' '));
  assert(!buildArgs({ sessionId: 's' }).includes('--settings'));
});

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exit(results.failed ? 1 : 0);

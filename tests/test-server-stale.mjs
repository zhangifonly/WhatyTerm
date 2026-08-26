/**
 * 服务端陈旧代码自检 —— 回归测试
 *
 * 背景：改完代码不重启，磁盘上是新版、进程里跑的还是旧版，而界面上完全看不出来。
 * 状态判定逻辑全在服务端，于是所有修复都"看起来没生效"。
 * 实测连续发生三次（会话供应商 v1.2.62、面板识别 v1.2.65、以及第三次复现），
 * 每次都白排查一轮才想起来查进程启动时间。
 *
 * 本测试锁住：版本快照在模块加载时固定、磁盘版本每次重读、两者不一致时报 stale。
 *
 * 运行：node tests/test-server-stale.mjs
 */

import fs from 'fs';
import path from 'path';

const results = { passed: 0, failed: 0, errors: [] };

function test(name, fn) {
  try {
    fn();
    results.passed++;
    console.log(`✅ ${name}`);
  } catch (err) {
    results.failed++;
    results.errors.push({ name, error: err.message });
    console.log(`❌ ${name}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }

const SRC = fs.readFileSync(path.join(process.cwd(), 'server/index.js'), 'utf8');
const APP = fs.readFileSync(path.join(process.cwd(), 'src/App.jsx'), 'utf8');

test('启动版本在模块加载时就固定下来（不是每次调用现读）', () => {
  assert(/const BOOT_TIME = new Date\(\)\.toISOString\(\);/.test(SRC), '缺少启动时刻快照');
  assert(/let BOOT_VERSION = 'unknown';/.test(SRC), '缺少启动版本快照');
  // 必须在顶层读一次，而不是放进函数里懒加载 —— 懒加载会读到改动后的新版本，
  // 那样 stale 永远为 false，自检形同虚设
  const bootIdx = SRC.indexOf('BOOT_VERSION = JSON.parse');
  const routeIdx = SRC.indexOf("app.get('/api/server/state'");
  assert(bootIdx > 0 && bootIdx < routeIdx, '启动版本不是在模块顶层读取的');
});

test('磁盘版本每次重新读取', () => {
  assert(/function readDiskVersion\(\)/.test(SRC), '缺少 readDiskVersion');
  assert(/const diskVersion = readDiskVersion\(\);/.test(SRC), '接口未实时读磁盘版本');
});

test('两者不一致才报 stale，读不到版本时不误报', () => {
  // 注意：文件里另有一处供应商配置的 stale 字段，必须限定在本接口的返回体内取，
  // 否则会抓错那一处（本测试第一版就踩了这个）
  const routeIdx = SRC.indexOf("app.get('/api/server/state'");
  assert(routeIdx > 0, '未找到 /api/server/state 路由');
  const body = SRC.slice(routeIdx, routeIdx + 800);
  const m = body.match(/stale: ([^\n]+)/);
  assert(m, '接口未返回 stale');
  const expr = m[1];
  assert(/BOOT_VERSION !== diskVersion/.test(expr), 'stale 判据不是版本比对');
  assert(/'unknown'/.test(expr), "读不到版本(unknown)时会误报 stale");
});

test('接口返回足够定位问题的信息（版本 + 启动时刻）', () => {
  for (const field of ['bootVersion', 'diskVersion', 'startedAt']) {
    assert(new RegExp(`${field}[,:]`).test(SRC), `接口缺少 ${field}`);
  }
});

test('前端会轮询并渲染告警条', () => {
  assert(/\/api\/server\/state/.test(APP), '前端未拉取服务端状态');
  assert(/setInterval\(checkServerState/.test(APP), '只拉一次，重启后不会自动消除告警');
  assert(/server-stale-banner/.test(APP), '未渲染告警条');
});

test('轮询定时器在 effect 清理里释放', () => {
  assert(/clearInterval\(staleTimer\)/.test(APP), '定时器未清理');
  // 原来的 cleanup 写在 if (socket) 里面，socket 为空时整个清理函数都不返回
  const cleanupIdx = APP.indexOf('clearInterval(staleTimer)');
  const before = APP.slice(Math.max(0, cleanupIdx - 400), cleanupIdx);
  assert(!/if \(socket\) \{[^}]*$/.test(before), '清理函数仍嵌在 if (socket) 内，socket 为空时会漏');
});

test('CSS 里有告警条样式（没样式等于没提示）', () => {
  const css = fs.readFileSync(path.join(process.cwd(), 'src/index.css'), 'utf8');
  assert(/\.server-stale-banner\s*\{/.test(css), '缺少告警条样式');
});

test('版本真能读出来 —— 不是只在源码里长得对', async () => {
  // 血的教训：第一版写成 fs.readFileSync，而这个文件是具名导入
  //（import { readFileSync } from 'fs'），根本没有 fs 命名空间。
  // ReferenceError 被 try/catch 吞掉，版本恒为 unknown、stale 恒为 false，
  // 自检形同虚设，而所有源码文本断言全部通过。所以必须真跑一次。
  const m = SRC.match(/const PKG_PATH = ([^\n;]+);/);
  assert(m, '未找到 PKG_PATH');
  const { readFileSync } = await import('fs');
  const { join } = await import('path');
  const serverDir = path.join(process.cwd(), 'server');
  const pkgPath = join(serverDir, '../package.json');
  const version = JSON.parse(readFileSync(pkgPath, 'utf-8')).version;
  assert(version && version !== 'unknown', `按 PKG_PATH 的算法读不到版本：${pkgPath}`);

  // 并且不能用文件里不存在的 fs 命名空间
  assert(!/BOOT_VERSION = JSON\.parse\(fs\./.test(SRC),
    'BOOT_VERSION 用了 fs. 命名空间，但本文件是具名导入，会静默失败');
  assert(!/return JSON\.parse\(fs\.readFileSync\(PKG_PATH/.test(SRC),
    'readDiskVersion 用了 fs. 命名空间，会静默失败');
});

// ============ 重启后清理前端残留判定 ============
//
// 症状：修复上线并重启后，面板仍在显示重启前那条「命令有破坏性」告警，
// 看上去就像"改了没生效"。实际是前端的 aiStatusMap 只合并、从不清空，
// 服务端内存缓存已随重启清零，前端却留着上个进程的判定，
// 一直显示到该会话下一次分析为止 —— 而检测间隔会翻倍到 30 分钟。

test('服务端重启（startedAt 变化）时清空前端 AI 判定', () => {
  assert(/serverStartedAtRef/.test(APP), '未记录服务端启动时刻');
  assert(/setAiStatusMap\(\{\}\)/.test(APP), '重启后未清空 aiStatusMap');
});

test('只在启动时刻真的变了时清空，网络抖动重连不误清', () => {
  const idx = APP.indexOf('setAiStatusMap({})');
  assert(idx > 0, '未找到清空逻辑');
  const before = APP.slice(Math.max(0, idx - 300), idx);
  assert(/prev && prev !== d\.startedAt/.test(before),
    '无条件清空会在每次重连（含网络抖动）都把面板清白');
});

test('socket 重连时立即核对，不只靠 60 秒轮询', () => {
  const connectIdx = APP.indexOf("socket.on('connect'");
  assert(connectIdx > 0, '未找到 connect 处理');
  const body = APP.slice(connectIdx, connectIdx + 900);
  assert(/\/api\/server\/state/.test(body),
    '重连时不核对的话，重启后最长有一分钟仍在显示旧判定');
});

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exit(results.failed ? 1 : 0);

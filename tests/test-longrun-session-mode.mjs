/**
 * 会话运行模式（长程 / 终端同一条目）—— 回归测试
 *
 * 长程是会话条目的一种运行模式：runMode = 'longrun' 时 tmux 里只有 shell。锁住：
 *   1. 模式判断与"同目录会话"查找（纯函数）
 *   2. SessionManager 把三列（run_mode / origin / claude_session_id）存、读、关闭后恢复都带上（源码守卫：真库不能在测试里写）
 *   3. 监控三处入口与附着分析跳过长程模式（否则会对空 shell 发 claude -c、按键、改 goal）
 *   4. 绑定器：同目录 claude 在跑就拒绝；切模式时关掉自动操作
 *
 * 运行: node tests/test-longrun-session-mode.mjs
 */

import fs from 'fs';
import { isLongRunMode, sessionsInDir } from '../server/services/sessionMode.js';

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
async function test(name, fn) {
  try { await fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}
const src = (f) => fs.readFileSync(new URL(`../server/${f}`, import.meta.url), 'utf8');
const between = (text, from, len = 4000) => { const i = text.indexOf(from); assert(i >= 0, `找不到: ${from}`); return text.slice(i, i + len); };

await test('模式判断：只有 runMode=longrun 算长程；缺省与其它值都是终端', () => {
  assert(isLongRunMode({ runMode: 'longrun' }));
  for (const s of [{}, { runMode: 'terminal' }, { runMode: 'LONGRUN' }, null, undefined]) assert(!isLongRunMode(s), JSON.stringify(s));
});

await test('同目录会话：精确到目录本身（尾斜杠不影响），不含子目录与前缀相同的兄弟目录', () => {
  const D = '/w/ClaudeCode/Foo';
  const list = [{ id: 1, workingDir: D }, { id: 2, workingDir: `${D}/` }, { id: 3, workingDir: `${D}/sub` },
    { id: 4, workingDir: `${D}Bar` }, { id: 5, workingDir: '' }, { id: 6 }];
  assert(JSON.stringify(sessionsInDir(list, D).map((s) => s.id)) === '[1,2]', JSON.stringify(sessionsInDir(list, D)));
  assert(sessionsInDir(null, D).length === 0);
});

await test('SessionManager：三列建表迁移、保存、两处恢复、关闭、从已关闭恢复都带上', () => {
  const sm = src('services/SessionManager.js');
  for (const col of ['run_mode', 'origin', 'claude_session_id']) {
    assert(sm.includes(`ADD COLUMN ${col}`), `缺迁移: ${col}`);
  }
  assert(/for \(const table of \['sessions', 'closed_sessions'\]\)/.test(sm), 'closed_sessions 也要补列，关了再恢复不丢');
  const save = between(sm, '_saveSession(session) {', 3000);
  assert(save.includes('run_mode, origin, claude_session_id)') && save.includes("session.runMode || 'terminal'"), '保存缺列');
  assert((sm.match(/session\.runMode = row\.run_mode === 'longrun' \? 'longrun' : 'terminal';/g) || []).length === 2, '两处恢复都要读 run_mode');
  // 五处写已关闭表（手动关闭 + 启动时 tmux 已不在而搬移的四处）都要带三列，否则长程条目搬移后丢模式
  const inserts = sm.split('INSERT OR REPLACE INTO closed_sessions').slice(1).map((x) => x.slice(0, 1200));
  assert(inserts.length === 5, `写已关闭表的位置数变了: ${inserts.length}`);
  inserts.forEach((x, i) => assert(x.includes('closed_at, run_mode, origin, claude_session_id)'), `第 ${i + 1} 处没写三列`));
  assert((sm.match(/row\.run_mode \|\| 'terminal', row\.origin \|\| null, row\.claude_session_id \|\| null/g) || []).length === 4, '四处搬移的参数要带上三列');
  assert((sm.match(/claudeSessionId: closedSession\.claudeSessionId,/g) || []).length === 2, '从已关闭恢复（两种模式）都要带回');
  const json = between(sm, '  toJSON() {', 2500);
  assert(json.includes("runMode: this.runMode || 'terminal'") && json.includes('claudeSessionId:'), 'toJSON 缺字段');
});

await test('六条写入语句在真实 SQLite（内存库、跑完建表与迁移）里列数、占位符、参数个数都对得上', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { SessionManager } = await import('../server/services/SessionManager.js');
  const fake = { _getDbPath: () => ':memory:' };
  SessionManager.prototype._initDb.call(fake);
  const sm = src('services/SessionManager.js');
  const sqls = [...sm.matchAll(/prepare\(`\s*(INSERT OR REPLACE INTO (?:sessions|closed_sessions)[\s\S]*?)`\)/g)];
  assert(sqls.length === 6, `写入语句数变了: ${sqls.length}`);
  for (const m of sqls) {
    const sql = m[1];
    const cols = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map((c) => c.trim()).filter(Boolean);
    const marks = (sql.match(/\?/g) || []).length;
    assert(cols.length === marks, `列 ${cols.length} ≠ 占位符 ${marks}: ${sql.slice(0, 80)}`);
    // 紧跟的 stmt.run(...) 顶层参数个数
    const after = sm.slice(m.index + m[0].length);
    const open = after.indexOf('.run(') + 5;
    let depth = 1, i = open, args = 1, quote = null;
    for (; i < after.length && depth > 0; i++) {
      const c = after[i];
      if (quote) { if (c === quote && after[i - 1] !== '\\') quote = null; continue; }
      if (c === "'" || c === '"' || c === '`') quote = c;
      else if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth--;
      else if (c === ',' && depth === 1) args++;
    }
    // 行尾注释里的逗号不算；最后一个参数后面跟着逗号（尾逗号）时少算一个
    const raw = after.slice(open, i - 1).replace(/\/\/[^\n]*/g, '').trim();
    const argCount = raw.endsWith(',') ? args - 1 : args;
    assert(argCount === marks, `参数 ${argCount} ≠ 占位符 ${marks}: ${sql.slice(0, 80)}`);
    fake.db.prepare(sql).run(...cols.map((c) => (/(_at|stats_|ai_enabled|auto_mode|auto_action|rounds)/.test(c) ? 0 : 'x')));
  }
  const row = fake.db.prepare('SELECT run_mode, origin, claude_session_id FROM closed_sessions LIMIT 1').get();
  assert(row && 'run_mode' in row, '迁移后应有三列');
});

await test('新建 tmux 直接落到工作目录，路径用单引号字面量（引号/$ 不出错）', () => {
  const sm = src('services/SessionManager.js');
  assert(sm.includes("const cwdArg = this.workingDir ? ` -c ${quoteSq(this.workingDir)}` : '';"), '缺 -c');
  assert(sm.includes('-x 80 -y 24${cwdArg}`'), 'new-session 没带上 -c');
  const quoteSq = new Function(`${between(sm, 'function quoteSq(value) {', 200).split('\n}')[0]}\n}; return quoteSq;`)();
  assert(quoteSq("/a/it's $HOME/`x`") === "'/a/it'\\''s $HOME/`x`'", quoteSq("/a/it's $HOME/`x`"));
});

await test('监控三处入口与附着分析都跳过长程模式', () => {
  const idx = src('index.js');
  for (const fn of ['async function updateAllSessionsProjectInfo()', 'async function runBackgroundAutoAction()', 'async function runBackgroundStatusAnalysis()']) {
    assert(between(idx, fn, 2500).includes('sessionManager.listSessions().filter((s) => !isLongRunMode(s))'), `${fn} 没跳过长程模式`);
  }
  assert(between(idx, 'async function handleAIAnalysis(sessionId, session, socket) {', 200).includes('if (isLongRunMode(session)) return;'), '附着分析没跳过');
});

await test('绑定器：同目录 claude 在跑先拒绝再动条目；切模式时关自动操作、记来历、广播', () => {
  const bind = between(src('index.js'), 'const longRunSessionBinder = {', 2500);
  const refuse = bind.indexOf('processDetector.isCliRunning'), create = bind.indexOf('this._create('), mode = bind.indexOf("session.runMode = 'longrun'");
  assert(refuse > 0 && create > refuse && mode > create, '必须先检查 CLI 在跑、再建/改条目');
  assert(bind.includes("session.origin = 'longrun'") && bind.includes('session.autoActionEnabled = false') && bind.includes("io.emit('sessions:updated'"));
  assert(bind.includes('createSession({ name: projectName, workingDir: root, projectName })'), '新建条目要带工作目录');
  const mk = between(src('index.js'), 'async _create(root, projectName) {', 400);
  assert(/mkdirSync\(root, \{ recursive: true \}\);[\s\S]*createSession\(/.test(mk), '建条目前必须先建目录，否则 tmux -c 落到主目录');
  // 只看记录的入口：已有同目录条目原样返回，绝不能把传统会话切成长程模式
  const open = between(bind, 'async open(root, { projectName }) {', 400);
  const early = open.indexOf('if (existing.length) return existing[0].id;'), flip = open.indexOf("session.runMode = 'longrun'");
  assert(early > 0 && flip > early && open.slice(0, flip).includes('this._create('), '打开项目：已有条目要在改模式之前直接返回');
});

await test('socket 处理器把项目参数转给服务层（按字段挑选时漏掉 projectRoot 会让预检看错目录）', () => {
  const idx = src('index.js');
  const plan = between(idx, "socket.on('longrun:plan',", 400), replay = between(idx, "socket.on('longrun:replay',", 300);
  assert(/longRunService\.plan\(\{[^}]*projectRoot, projectName[^}]*\}\)/.test(plan), '预检没转发 projectRoot/projectName');
  assert(/longRunService\.replay\(\{[^}]*projectRoot[^}]*\}\)/.test(replay), '回放没转发 projectRoot');
});

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

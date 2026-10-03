/**
 * Kiro CLI 接入（server/services/kiroCli.js）。屏幕样本是 kiro-cli 2.26.0 实抓（tests/fixtures/screens/kiro-*.txt）。
 *   ① 空闲 / 运行中 / 确认框 / 一轮结束 四种屏都判对；带色码也判对
 *   ② 确认框里光标被移到「Trust…」上：判为确认框但 pointerOnYes=false（不能替人按回车，回车会选中 Trust）
 *   ③ 不是 Kiro 的屏（Claude 的空闲屏）不认成 Kiro
 *   ④ credits：只算 since 之后结束的轮次，今天的单独算；别的目录不算
 *   ⑤ 历史项目三处来源（V2 文件、V3 目录、V1 数据库）都能读到，同目录取最近
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { detectKiroState, looksLikeKiro, kiroCredits, listKiroSessions, listKiroProjectDirs } from '../server/services/kiroCli.js';

let pass = 0, fail = 0;
const test = (n, fn) => { try { fn(); pass++; console.log(`✅ ${n}`); } catch (e) { fail++; console.log(`❌ ${n}\n    ${e.message}`); } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); };
const fx = (n) => fs.readFileSync(new URL(`./fixtures/screens/kiro-${n}.txt`, import.meta.url), 'utf-8');

test('① 四种实抓屏幕判对', () => {
  eq(detectKiroState(fx('idle'))?.state, 'idle', '空闲');
  eq(detectKiroState(fx('running'))?.state, 'running', '运行中');
  eq(detectKiroState(fx('confirm')), { state: 'confirm', pointerOnYes: true }, '确认框');
  eq(detectKiroState(fx('done'))?.state, 'idle', '一轮结束');
  eq(detectKiroState(fx('idle'))?.contextPct, 4, '上下文占用');
});

test('① 带色码（capture-pane -e）也认得出是 Kiro', () => {
  const colored = fx('idle').replace('kiro_default', '\x1b[38;5;141mkiro_default\x1b[39m').replace('ask a question', '\x1b[2mask\x1b[22m a question');
  eq(looksLikeKiro(colored), true, '色码');
});

test('② 光标不在 Yes 上：仍是确认框，但不能按回车', () => {
  const moved = fx('confirm').replace(' ❯ Yes, single permission', '   Yes, single permission').replace('   Trust, always', ' ❯ Trust, always');
  eq(detectKiroState(moved), { state: 'confirm', pointerOnYes: false }, '光标移走');
});

test('③ Claude 的空闲屏不认成 Kiro', () => {
  const claude = '⏺ 完成\n\n────────\n❯ \n────────\n  ⏵⏵ accept edits on (shift+tab to cycle)\n';
  eq(looksLikeKiro(claude), false, 'claude');
  eq(detectKiroState(claude), null, 'claude 状态');
});

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-test-'));
const turn = (end, credits) => ({ end_timestamp: new Date(end).toISOString(), metering_usage: credits.map((v) => ({ value: v, unit: 'credit', unitPlural: 'credits' })) });
function writeV2(dir, id, cwd, turns, updated) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ session_id: id, cwd, updated_at: new Date(updated).toISOString(),
    session_state: { conversation_metadata: { user_turn_metadatas: turns }, rts_model_state: { model_info: { model_id: 'auto' } } } }));
}

test('④ credits：since 之前的轮次不算；今天单独算；别的目录不算', () => {
  const dir = path.join(TMP, 'v2a');
  const day = new Date('2026-10-03T00:00:00').getTime();
  writeV2(dir, 'a', '/w/proj', [turn(day - 3600e3, [1]), turn(day + 3600e3, [0.05, 0.02]), turn(day + 7200e3, [0.5])], day + 7200e3);
  writeV2(dir, 'b', '/w/other', [turn(day + 3600e3, [9])], day + 3600e3);
  const c = kiroCredits('/w/proj', { since: day - 1800e3, dayStart: day, sessions: listKiroSessions(dir) });
  eq(Math.round(c.credits * 100) / 100, 0.57, '累计（不含 since 之前那轮的 1，不含别的目录的 9）');
  eq(Math.round(c.todayCredits * 100) / 100, 0.57, '今天');
  eq(c.model, 'auto', '模型');
});

test('⑤ 历史项目：V2 / V3 / V1 三处都读到，同目录取最近', () => {
  const home = path.join(TMP, 'home');
  writeV2(path.join(home, '.kiro', 'sessions', 'cli'), 'x', '/w/v2proj', [], 3000);
  const v3 = path.join(home, '.kiro', 'sessions', 'abc123', 'sess_1');
  fs.mkdirSync(v3, { recursive: true });
  fs.writeFileSync(path.join(v3, 'session.json'), JSON.stringify({ workspacePaths: ['/w/v3proj'], lastModifiedAt: new Date(2000).toISOString() }));
  const v1dir = path.join(home, 'Library', 'Application Support', 'kiro-cli');
  fs.mkdirSync(v1dir, { recursive: true });
  const db = new Database(path.join(v1dir, 'data.sqlite3'));
  db.exec('CREATE TABLE conversations_v2 (key TEXT, conversation_id TEXT, value TEXT, created_at INTEGER, updated_at INTEGER)');
  db.prepare('INSERT INTO conversations_v2 VALUES (?,?,?,?,?)').run('/w/v1proj', 'c1', '{}', 1, 1000);
  db.prepare('INSERT INTO conversations_v2 VALUES (?,?,?,?,?)').run('/w/v2proj', 'c2', '{}', 1, 5000);   // 同目录更近
  db.close();
  const r = listKiroProjectDirs({ home, openDb: (f) => new Database(f, { readonly: true }) });
  eq(r.map((p) => p.path), ['/w/v2proj', '/w/v3proj', '/w/v1proj'], '三处来源、按时间排');
  eq(r[0].lastUsed, 5000, '同目录取最近');
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);

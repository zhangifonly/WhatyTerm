/**
 * 长程编排：事后回放（原版 view.py 的移植）
 *
 * 读 <沙箱>/.run/orchestrator.jsonl，按顺序喂给一个回放模式的看板状态。前端与实时看板同一份，只多「回放」标记。
 * 只能回放**这个文件存在的轮次**：.run/events/*.jsonl 是 CLI 原始事件，层级不同，
 * 恢复不出"哪一发发的是哪段提示词、监督者判了什么"。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { LongRunBoard, pyStr, pyFixed } from './LongRunBoard.js';
import { sandboxBase, assertSandboxName, listLongRunProjects } from './LongRunLaunch.js';
import { assertSandboxed } from './LongRunSandbox.js';

export const EVENTS_FILE = 'orchestrator.jsonl';

/**
 * 读事件文件。坏行跳过并计数，不让一行截断的 JSON 废掉整轮回放 ——
 * 编排器被强杀时最后一行常常只写了一半。
 */
export function loadEvents(file) {
  const events = [];
  let bad = 0;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { bad += 1; continue; }
    if (ev && typeof ev === 'object' && !Array.isArray(ev) && ev.kind) events.push(ev);
    else bad += 1;
  }
  return { events, bad };
}

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

/** 按名字找跑过长程的项目：先项目根、再旧沙箱根；都没有就按项目根拼（用于报"不存在"）。 */
function rootByName(name) {
  const n = assertSandboxName(name);
  const hit = listLongRunProjects().find((p) => p.name === n);
  return hit ? hit.root : path.join(sandboxBase(), n);
}

/**
 * 回放一轮。{projectRoot} 项目绝对路径；{sandboxName} 按名字找；{file} 直接给事件文件（优先）。
 * @returns {{ok:true, file, sandboxRoot, count, bad, spanMinutes, notices:string[], snapshot}
 *          | {ok:false, error:string}}
 */
export function replay({ sandboxName, projectRoot, file } = {}) {
  let evFile, root;
  if (file) {
    evFile = path.resolve(String(file));
    // WebTmux 可经隧道远程访问：只认编排器事件文件名，不当成任意文件读取口
    if (path.basename(evFile) !== EVENTS_FILE) {
      return { ok: false, error: `只能回放 ${EVENTS_FILE}，收到: ${evFile}` };
    }
    root = path.dirname(path.dirname(evFile));
  } else if (projectRoot || sandboxName) {
    try {
      root = projectRoot ? assertSandboxed(String(projectRoot), '项目目录') : rootByName(sandboxName);
    } catch (e) { return { ok: false, error: e.message }; }
    evFile = path.join(root, '.run', EVENTS_FILE);
  } else {
    return { ok: false, error: `要么给项目目录，要么给 ${EVENTS_FILE} 路径` };
  }

  if (!existsSync(evFile) || !statSync(evFile).isFile()) {
    // 说清是"这轮太老"还是"名字写错了" —— 两者的下一步动作完全不同
    const lines = [`事件文件不存在: ${evFile}`];
    if (isDir(root)) {
      lines.push('  沙箱在，但没有编排器事件文件。这一轮是 2026-09-08 之前跑的，',
        '  那时 emit() 还不落盘，编排器层事件（发了哪段提示词、', '  监督者判了什么）永久缺失，回放不出来。');
      const evDir = path.join(root, '.run', 'events');
      if (isDir(evDir)) {
        const n = readdirSync(evDir).filter((f) => f.endsWith('.jsonl')).length;
        lines.push(`  只剩 ${n} 个 CLI 原始事件文件在 ${evDir}，可手工翻。`);
      }
    } else {
      lines.push(`  沙箱目录也不存在: ${root}`);
    }
    return { ok: false, error: lines.join('\n') };
  }

  const { events, bad } = loadEvents(evFile);
  if (!events.length) return { ok: false, error: `事件文件里没有可回放的事件: ${evFile}` };

  const now = Date.now() / 1000;
  // started_at／replay_until 取事件区间，让"耗时"显示那一轮真实跑了多久
  const board = new LongRunBoard({
    title: `回放 ${path.basename(root)}`, sandbox: root, replay: true,
    startedAt: events[0].at || now, replayUntil: events.at(-1).at || now,
  });
  for (const ev of events) board.handle(ev);
  // 需求全文不在事件流里：从第一条"需求"类的 send 取（新建是需求文档，续跑是新需求文档）
  const req = events.find((ev) => ev.kind === 'send' && String(ev.label ?? '').includes('需求'));
  if (req) board.requirement = pyStr('text' in req ? req.text : '');   // str(None) 是 'None'，与原版一致

  const notices = [];
  if (bad) notices.push(`⚠ 跳过 ${bad} 行无法解析的事件（多半是最后一行被截断）`);
  const span = ((events.at(-1).at || 0) - (events[0].at || 0)) / 60;
  return { ok: true, file: evFile, sandboxRoot: root, count: events.length, bad,
    spanMinutes: Number(pyFixed(span, 0)), notices, snapshot: board.snapshot() };
}

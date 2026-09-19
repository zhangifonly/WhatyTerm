/**
 * 长程编排：启动入口语义（对应原版 start.py / resume.py / cli_common.py）
 *
 * 两个入口的差别只有三处：沙箱是新建还是沿用、要不要发初始化提示词、
 * 需求文档是"项目需求"还是"新增需求"。其余全部相同。
 *
 * 原版把检查结果打印到终端；这里收集成自检清单（{level, text}），由面板展示。
 * 原版 sys.exit(2) 的地方这里抛 LaunchError，启动前拦下。
 */

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'fs';
import path from 'path';
import { LongRunSandbox, sandboxRoots, assertSandboxed } from './LongRunSandbox.js';
import { loadRequirement, refDisplay, extraDirsOf, renderRefsSection } from './LongRunPrompts.js';

/** 启动前的硬失败（原版 exit 2）。message 是给人看的完整说明。 */
export class LaunchError extends Error {}

/** 新项目的默认根（~/Documents/ClaudeCode）。复用隔离层那份，不另写 —— 两处各写一份迟早走偏。 */
export const sandboxBase = () => sandboxRoots()[0];

/**
 * 从文档名派生项目名（start.py derive_name）：非法字符换下划线，去首尾下划线，截 40 字。
 * Python 的 \w 带 re.U 认 Unicode 字母数字，JS 要显式写 \p{L}\p{N}。
 */
export function deriveSandboxName(docPath) {
  const stem = path.basename(String(docPath || '')).replace(/\.[^.]*$/, '');
  const name = stem.replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '');
  return name.slice(0, 40) || 'project';
}

/** 项目名校验：不能含路径分隔符，也不能是 . / ..（会逃出项目根）。 */
export function assertSandboxName(name) {
  const n = String(name || '');
  if (!n || /[\\/]/.test(n) || n === '.' || n === '..') {
    throw new LaunchError(`项目名不合法: ${JSON.stringify(n)}（不能为空、不能含路径分隔符）`);
  }
  return n;
}

/**
 * 解析要用的项目目录：给了绝对路径就用它（必须在允许的根下），否则按名字放在项目根下。
 * 返回规范化后的绝对路径。
 */
export function resolveProjectRoot({ projectRoot, projectName } = {}) {
  let root;
  if (projectRoot) {
    if (!path.isAbsolute(String(projectRoot))) throw new LaunchError(`项目目录必须是绝对路径: ${projectRoot}`);
    root = String(projectRoot);
  } else {
    root = path.join(sandboxBase(), assertSandboxName(projectName));
  }
  try { return assertSandboxed(root, '项目目录'); } catch (e) { throw new LaunchError(e.message); }
}

const nonEmptyDir = (p) => {
  try { return statSync(p).isDirectory() && readdirSync(p).length > 0; } catch { return false; }
};

/** 有长程运行记录（跑过长程）的判据。删除保护与续跑列表都认它。 */
export const hasLongRunRecord = (root) => existsSync(path.join(root, '.run', 'session_state.json'))
  || existsSync(path.join(root, '.run', 'orchestrator.jsonl'));

/**
 * 目录现状：missing 不存在 | empty 空目录 | longrun 跑过长程 | project 已有内容但没跑过长程（传统项目）
 */
export function projectDirState(root) {
  if (!existsSync(root)) return 'missing';
  if (!nonEmptyDir(root)) return 'empty';
  return hasLongRunRecord(root) ? 'longrun' : 'project';
}

/** 跑过长程的项目（项目根下一层 + 旧沙箱根下一层），供续跑与回放列表用。 */
export function listLongRunProjects() {
  const out = [];
  for (const [i, base] of sandboxRoots().entries()) {
    let names = [];
    try { names = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { continue; }
    for (const name of names) {
      const root = path.join(base, name);
      if (hasLongRunRecord(root)) out.push({ name, root, legacy: i > 0 });
    }
  }
  return out;
}

/** 兼容旧调用：跑过长程的项目名。 */
export const listSandboxes = () => listLongRunProjects().map((p) => p.name);

/** 记忆文件（.memory/*.md）。续跑的前提是有东西可续。 */
export function memoryFiles(root) {
  const dir = path.join(root, '.memory');
  try { return readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch { return []; }
}

/**
 * 按启动方式检查目录（start.py prepare_sandbox / resume.py open_sandbox 的检查部分）：
 *   start    新项目：目录不存在或为空。跑过长程的要么续跑、要么明确勾「删掉重建」；
 *            **已有传统项目一律拒绝**并指向「接管」—— 名字撞上已有项目时绝不能动它
 *   takeover 接管已有传统项目：不删、不覆盖，记忆从 Claude 默认位置复制进来
 *   resume   续跑：必须跑过长程且有记忆文件
 */
export function prepareProject(root, { mode = 'start', fresh = false } = {}) {
  const state = projectDirState(root);
  if (mode === 'resume') {
    if (state === 'missing') throw new LaunchError(`项目不存在: ${root}\n  新项目请用「新建」。`);
    if (!memoryFiles(root).length) {
      throw new LaunchError(`项目 ${path.basename(root)} 里没有记忆文件（${path.join(root, '.memory')}）。\n`
        + '  它可能从未成功跑过初始化。新目录用「新建」，已有代码的项目用「接管」。');
    }
    return state;
  }
  if (mode === 'takeover') {
    if (state === 'longrun') throw new LaunchError(`${root} 已经跑过长程，请用「续跑」接着做。`);
    if (state !== 'project') throw new LaunchError(`${root} 还没有内容，不需要接管，用「新建」即可。`);
    return state;
  }
  if (state === 'missing' || state === 'empty') return state;
  if (state === 'project') {
    throw new LaunchError(`${root} 是已有项目（没跑过长程）。\n`
      + '  要在它上面做长程开发，请选「接管已有项目」；想新开一个项目，换个名字。');
  }
  if (!fresh) {
    throw new LaunchError(`${root} 已有长程运行记录。\n`
      + '  想在它基础上继续开发，改用「续跑」。\n'
      + '  想重新开始，勾选「删掉重建」，或换一个名字。');
  }
  // 只删跑过长程的目录；删之前再过一道隔离校验：删目录是不可逆操作，宁可多挡一次
  assertSandboxed(root, '待删除的项目');
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch (e) {
    throw new LaunchError(`删除已有项目失败：\n  ${root}\n  ${e.message}\n`
      + '  可能有进程还在用这个目录（例如上一轮执行者起的 dev server）。只结束指名的进程，\n'
      + '  不要按进程名批量杀 node —— 那会连带杀掉 WebTmux 和你其它会话。\n'
      + '  也可以换一个名字绕开。');
  }
  return 'missing';
}

/**
 * 上一次运行留下的痕迹（resume.py show_prior_state），让人确认续的是对的项目。
 * @returns {{legs, handoffs, spentUsd, memoryCount, memoryIndex: string[], moreIndex: number}|null}
 */
/**
 * 上一轮是不是被**中断**的（而不是正常收工）。
 *
 * 判据：`.run/session_state.json` 有进度，却没有 `.run/report.json` ——
 * 收工一定写报告（LongRunLoop 的 finish 路径），所以"有进度、无报告"只能是中途没了。
 *
 * 为什么需要它：JobGuard 是有意设计的 —— WebTmux 一死，执行者整组跟着死，
 * 防止它无人监管地继续改代码（原版实测过编排器被杀后执行者又跑了 30 分钟）。
 * 代价是重启服务、关机、崩溃都会终止长程，而任务只在内存里，
 * **重启后面板上那条任务凭空消失，人不知道发生了什么**。记忆与 git 快照都还在盘上，
 * 点"续跑"就能接上，但前提是有人告诉他这件事。
 *
 * @param {string} root 项目目录
 * @returns {{interrupted:boolean, legs:number, spentUsd:number, at:number}|null}
 */
export function interruptedRun(root) {
  try {
    const dir = path.join(root, '.run');
    const st = JSON.parse(readFileSync(path.join(dir, 'session_state.json'), 'utf8'));
    if (!(Number(st.legs) > 0)) return null;             // 一发都没跑过，没什么可续的
    if (existsSync(path.join(dir, 'report.json'))) return null;   // 有收工报告 = 正常结束
    return {
      interrupted: true,
      legs: Number(st.legs) || 0,
      spentUsd: Number(st.spent_usd || 0),
      at: Number(st.updated_at || 0),
    };
  } catch {
    return null;    // 没有状态文件或读坏了：当成没跑过，不猜
  }
}

export function priorState(root) {
  const out = { legs: null, handoffs: null, spentUsd: null, memoryCount: memoryFiles(root).length,
    memoryIndex: [], moreIndex: 0 };
  try {
    const st = JSON.parse(readFileSync(path.join(root, '.run', 'session_state.json'), 'utf8'));
    out.legs = st.legs ?? null;
    out.handoffs = st.handoffs ?? null;
    out.spentUsd = Number(st.spent_usd || 0);
  } catch { /* 没有或坏了就不报，与原版一致 */ }
  try {
    const lines = readFileSync(path.join(root, '.memory', 'MEMORY.md'), 'utf8')
      .split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('-'));
    out.memoryIndex = lines.slice(0, 8).map((l) => l.slice(0, 96));
    out.moreIndex = Math.max(0, lines.length - 8);
  } catch { /* 无索引 */ }
  return out;
}

/**
 * cli_common.load_req 的判定部分：参考路径无法使用时默认停止 ——
 * 参考资料缺失会让执行者按不完整的信息开工。allowMissingRefs 才放行。
 */
export function checkRejectedRefs(req, { allowMissingRefs = false } = {}) {
  if (!req.rejected?.length || allowMissingRefs) return;
  const list = req.rejected.map(([ref, why]) => `  ✗ ${ref}\n      ${why}`).join('\n');
  throw new LaunchError(`以下 ${req.rejected.length} 条参考路径无法使用：\n${list}\n\n`
    + '参考资料缺失会让执行者按不完整的信息开工，已停止。\n'
    + '  修正需求文档里的路径，或勾选「忽略无法使用的参考路径」明确放行。');
}

/**
 * 交给执行者（同时交给监督者）的需求正文。两边必须是同一份文本，
 * 否则监督者会按一份"委托人没见过的需求"去代他作决定。
 *   新建（start.py）：需求全文 [+ \n\n---\n\n + 参考资料]
 *   续跑（resume.py）：追加口吻的包装 + 需求 [+ 参考资料]。这段包装是编排器唯一自己写的文字，
 *     让执行者知道这不是重做而是增量 —— 不加它可能从头开始。
 */
export function requirementInput(req, { resume = false } = {}) {
  const refs = renderRefsSection(req);
  if (!resume) return refs ? `${req.text}\n\n---\n\n${refs}` : req.text;
  const parts = [
    '以下是新增的需求。这不是重新开始，是在你已有的进度上继续。',
    '先按上面的要求确认当前进度，再把这部分做完。',
    '',
    '---',
    '',
    req.text,
  ];
  if (refs) parts.push('', '---', '', refs);
  return parts.join('\n');
}

/**
 * 需求预检：用与真沙箱**同一套**挂载校验（受保护根、路径存在），但不建目录、不写配置。
 * 原版在建完沙箱之后才校验参考路径；带「删掉重建」时那意味着旧成果已经删了才发现需求有问题。
 * 这里先干跑一遍，失败就在动任何东西之前停下。
 */
export function previewRequirement(docPath) {
  const dry = { extraDirs: [], addExtraDir: LongRunSandbox.prototype.addExtraDir };
  return loadRequirement(docPath, dry);
}

export { refDisplay, extraDirsOf };

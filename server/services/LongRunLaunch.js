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

/** 沙箱根目录。复用隔离层那份，不另写 —— 两处各写一份迟早走偏。 */
export const sandboxBase = () => sandboxRoots()[0];

/**
 * 从文档名派生沙箱名（start.py derive_name）：非法字符换下划线，去首尾下划线，截 40 字。
 * Python 的 \w 带 re.U 认 Unicode 字母数字，JS 要显式写 \p{L}\p{N}。
 */
export function deriveSandboxName(docPath) {
  const stem = path.basename(String(docPath || '')).replace(/\.[^.]*$/, '');
  const name = stem.replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '');
  return name.slice(0, 40) || 'project';
}

/** 沙箱名校验：不能含路径分隔符，也不能是 . / ..（会逃出沙箱根）。 */
export function assertSandboxName(name) {
  const n = String(name || '');
  if (!n || /[\\/]/.test(n) || n === '.' || n === '..') {
    throw new LaunchError(`沙箱名不合法: ${JSON.stringify(n)}（不能为空、不能含路径分隔符）`);
  }
  return n;
}

const nonEmptyDir = (p) => {
  try { return statSync(p).isDirectory() && readdirSync(p).length > 0; } catch { return false; }
};

/** 已有沙箱清单（resume.py list_sandboxes）。 */
export function listSandboxes() {
  const base = sandboxBase();
  try {
    return readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch { return []; }
}

/** 记忆文件（.memory/*.md）。续跑的前提是有东西可续。 */
export function memoryFiles(root) {
  const dir = path.join(root, '.memory');
  try { return readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch { return []; }
}

/**
 * start.py prepare_sandbox 的检查部分：同名沙箱已存在且非空时，不带 fresh 就拒绝 ——
 * 里面可能是上一次跑出来的成果，不静默覆盖。带 fresh 则删掉重建。
 * 返回沙箱根目录；真正的创建交给 LongRunSandbox.create。
 */
export function prepareFreshSandbox(name, { fresh = false } = {}) {
  assertSandboxName(name);
  const root = path.join(sandboxBase(), name);
  if (!nonEmptyDir(root)) return root;
  if (!fresh) {
    throw new LaunchError(`沙箱 ${root} 已存在且非空。\n`
      + '  想在它基础上继续开发，改用「续跑」并选这个沙箱。\n'
      + '  想重新开始，勾选「删掉重建」，或换一个沙箱名字。');
  }
  // 删之前再过一道隔离校验：名字经过了清洗，但删目录是不可逆操作，宁可多挡一次
  assertSandboxed(root, '待删除的沙箱');
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch (e) {
    throw new LaunchError(`删除已有沙箱失败：\n  ${root}\n  ${e.message}\n`
      + '  可能有进程还在用这个目录（例如上一轮执行者起的 dev server）。只结束指名的进程，\n'
      + '  不要按进程名批量杀 node —— 那会连带杀掉 WebTmux 和你其它会话。\n'
      + '  也可以换一个沙箱名字绕开。');
  }
  return root;
}

/**
 * resume.py open_sandbox 的检查部分：沙箱必须存在，且有记忆文件 ——
 * 没有记忆说明它可能从未成功跑过初始化，用「新建」重新开始更合适。
 */
export function checkResumableSandbox(name) {
  assertSandboxName(name);
  const root = path.join(sandboxBase(), name);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    const all = listSandboxes();
    throw new LaunchError(`沙箱不存在: ${root}\n  新项目请用「新建」。\n`
      + `  已有沙箱: ${all.length ? all.join(', ') : '(无)'}`);
  }
  if (!memoryFiles(root).length) {
    throw new LaunchError(`沙箱 ${name} 里没有记忆文件（${path.join(root, '.memory')}）。\n`
      + '  它可能从未成功跑过初始化。用「新建」重新开始更合适。');
  }
  return root;
}

/**
 * 上一次运行留下的痕迹（resume.py show_prior_state），让人确认续的是对的项目。
 * @returns {{legs, handoffs, spentUsd, memoryCount, memoryIndex: string[], moreIndex: number}|null}
 */
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

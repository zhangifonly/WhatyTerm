/**
 * 长程编排：提示词加载 + 需求文档解析
 *
 * 移植自长程编排器 orchestrator/prompts.py 与 requirement.py。
 *
 * ⚠ **编排器不拼装提示词**。发给执行者的每一段都是 提示词.txt 里的原文，一字不改 ——
 * 提示词的措辞是用户反复调过的，"顺手补一句"会改变执行者的行为，而那种改变很难察觉。
 * 编排器自己生成的输入只有「继续完成项目」这一句，以及需求文档全文。
 */

import { readFileSync, existsSync, statSync, realpathSync } from 'fs';
import path from 'path';

/** 标题关键词 → 用途。用关键词容错匹配，编号或措辞微调都能命中。 */
export const PROMPT_SLOTS = {
  init: '初始化提示词',
  wrapup: '旧对话收尾提示词',
  resume: '新对话开始提示词',
  maintain_1: '定期维护提示词1',
  maintain_2: '定期维护提示词2',
};

/**
 * 编排器自己发的唯一一句话。刻意极短 —— 执行者已经知道要做什么，多说一句都是干涉。
 * ⚠ 不要"优化"这句话。测试 case_continue_is_exact 锁死它。
 */
export const CONTINUE_PROMPT = '继续完成项目';

/**
 * 续用终端那条对话转入长程时，第一发要先声明规则变了。
 *
 * 为什么必须声明：长程执行者跑在自己的权限配置下（executorSettings：白名单更严、
 * 禁改项目外 CLAUDE.md），而这条对话是在终端的宽松规则下开始的。
 * 不说一声就换规则，执行者会按旧印象去做它现在做不了的事，然后在权限拒绝上反复撞墙 ——
 * 那种失败很难从屏幕上看懂原因。
 */
export const MODE_SWITCH_NOTICE =
  '【运行方式变更】从现在起，这个会话由无人值守的长程编排驱动，不再有人实时盯着：\n'
  + '- 权限白名单比刚才更严，改项目外的文件、装全局依赖这类操作会被拒绝；\n'
  + '- 需要我做业务决策时，说清选项后停下等我，不要自己挑一个继续；\n'
  + '- 每段工作结束前把进度写进项目记忆，上下文快满时我会让你收尾交接。\n'
  + '先不要改变当前任务，按上面的规则继续做下去。';

/** 提示词文件缺失或缺段。启动前的硬失败，不做降级。 */
export class PromptError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PromptError';
  }
}

/** 沙箱隔离被违反。 */
export class IsolationViolation extends Error {
  constructor(message) {
    super(message);
    this.name = 'IsolationViolation';
  }
}

/**
 * 按 `## 标题` 切分，返回 { 标题: 正文 }。
 * 正文为空的段落跳过（占位标题不算一段）。
 */
function splitSections(text) {
  const parts = {};
  // 逐行扫而不用 split(捕获组)：Node 的 split 在标题行首尾空白处理上与 Python 的
  // re.split(flags=re.M) 有微妙差异，逐行更好对齐原实现
  const lines = String(text).split(/\r?\n/);
  let title = null;
  let buf = [];
  const flush = () => {
    if (title !== null) {
      const body = buf.join('\n').trim();
      if (body) parts[title] = body;
    }
  };
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      title = m[1].trim();
      buf = [];
    } else if (title !== null) {
      buf.push(line);
    }
  }
  flush();
  return parts;
}

/** 去掉标题前的编号（"1. " / "1、"），便于关键词匹配。 */
function stripNumbering(title) {
  return String(title).replace(/^\d+[.、]\s*/, '');
}

/**
 * 读取并校验提示词文件。缺任何一段都拒绝启动（不降级、不用默认值）。
 * @param {string} file 提示词文件路径
 * @returns {{init,wrapup,resume,maintain_1,maintain_2,source}}
 */
export function loadPrompts(file) {
  if (!file) throw new PromptError('未指定提示词文件路径');
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new PromptError(`提示词文件不存在: ${path.resolve(file)}`);
  }

  const sections = splitSections(readFileSync(file, 'utf8'));
  const titles = Object.keys(sections);
  if (titles.length === 0) {
    throw new PromptError(
      `${file} 里没找到任何 \`## 标题\` 段落。格式应为每段以 \`## 名称\` 开头。`
    );
  }

  const resolved = {};
  for (const [slot, keyword] of Object.entries(PROMPT_SLOTS)) {
    const hitTitle = titles.find((t) => stripNumbering(t).includes(keyword));
    if (hitTitle === undefined) {
      throw new PromptError(
        `${file} 里缺少「${keyword}」这一段。\n已找到的段落: ${titles.join(', ') || '(无)'}`
      );
    }
    resolved[slot] = sections[hitTitle];
  }
  resolved.source = path.resolve(file);
  return resolved;
}

// ── 需求文档解析 ──────────────────────────────────────────────
//
// 输入是一份自然语言需求文档，里面可能指名其它文件/目录（绝对路径）或 URL。
// 解析出这些引用后**原地供执行者读取，不复制进沙箱**。
//
// ⚠ 实现方式是 `--add-dir`，它给的是**读写**权限而非只读：执行者能改这些目录里的
// 文件。用户已明确选择信任指名的路径，故不做改动检查 —— 但启动时要打印哪些路径可写。
// 唯一硬限制：路径不得落在受保护项目内（那会让执行者拿到本项目记忆库的写权限）。

/** Markdown 链接 [文字](路径) */
const MD_LINK = /\[[^\]]*\]\(\s*<?([^)\s>]+)>?\s*\)/g;
/** @路径 引用（CLI 习惯写法），容许包在反引号里 */
const AT_REF = /(?:^|[\s`"'])@([^\s,，。；;`"']+)/g;
/**
 * Windows 绝对路径：盘符 C:/x、C:\x，以及 UNC \\server\share。
 * ⚠ UNC 分支要求**至少两段**（\\主机\共享名），否则文档里的转义示例 `\\u`、`\\n`
 *    会被误当成路径 —— 实测踩过（对应用例 case_escape_sequences_not_paths）。
 */
// ⚠ \p{L}\p{N} 而非 \w：Python 的 \w 含 Unicode，JS 的不含 —— 中文目录名会漏
const ABS_WIN = /(?:^|[\s(（`"'])([A-Za-z]:[\\/][^\s`"'()（），。；;]*|\\\\[\p{L}\p{N}_.-]+\\[^\s`"'()（），。；;]+)/gmu;
/** POSIX 绝对路径 */
const ABS_POSIX = /(?:^|[\s(（`"'])(\/(?:[\p{L}\p{N}_\-.]+\/)*[\p{L}\p{N}_\-.]+)(?=[\s)）,，。；;:：`"']|$)/gmu;
const URL_RE = /https?:\/\/[^\s)>\]，。；;`"']+/g;

/**
 * 是否绝对路径。
 * 只认绝对路径 —— 用户已明确表示会写完整路径。相对路径不解析：那会把需求里提到的
 * 待创建产出（`src/cache.py`）误当成参考资料。
 */
function isAbsoluteRef(raw) {
  if (/^[A-Za-z]:[\\/]/.test(raw)) return true;
  // UNC 至少要 \\主机\共享名 两段。只有 \\ 开头的多是转义示例（\\u、\\n）
  if (/^\\\\[\p{L}\p{N}_.-]+\\./u.test(raw)) return true;
  // POSIX 绝对路径至少要有一层，且不能只是 "/" 或 "/x"（太可能是普通斜杠）
  return raw.startsWith('/') && raw.length > 2;
}

/** 抽取绝对路径引用，去重且保持出现顺序。 */
function extractCandidates(text) {
  const found = [];
  for (const pattern of [MD_LINK, AT_REF, ABS_WIN, ABS_POSIX]) {
    pattern.lastIndex = 0;   // 复用 /g 正则前必须复位
    let m;
    while ((m = pattern.exec(text)) !== null) {
      let raw = (m[1] || '').trim().replace(/^[`'"]+|[`'"]+$/g, '').replace(/[/\\]+$/, '');
      if (!raw) continue;
      if (/^(https?:\/\/|#|mailto:)/.test(raw)) continue;
      // 含括号的是函数签名，不是路径
      if (raw.includes('(') || raw.includes(')')) continue;
      if (!isAbsoluteRef(raw)) continue;
      found.push(raw);
    }
  }
  return [...new Set(found)];
}

/**
 * 读需求文档，解析出外部参考路径并登记到沙箱。
 * @param {string} docPath 需求文档
 * @param {object|null} spec 沙箱（有 addExtraDir 方法）。为 null 时只解析不登记，
 *                           便于测试与 --plan-only 预检
 * @returns {{text,source,refs,urls,rejected}}
 *   refs: [{path, isDir}]  rejected: [[原文, 原因]]
 */
export function loadRequirement(docPath, spec = null) {
  if (!docPath || !existsSync(docPath) || !statSync(docPath).isFile()) {
    throw new Error(`需求文档不存在: ${path.resolve(docPath || '')}`);
  }
  const doc = realpathSync(path.resolve(docPath));
  const text = readFileSync(doc, 'utf8');

  URL_RE.lastIndex = 0;
  const req = {
    text,
    source: doc,
    refs: [],
    urls: [...new Set(text.match(URL_RE) || [])],
    rejected: [],
  };

  for (const raw of extractCandidates(text)) {
    if (!existsSync(raw)) {
      req.rejected.push([raw, '路径不存在']);
      continue;
    }
    const resolved = realpathSync(path.resolve(raw));
    if (resolved === doc) continue;          // 文档引用自己，跳过
    const isDir = statSync(resolved).isDirectory();

    if (spec) {
      const target = isDir ? resolved : path.dirname(resolved);
      try {
        spec.addExtraDir(target);
      } catch (e) {
        // 只取首行：隔离层的报错是多行的，参考清单里放一行就够
        req.rejected.push([raw, String(e.message || e).split('\n')[0]]);
        continue;
      }
    }
    req.refs.push({ path: resolved, isDir });
  }
  return req;
}

/** 参考路径的显示形式（目录带尾斜杠）。 */
export function refDisplay(ref) {
  return ref.path + (ref.isDir ? '/' : '');
}

/**
 * 需要 --add-dir 挂载的目录。文件则挂其所在目录，去重保序。
 */
export function extraDirsOf(req) {
  const dirs = [];
  for (const ref of req.refs || []) {
    const d = ref.isDir ? ref.path : path.dirname(ref.path);
    if (!dirs.includes(d)) dirs.push(d);
  }
  return dirs;
}

/**
 * 渲染「## 参考资料」段，附加到需求正文之后发给执行者。
 * 措辞对齐 Python 版（用例 case_refs_section_wording 锁死）。
 */
export function renderRefsSection(req) {
  const refs = req.refs || [], urls = req.urls || [], rejected = req.rejected || [];
  if (!refs.length && !urls.length) return '';
  const lines = ['## 参考资料', ''];
  if (refs.length) {
    lines.push('以下路径已挂载到你的可访问范围，**直接用绝对路径读取**，不要把它们复制到工作目录里：');
    for (const r of refs) lines.push(`- \`${refDisplay(r)}\``);
    lines.push('');
  }
  if (urls.length) {
    lines.push('以下链接需要时可自行抓取：');
    for (const u of urls) lines.push(`- ${u}`);
    lines.push('');
  }
  if (rejected.length) {
    lines.push('以下引用无法使用（不要试图去找它们）：');
    for (const [ref, why] of rejected) lines.push(`- ${ref}：${why}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * 普通会话 → 长程 的交接：回执解析（纯函数，零 IO）
 *
 * 交接指令要求 CLI 回三样：更新了哪些记忆文件、每个文件改了什么、下一会话从哪一项开始。
 * 这里把后一项抽出来预填进长程的「新增需求」—— 它是这段会话自己给出的最具体的下一步，
 * 比人凭印象重写一遍准。
 *
 * ⚠ 抽不到就给空：界面会原样展示全文让人自己看。宁可让人多读两行，也不能把别的句子当成"下一步"
 *   塞进需求里 —— 那会直接变成长程执行者的任务。
 */

/** 等它写完记忆的上限：写记忆通常一两分钟，给到 5 分钟；超时一律不退 CLI，上下文还在里面 */
export const HANDOFF_WAIT_MS = 5 * 60 * 1000;

/** 下一步的最大长度：长程的需求框是给人过目的，太长反而没人看 */
export const NEXT_STEP_MAX = 500;

const MD_FILE_RE = /[\w./-]+\.md\b/g;
/** 「下一会话 / 下一步 / 接下来」起头的那一段 */
const NEXT_RE = /(?:下一会话(?:应该)?(?:从哪一项开始|从)?|下一步(?:最具体的行动)?|接下来应该?)\s*[：:，,]?\s*/;

/** 行首的清单符号与序号：抽出来当需求时要去掉，不然长程的需求里混着 markdown 记号 */
const BULLET_RE = /^\s*(?:[-*•]|\d+[.)、]|#{1,6})\s*/;

export function parseHandoffReceipt(reply) {
  const text = String(reply || '').trim();
  if (!text) return { files: [], nextStep: '', raw: '' };

  // 记忆文件：回执里出现的 *.md，去重保序。MEMORY.md 也算（索引本身通常也更新了）
  const files = [];
  for (const m of text.match(MD_FILE_RE) || []) {
    const name = m.replace(/^[./]+/, '');
    if (name && !files.includes(name)) files.push(name);
  }

  let nextStep = '';
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const hit = NEXT_RE.exec(lines[i]);
    if (!hit) continue;
    // 同一行冒号后面就有内容 → 用它；否则往下取到空行为止（回执常把下一步写成下面几行清单）
    const tail = lines[i].slice(hit.index + hit[0].length).trim();
    const block = tail ? [tail] : [];
    if (!tail) {
      for (let j = i + 1; j < lines.length && lines[j].trim(); j += 1) block.push(lines[j].trim());
    }
    nextStep = block.map((l) => l.replace(BULLET_RE, '')).filter(Boolean).join('\n').trim();
    if (nextStep) break;
  }
  return { files, nextStep: nextStep.slice(0, NEXT_STEP_MAX), raw: text };
}

/** 交接各阶段的进度文案（服务端推给界面，界面不自己编） */
export const HANDOFF_PHASE = {
  waiting_idle: '等这个会话闲下来…',
  sent: '已把收尾指令发给它',
  writing: '它正在把进度写进记忆…',
  quitting: '记忆写完了，正在退出 CLI…',
  done: '交接完成',
};

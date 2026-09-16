/**
 * 长程编排：监督者
 *
 * 移植自长程编排器 orchestrator/supervisor.py。
 *
 * 监督者读执行者最后一轮输出，判四选一。它**是委托人（人类）的代理人** ——
 * 人把需求写成文档交给它然后走开，期待回来时看到做好的项目，
 * 而不是一个停在半路等他回答小问题的项目。
 */

import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/** 监督者提示词读不到或缺少输出契约。启动前硬失败，不降级。 */
export class SupervisorPromptError extends Error {
  constructor(message) { super(message); this.name = 'SupervisorPromptError'; }
}

export const Verdict = {
  /**
   * 还没做完：无论是意外中断、阶段性汇报，还是明确说了下一步要做什么。
   * 处置一律相同 —— 发「继续完成项目」。
   */
  CONTINUE: 'continue',
  /** 整体项目已完成。提醒人类，执行者休息。 */
  PROJECT_DONE: 'project_done',
  /**
   * 执行者问了个实质问题，监督者依需求文档代人类作答。
   * 处置：把 reply 原样发给执行者续跑，不打扰人类。
   */
  DECIDE: 'decide',
  /** 必须叫人。 */
  NEEDS_HUMAN: 'needs_human',
};

/**
 * 低于此置信度不允许判「项目完成」。
 * 误判成完成会让整个项目提前停摆，误判成未完成只是多跑一轮 —— 代价不对称。
 */
export const DONE_CONFIDENCE_FLOOR = 0.8;

/**
 * 低于此置信度不允许代答，降级为 needs_human。
 * 这是「监督者自己没把握就停机」那条底线的执行点：一个没把握的代答会被原样
 * 当成人类意图封存进记忆库。定得比 DONE_FLOOR 低是因为代答错了通常还能被
 * 后续工作纠正，判「完成」错了整个项目当场停摆。
 */
export const DECIDE_CONFIDENCE_FLOOR = 0.7;

/**
 * 换提示词时**必须保留**的东西：送的是纯文本，解析靠认这几个键。
 * 少了 verdict 这一层，每次判定都会走 fallback 变成 needs_human ——
 * 那等于把整个自动化关掉，而且看不出原因。
 */
export const REQUIRED_MARKERS = ['verdict', 'continue', 'project_done', 'decide', 'needs_human'];

/**
 * 需求文档送多少。取 20000 字符：足够覆盖实测的需求文档，又不至于让每次判定的
 * 输入费用失控 —— 监督者每发都要调一次。
 * 超长时保留**开头**：需求文档的取向、约束、验收标准通常写在前面，末尾多是附录。
 */
export const REQUIREMENT_BUDGET = 20000;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROMPT_FILE = path.join(HERE, '..', 'prompts', 'longrun', '监督者提示词.txt');

/**
 * 读监督者提示词并校验输出契约。
 * @returns {{text:string, source:string}}
 */
export function loadSystemPrompt(file = DEFAULT_PROMPT_FILE) {
  if (!existsSync(file)) {
    throw new SupervisorPromptError(`监督者提示词文件不存在: ${path.resolve(file)}`);
  }
  const text = readFileSync(file, 'utf8');
  const missing = REQUIRED_MARKERS.filter((m) => !text.includes(m));
  if (missing.length) {
    throw new SupervisorPromptError(
      `监督者提示词缺少输出契约关键词: ${missing.join(', ')}\n`
      + `少了它们每次判定都会降级成 needs_human，等于把自动化关掉。`
    );
  }
  return { text, source: path.resolve(file) };
}

/**
 * 从模型回复里抠出 JSON。
 *
 * 模型常在 JSON 前后加解释文字或包在 ```json 围栏里，直接 JSON.parse 会失败。
 * 抢救顺序：整体 → 去围栏 → 找第一个平衡的 {…}。
 * 抢救不到就抛，由调用方降级为 needs_human（宁可停机，不猜判定）。
 */
export function extractJson(text) {
  const raw = String(text ?? '').trim();
  if (!raw) throw new Error('回复为空');

  const tryParse = (s) => {
    try {
      const v = JSON.parse(s);
      return (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
    } catch { return null; }
  };

  let hit = tryParse(raw);
  if (hit) return hit;

  // 去 markdown 围栏
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fence) {
    hit = tryParse(fence[1].trim());
    if (hit) return hit;
  }

  // 找第一个花括号平衡的片段（字符串内的花括号不计）
  const start = raw.indexOf('{');
  if (start >= 0) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        hit = tryParse(raw.slice(start, i + 1));
        if (hit) return hit;
        break;
      }
    }
  }
  throw new Error(`回复里找不到可解析的 JSON（前 120 字: ${raw.slice(0, 120)}）`);
}

/** 一次判定的结果。 */
export class Judgement {
  constructor(o = {}) {
    this.verdict = o.verdict || Verdict.NEEDS_HUMAN;
    this.confidence = o.confidence ?? 0;
    this.reason = o.reason || '';
    this.reply = o.reply || '';
    this.needsFromHuman = o.needsFromHuman || '';
    this.raw = o.raw || '';
    this.inputTokens = o.inputTokens || 0;
    this.outputTokens = o.outputTokens || 0;
  }

  get shouldContinue() { return this.verdict === Verdict.CONTINUE; }
  get needsHuman() { return this.verdict === Verdict.NEEDS_HUMAN; }
  get projectDone() { return this.verdict === Verdict.PROJECT_DONE; }
  get decided() { return this.verdict === Verdict.DECIDE; }

  render() {
    const parts = [`判定 ${this.verdict}（置信 ${this.confidence.toFixed(2)}）`];
    if (this.reason) parts.push(`理由: ${this.reason}`);
    if (this.reply) parts.push(`代答: ${this.reply.slice(0, 200)}`);
    if (this.needsFromHuman) parts.push(`需人类: ${this.needsFromHuman}`);
    return parts.join('\n');
  }
}

export class Supervisor {
  /**
   * @param {object} o
   * @param {function} o.complete  (systemPrompt, userText) => Promise<{text,inputTokens,outputTokens,stopReason}>
   *                               走 AIEngine._callClaudeApi + CC Switch 凭据；
   *                               传 null 表示未配监督者（judge 会直接叫人）
   * @param {string}  o.systemPrompt  监督者提示词（缺省读 server/prompts/longrun/）
   * @param {number}  o.maxTokens     供 max_tokens 截断时提示用
   */
  constructor(o = {}) {
    this.complete = o.complete || null;
    this.systemPrompt = o.systemPrompt || (o.complete ? loadSystemPrompt().text : '');
    this.maxTokens = o.maxTokens || 0;
    this.calls = 0;
    this.spentTokens = 0;
  }

  /** 降级为叫人。任何拿不准的情形都走这里 —— 宁可停机，不猜判定。 */
  static fallback(reason, needs) {
    return new Judgement({
      verdict: Verdict.NEEDS_HUMAN, confidence: 1.0,
      reason, needsFromHuman: needs,
    });
  }

  /**
   * 读执行者最后一轮输出，判四选一。
   *
   * 输入是"现场" + 需求文档全文。加需求文档是代答能力的前提：要站在委托人立场
   * 上作决定，就得知道他要什么。**仍然不注入记忆全文** —— 那是执行者的工作记录，
   * 不是委托人的意图来源。
   */
  async judge(runResult, { phase = '', requirement = '' } = {}) {
    if (!this.complete) {
      // 未配监督者时必须明确说出来。早先这里直接返回，于是终端上什么提示都不出现
      return Supervisor.fallback('未配置监督者', '未配置监督者，需人工判断执行者输出');
    }

    const user = this.buildInput(runResult, phase, requirement);
    let reply;
    try {
      reply = await this.complete(this.systemPrompt, user);
    } catch (e) {
      return Supervisor.fallback(
        `监督者不可用: ${e.message}`, '监督者 LLM 调用失败，需人工接手判断');
    }

    this.calls += 1;
    this.spentTokens += (reply.inputTokens || 0) + (reply.outputTokens || 0);

    let data;
    try {
      data = extractJson(reply.text);
    } catch (e) {
      if (reply.stopReason === 'max_tokens') {
        return Supervisor.fallback(
          `监督者回复被 max_tokens 截断（当前上限 ${this.maxTokens}）`,
          '调高监督者 max_tokens 后重试');
      }
      return Supervisor.fallback(
        `监督者回复无法解析: ${e.message}`, '人工查看执行者输出后决定');
    }

    const verdictRaw = String(data.verdict ?? '').trim();
    if (!Object.values(Verdict).includes(verdictRaw)) {
      return Supervisor.fallback(
        `监督者给出未知判定「${data.verdict}」`, '人工查看执行者输出后决定');
    }

    let confidence = Number(data.confidence);
    if (!Number.isFinite(confidence)) confidence = 0;
    confidence = Math.max(0, Math.min(1, confidence));

    const j = new Judgement({
      verdict: verdictRaw,
      confidence,
      reason: String(data.reason ?? '').trim(),
      reply: String(data.reply ?? '').trim(),
      needsFromHuman: String(data.needs_from_human ?? '').trim(),
      raw: reply.text,
      inputTokens: reply.inputTokens || 0,
      outputTokens: reply.outputTokens || 0,
    });

    // ── 闸一：判「项目完成」要求更高置信度 ──
    // 代价不对称：误判成完成会让整个项目提前停摆，误判成未完成只是多跑一轮。
    if (j.projectDone && confidence < DONE_CONFIDENCE_FLOOR) {
      return new Judgement({
        verdict: Verdict.CONTINUE, confidence,
        reason: `监督者判「项目完成」但置信度 ${confidence.toFixed(2)} 低于下限 `
          + `${DONE_CONFIDENCE_FLOOR}，降级为继续。原依据: ${j.reason}`,
        raw: j.raw, inputTokens: j.inputTokens, outputTokens: j.outputTokens,
      });
    }

    // ── 闸二：代答的两道门，命中任一就降级为叫人 ──
    // 代答会被原样当成人类意图执行并写进记忆库，所以宁可停机。
    if (j.verdict === Verdict.DECIDE) {
      if (!j.reply) {
        // 判了 decide 却没给答复，等于没答上来。不能当成 continue 放过去 ——
        // 它确实问了个实质问题，只是答案没拿到。
        return Supervisor.fallback(
          `监督者判代答但未给出答复内容。原依据: ${j.reason}`, '人工回答执行者的问题');
      }
      if (confidence < DECIDE_CONFIDENCE_FLOOR) {
        return new Judgement({
          verdict: Verdict.NEEDS_HUMAN, confidence,
          reason: `监督者代答置信度 ${confidence.toFixed(2)} 低于下限 `
            + `${DECIDE_CONFIDENCE_FLOOR}，改为叫人。原依据: ${j.reason}`,
          needsFromHuman: `监督者本想代你回答（拟答: ${j.reply.slice(0, 200)}），`
            + `但没有把握，请你定`,
          raw: j.raw, inputTokens: j.inputTokens, outputTokens: j.outputTokens,
        });
      }
    }
    return j;
  }

  /** 组装送给监督者的"现场"。 */
  buildInput(r, phase, requirement) {
    const lines = [];
    if (requirement) {
      // 超长时保留开头（取向、约束、验收标准通常写在前面）
      const doc = requirement.length > REQUIREMENT_BUDGET
        ? requirement.slice(0, REQUIREMENT_BUDGET) + '\n…（需求文档过长，已截断）'
        : requirement;
      lines.push('## 委托人的需求文档', '', doc, '');
    }
    lines.push('## 执行者最后一轮的现场', '');
    if (phase) lines.push(`本轮发的是：${phase}`);
    lines.push(`退出原因：${r.exitReason}`);
    if (r.numTurns) lines.push(`轮数：${r.numTurns}`);
    if (r.contextPeak) lines.push(`上下文水位峰值：${r.contextPeak.toLocaleString()}`);
    if (r.error) lines.push(`异常说明：${r.error}`);
    if (r.pendingTasks?.length) {
      lines.push(`仍在飞的后台任务：${r.pendingTasks.length} 个`);
    }
    if (r.permissionDenials?.length) {
      // 配 --permission-prompts none 时这里非空说明它想做被禁的事
      lines.push(`被拒的操作：${r.permissionDenials.length} 次`);
    }
    lines.push('', '### 执行者说的话', '', String(r.finalText || '(无输出)'));
    return lines.join('\n');
  }
}

/**
 * 长程编排：监督者 —— 委托人（人类）的代理人
 *
 * 逐函数移植自长程编排器 orchestrator/supervisor.py 与 llm_client.py 的 JSON 抽取部分。
 * 读执行者最后一轮输出，判四选一：continue / project_done / decide / needs_human。
 *
 * 与原版的差异（均有意为之）：
 *   · LLM 调用经注入的 complete(system, user)，服务层接到 AIEngine.callClaudeMessages，
 *     凭据从 CC Switch 取（原版读 .env 的 SUPERVISOR_*）—— 项目规矩禁止硬编码 Key
 *   · 默认提示词是随仓库分发的 server/prompts/longrun/监督者提示词.txt（原版文件缺失时回落内置常量；
 *     这里文件就是那份常量的导出，缺失说明安装不完整，直接硬失败）
 */

import { readFileSync, existsSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/** 监督者提示词读不到或缺少输出契约。启动前硬失败，不降级。 */
export class SupervisorPromptError extends Error {
  constructor(message) { super(message); this.name = 'SupervisorPromptError'; }
}

export const Verdict = {
  CONTINUE: 'continue',           // 还没做完。处置一律发「继续完成项目」
  PROJECT_DONE: 'project_done',   // 整体项目已完成
  DECIDE: 'decide',               // 实质问题，依需求文档代人类作答，reply 原样发给执行者
  NEEDS_HUMAN: 'needs_human',     // 必须叫人
};

/** 低于此置信度不许判「项目完成」：误判完成整个项目停摆，误判未完成只是多跑一轮 */
export const DONE_CONFIDENCE_FLOOR = 0.8;
/**
 * 低于此置信度不许代答，降级叫人：没把握的代答会被原样当成人类意图封存进记忆库。
 * 比 DONE 低：代答错了还能被后续工作纠正，判完成错了当场停摆。
 */
export const DECIDE_CONFIDENCE_FLOOR = 0.7;
/**
 * 换提示词时**必须保留**的输出契约。少了 verdict 这一层每次判定都降级成 needs_human ——
 * 等于把自动化关掉，而且看不出原因。
 */
export const REQUIRED_MARKERS = ['verdict', 'continue', 'project_done', 'decide', 'needs_human'];
/**
 * 需求文档送多少。20000 字符足够覆盖实测文档，又不让每次判定的输入费用失控。
 * 超长保留**开头**：取向、约束、验收标准通常写在前面。
 */
export const REQUIREMENT_BUDGET = 20000;

export const DEFAULT_PROMPT_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts', 'longrun', '监督者提示词.txt');

/**
 * 读监督者提示词。返回 { text, source }。
 * **显式给了路径就必须能读到**，读不到硬失败、不静默回落 —— 人以为换了提示词而实际跑的是
 * 默认那份，是最难察觉的一类错。只校验输出契约，不校验判定规则（那是用户的判断权）。
 */
export function loadSystemPrompt(file = null) {
  const target = file ? path.resolve(file) : DEFAULT_PROMPT_FILE;
  if (!existsSync(target) || !statSync(target).isFile()) {
    throw new SupervisorPromptError(file
      ? `监督者提示词文件不存在: ${target}`
      : `随仓库分发的默认监督者提示词缺失（安装不完整）: ${target}`);
  }
  const text = readFileSync(target, 'utf8').trim();
  if (!text) throw new SupervisorPromptError(`监督者提示词文件是空的: ${target}`);
  const missing = REQUIRED_MARKERS.filter((m) => !text.includes(m));
  if (missing.length) {
    throw new SupervisorPromptError(
      `${target} 里没有提到 ${missing.join(', ')}。\n`
      + '  监督者必须按 JSON 输出，且 verdict 取值只能是那四个之一 —— 这是机器接口，不是风格问题。\n'
      + '  少了它每次判定都会解析失败降级成叫人，等于关掉自动化。\n'
      + `  参照默认那份的「输出格式」一节: ${DEFAULT_PROMPT_FILE}`);
  }
  return { text, source: file ? target : '内置默认' };
}

// ── JSON 抽取（原版 llm_client.extract_json）────────────────────

const FENCE = /```(?:json)?\s*([\s\S]*?)\s*```/;
// 兜底提取：枚举值与数字用严格模式，自由文本取到下一个字段名为止
const ENUM_FIELD = /"(verdict|stop|status)"\s*:\s*"([A-Za-z_]+)"/g;
const NUM_FIELD = /"(confidence|score)"\s*:\s*([0-9.]+)/g;
const TEXT_FIELD = /"(reason|needs_from_human|reply|summary)"\s*:\s*"([\s\S]*?)"\s*(?=,\s*"\w+"\s*:|\}\s*$|\}\s*```)/g;

/** 从坏 JSON 里按字段名捞出内容。捞不到判定字段则返回 null。 */
function salvageFields(text) {
  const out = {};
  for (const m of text.matchAll(ENUM_FIELD)) out[m[1]] = m[2];
  for (const m of text.matchAll(NUM_FIELD)) {
    const n = Number(m[2]);           // '1.2.3' 这类非法数字跳过（原版 float() 抛 ValueError）
    if (Number.isFinite(n)) out[m[1]] = n;
  }
  // 值里可能含未转义的引号，原样保留 —— 它只是给人看的说明文字
  for (const m of text.matchAll(TEXT_FIELD)) out[m[1]] = m[2].trim();
  // 没捞到判定字段就不算成功：宁可报解析失败走降级，也不返回缺了关键信息的字典
  return ['verdict', 'stop', 'status'].some((k) => k in out) ? out : null;
}

/**
 * 从模型回复里取出 JSON 对象。候选顺序与原版一致：围栏内 → 整体 → 第一个 { 到最后一个 }。
 * 严格解析全部失败，再做字段级兜底。
 *
 * 实测：模型在 reason 里引用执行者原话用了 ASCII 双引号（…明确说"完成"，测试全通过…），
 * JSON 结构当场被破坏。判断本身是对的（project_done 0.92），不该因为一对引号被整个丢掉。
 * 解析不出来时抛异常，由调用方降级 —— 绝不返回空对象冒充成功解析。
 */
export function extractJson(text) {
  const raw = String(text ?? '');
  const candidates = [];
  const fenced = FENCE.exec(raw);
  if (fenced) candidates.push(fenced[1]);
  candidates.push(raw.trim());
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) candidates.push(raw.slice(start, end + 1));

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* 下一个候选 */ }
  }
  const salvaged = salvageFields(raw);
  if (salvaged) return salvaged;
  throw new Error(`无法从回复中解析 JSON:\n${raw.slice(0, 500)}`);
}

// ── 判定 ───────────────────────────────────────────────────────

export class Judgement {
  constructor(o = {}) {
    this.verdict = o.verdict;
    this.confidence = o.confidence ?? 0;
    this.reason = o.reason || '';
    /** 代委托人给执行者的答复。只在 decide 时非空，**原样**发给执行者（用户明确要求不标注来源） */
    this.reply = o.reply || '';
    this.needsFromHuman = o.needsFromHuman || '';
    this.raw = o.raw || '';
    this.inputTokens = o.inputTokens || 0;
    this.outputTokens = o.outputTokens || 0;
  }

  get shouldContinue() { return this.verdict === Verdict.CONTINUE; }
  get needsHuman() { return this.verdict === Verdict.NEEDS_HUMAN; }
  get projectDone() { return this.verdict === Verdict.PROJECT_DONE; }
  /** 代答成立。空 reply 的 decide 不算 —— 那是没答上来。 */
  get decided() { return this.verdict === Verdict.DECIDE && !!this.reply; }

  render() {
    const lines = [`判定: ${this.verdict}（置信度 ${this.confidence.toFixed(2)}）`, `依据: ${this.reason}`];
    if (this.reply) lines.push(`代委托人答复: ${this.reply}`);
    if (this.needsFromHuman) lines.push(`需人类提供: ${this.needsFromHuman}`);
    return lines.join('\n');
  }
}

export class Supervisor {
  /**
   * @param {object} o
   * @param {function} o.complete  async (system, user) => {text, stopReason, inputTokens, outputTokens}
   * @param {string} o.requirementText  代答的唯一合法依据。没有它监督者只能判 continue/叫人
   * @param {string} o.systemPrompt     判定提示词（缺省读默认文件）
   * @param {string} o.promptSource     提示词来源说明（启动自检打印）
   * @param {number} o.maxTokens        仅用于截断时的提示文案
   */
  constructor(o = {}) {
    this.complete = o.complete;
    if (o.systemPrompt) {
      this.systemPrompt = o.systemPrompt;
      this.promptSource = o.promptSource || '自定义';
    } else {
      const p = loadSystemPrompt();
      this.systemPrompt = p.text;
      this.promptSource = p.source;
    }
    this.requirementText = o.requirementText || '';
    this.maxTokens = o.maxTokens || 4000;
    this.spentTokens = 0;
    this.calls = 0;
  }

  /** 异常路径一律叫人：拿不到判断 ≠ 判断为「继续」。 */
  static fallback(reason, needs) {
    return new Judgement({ verdict: Verdict.NEEDS_HUMAN, confidence: 0.0, reason, needsFromHuman: needs });
  }

  /**
   * 读执行者最后一轮输出，判四选一。输入是"现场" + 需求文档全文；
   * **不注入记忆全文** —— 那是执行者的工作记录，不是委托人的意图来源。
   */
  async judge(runResult, phase = '') {
    const user = this.buildInput(runResult, phase);
    let reply;
    try {
      reply = await this.complete(this.systemPrompt, user);
    } catch (e) {
      return Supervisor.fallback(`监督者不可用: ${e.message}`, '监督者 LLM 调用失败，需人工接手判断');
    }
    this.calls += 1;
    this.spentTokens += (reply.inputTokens || 0) + (reply.outputTokens || 0);

    let data;
    try {
      data = extractJson(reply.text);
    } catch (e) {
      if (reply.stopReason === 'max_tokens') {
        return Supervisor.fallback(`监督者回复被 max_tokens 截断（当前上限 ${this.maxTokens}）`,
          '调高监督者 max_tokens 后重试');
      }
      return Supervisor.fallback(`监督者回复无法解析: ${e.message}`, '人工查看执行者输出后决定');
    }

    const verdict = String(data.verdict ?? '').trim();
    if (!Object.values(Verdict).includes(verdict)) {
      return Supervisor.fallback(`监督者给出未知判定「${data.verdict ?? 'None'}」`, '人工查看执行者输出后决定');
    }
    let confidence = Number(data.confidence ?? 0);
    if (!Number.isFinite(confidence)) confidence = 0;
    confidence = Math.max(0, Math.min(1, confidence));

    const j = new Judgement({
      verdict, confidence,
      reason: String(data.reason ?? '').trim(),
      reply: String(data.reply || '').trim(),
      needsFromHuman: String(data.needs_from_human || '').trim(),
      raw: reply.text, inputTokens: reply.inputTokens, outputTokens: reply.outputTokens,
    });
    const keep = { raw: j.raw, inputTokens: j.inputTokens, outputTokens: j.outputTokens };

    // 「项目完成」判错的代价不对称，要求更高置信度，不够就降级为继续
    if (j.projectDone && confidence < DONE_CONFIDENCE_FLOOR) {
      return new Judgement({
        verdict: Verdict.CONTINUE, confidence,
        reason: `监督者判「项目完成」但置信度 ${confidence.toFixed(2)} 低于下限 ${DONE_CONFIDENCE_FLOOR}，`
          + `降级为继续。原依据: ${j.reason}`, ...keep,
      });
    }
    // 代答的两道闸，命中任一就降级为叫人
    if (j.verdict === Verdict.DECIDE) {
      if (!j.reply) {
        // 判了 decide 却没给答复 = 没答上来。不能当 continue 放过：它确实问了实质问题
        return Supervisor.fallback(`监督者判代答但未给出答复内容。原依据: ${j.reason}`, '人工回答执行者的问题');
      }
      if (confidence < DECIDE_CONFIDENCE_FLOOR) {
        return new Judgement({
          verdict: Verdict.NEEDS_HUMAN, confidence,
          reason: `监督者代答置信度 ${confidence.toFixed(2)} 低于下限 ${DECIDE_CONFIDENCE_FLOOR}，改为叫人。原依据: ${j.reason}`,
          needsFromHuman: `监督者本想代你回答（拟答: ${j.reply.slice(0, 200)}），但没有把握，请你定`, ...keep,
        });
      }
    }
    return j;
  }

  /** 组装送给监督者的"现场"（原版 _build_input，文字逐句一致）。 */
  buildInput(r, phase) {
    const parts = [];
    if (this.requirementText) {
      const text = this.requirementText.trim();
      const clipped = text.slice(0, REQUIREMENT_BUDGET);
      parts.push(
        // 标题里写清用途边界：这份文档**只**给代答用。早先没写"不许用来核对完成度"，
        // 监督者拿它逐项比对最后一轮输出，把已完成的项目判成 continue（tafang 实测，白烧钱）
        '## 委托人的需求文档（仅供代答时推断他的意图，**不要用它核对项目是否做完**）',
        '```',
        clipped + (text.length > clipped.length ? '\n…（后续截断）' : ''),
        '```',
        '');
    } else {
      // 说出来而不是静默：没有需求文档时代答就没有依据
      parts.push('## 委托人的需求文档',
        '（本次未提供需求文档。你没有代他作决定的依据，遇到实质问题请判 needs_human，不要凭空推断。）', '');
    }
    parts.push('## 执行者最后一轮的输出', '```', (String(r.finalText || '').trim() || '(空)').slice(-6000), '```', '');
    parts.push(
      '## 机器观测到的事实',
      `进程退出原因: ${r.exitReason}`,
      `stop_reason: ${r.stopReason ?? 'None'}`,
      `上下文水位峰值: ${(r.contextPeak || 0).toLocaleString('en-US')} tokens`,
      `本次调用轮数: ${r.numTurns || 0}`);
    // 未收尾的后台 agent：**执行者自己也不知道**这几件事没交付。不告诉监督者，它只看到一段
    // 正常的阶段汇报。diablo 实测：4 个子系统 agent 等超时被丢，监督者理由写"进程正常结束，继续推进即可"
    if (r.pendingTasks?.length) {
      const names = r.pendingTasks.map((t) => t.description || t.task_id || '?').join('、');
      parts.push(
        `⚠ 有 ${r.pendingTasks.length} 个后台 subagent 到本发结束时仍未收尾，它们的工作没有回传给执行者: ${names}`,
        '  这类 agent 是直接写文件的，产出通常已落在工作树里，只是执行者没拿到它们的总结。',
        '  **这条事实只用在一处：它说自己正等着这些 agent 时，判 continue（下一发它会自己去看文件）。**',
        '  ⚠ **不要用这条去否决它说的「完成」。** 它说干完了就是project_done，与这里有几个 agent 没回传无关——'
          + '它看得见工作树，你看不见。拿这条当「它的完成判断不可靠」的理由，'
          + '就是在用机器观测推翻执行者的自述，那正是上一节禁止的事。');
    }
    if (phase) parts.push(`当前所处阶段: ${phase}`);
    if (r.error) parts.push('', '## 进程错误输出', '```', String(r.error).slice(-1500), '```');
    return parts.join('\n');
  }
}

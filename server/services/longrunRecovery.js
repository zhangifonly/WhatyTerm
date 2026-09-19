/**
 * 长程编排：供应商侧故障的自动恢复策略（纯逻辑，无 IO）。
 *
 * 由来（Hitech 2026-09-18/19 实测，两轮共白烧约 $0.94 与 12 分钟）：
 * 供应商报 `503 分组 zhangzong 下模型 claude-fable-5-1 无可用渠道（distributor）`。
 * 时间线摊开看，问题不在"重试不够"，而在**重试方式完全错**：
 *   · CLI 内部已经指数退避重试 10 次（1s→1s→2s→4s→10s→17s→35s…共约 3 分钟）
 *   · 它失败返回后，我们**零等待**紧接着再发 3 发，每发又各自内部重试 3 分钟
 *   → 12 分钟里所有请求都撞在同一个坏渠道上，然后停机等人。
 *
 * 所以自动恢复要做两件事，顺序不能反：
 *   ① 先**等**（供应商侧故障多是临时的，503 尤其），间隔递增，别急着改配置
 *   ② 等过一轮仍不行，再**换模型**（同一供应商内换，计费与数据去向不变）
 *
 * ⚠ 刻意**不自动换供应商**：那会把用户的代码发往另一家中转站、费用记在那边，
 *   且发生在无人值守时。这个决定必须由人做。
 */

import { classifyError } from './longrunErrorBrief.js';

/**
 * 等待梯度（毫秒）。第 n 次供应商侧故障等 WAIT_LADDER[n-1]。
 * 取值理由：CLI 自己已经耗掉约 3 分钟，所以第一档就给 1 分钟而不是几秒——
 * 几秒的等待对"渠道掉了"这种故障毫无意义，只是把钱烧得更快。
 * 总计约 18 分钟，够扛过多数临时故障，又不会让一次无人值守的夜跑白等一整晚。
 */
export const WAIT_LADDER = [60_000, 120_000, 300_000, 600_000];

/** 换模型之前，先把等待梯度走完几档。等待不花钱，换模型会改变产出质量，所以先等 */
export const SWITCH_MODEL_AFTER = 2;

/** 哪些归类算「供应商侧故障」——可以靠等待或换模型自救的那些 */
const PROVIDER_SIDE = new Set(['provider_no_channel', 'provider_overloaded', 'rate_limit']);

/**
 * 决定下一步怎么恢复。
 *
 * @param {object} p
 * @param {string} p.error            执行者给出的错误正文
 * @param {number} p.providerFailures 本轮连续的供应商侧失败次数（含这一次）
 * @param {string[]} [p.triedModels]  已经试过的模型（含当前）
 * @param {string[]} [p.available]    当前供应商可用模型清单（拿不到就传空）
 * @returns {{action:'wait'|'switch_model'|'stop', waitMs:number, model:string, reason:string}}
 *   action=stop 表示自动恢复无能为力（不是供应商侧故障，或手段已用尽），交给人
 */
export function planRecovery({ error, providerFailures = 1, triedModels = [], available = [] } = {}) {
  const c = classifyError(error);
  if (!PROVIDER_SIDE.has(c.kind)) {
    // 认证失败、CLI 缺失、上下文超限、代码报错——等和换模型都治不了，别浪费时间和钱
    return { action: 'stop', waitMs: 0, model: '', reason: `${c.label}，自动重试无用：${c.advice}` };
  }

  // 等待梯度还没走完 → 先等。限流（rate_limit）尤其只能等，换模型往往同池同限
  if (providerFailures <= SWITCH_MODEL_AFTER || c.kind === 'rate_limit') {
    const waitMs = WAIT_LADDER[Math.min(providerFailures - 1, WAIT_LADDER.length - 1)];
    return {
      action: 'wait', waitMs, model: '',
      reason: `${c.label}（第 ${providerFailures} 次），等 ${Math.round(waitMs / 60000)} 分钟再试`,
    };
  }

  // 等过了还不行 → 换一个同供应商下的可用模型
  const next = pickModel(available, triedModels);
  if (next) {
    return { action: 'switch_model', waitMs: 0, model: next, reason: `等待无效，换模型 ${next} 重试（同一供应商）` };
  }

  // 没有清单或都试过了 → 继续等到梯度用尽，再交给人
  if (providerFailures - 1 < WAIT_LADDER.length) {
    const waitMs = WAIT_LADDER[Math.min(providerFailures - 1, WAIT_LADDER.length - 1)];
    return { action: 'wait', waitMs, model: '', reason: `${c.label}，没有可换的模型，等 ${Math.round(waitMs / 60000)} 分钟再试` };
  }
  return {
    action: 'stop', waitMs: 0, model: '',
    reason: `${c.label}：已等待 ${WAIT_LADDER.length} 轮${available.length ? '并试过全部可用模型' : ''}仍未恢复，${c.advice}`,
  };
}

/**
 * 从可用清单里挑下一个没试过的模型。
 * 只在清单里挑，绝不凭名字规律拼一个——拼出来的名字同样会撞「无可用渠道」。
 */
export function pickModel(available = [], tried = []) {
  const used = new Set((tried || []).filter(Boolean));
  return (available || []).find((m) => m && !used.has(m)) || '';
}

export default { planRecovery, pickModel, WAIT_LADDER, SWITCH_MODEL_AFTER };

/**
 * 长程收工后的结论与下一步建议（纯函数，零副作用，便于单测）
 *
 * 为什么用规则模板而不是再问一次模型：结论要每次一致、不花钱、不会把"没做的事"说成做了。
 * 数字全部来自实测（report / board），拿不到就不显示那一行 —— 宁可少说，不可编。
 *
 * 六种停机原因（LongRunLoop.Stop）都要有说法，尤其是 needs_human/budget/error 这三种
 * "没跑完"的：它们最需要告诉人现在该干什么，而原来界面上只有一句英文停机码。
 */

import { fmtDur } from './longrunBoard.js';

const money = (n) => `$${Number(n || 0).toFixed(2)}`;
const TONE = { project_done: 'ok', needs_human: 'wait', budget: 'wait', max_legs: 'wait', error: 'bad', interrupted: 'idle' };

/** 续跑时建议的新预算：已花的 1.5 倍，向上取整到整数美元，至少 +$1 */
export function suggestBudget(spentUsd) {
  const spent = Number(spentUsd) || 0;
  return Math.max(Math.ceil(spent * 1.5), Math.ceil(spent) + 1);
}

const ACT = {
  terminal: { key: 'toTerminal', label: '转为终端…', hint: '同一条目切回终端，用交互式 claude 接着做' },
  resume: { key: 'resume', label: '续跑长程…', hint: '追加需求，执行者从记忆接上继续无人值守' },
};

/**
 * @param {object} report 任务报告（task.report 或回放读到的 report.json）
 * @param {object} board  看板快照（没有 report 时退回 board.finished）
 * @returns {object|null} {tone, title, summary, next, facts, outcome, actions}
 */
export function longRunAdvice(report, board = {}) {
  const f = report || board.finished || null;
  if (!f) return null;
  const stop = f.stop || 'unknown';
  const legs = f.legs || 0;
  const cost = Number(f.cost_usd || f.costUsd || 0);
  const elapsed = fmtDur(f.elapsed_s || 0);
  const needs = String(f.needs_from_human || '').trim();

  const facts = [['耗时', elapsed], ['调用执行者', `${legs} 次`], ['花费', money(cost)]];
  if (f.handoffs) facts.push(['上下文交接', `${f.handoffs} 次`]);
  if (f.maintenances) facts.push(['记忆维护', `${f.maintenances} 轮`]);
  // 代答要单独说：那是"有 N 个决定不是你做的"，人有权知道
  if (f.decisions) facts.push(['监督者代你作答', `${f.decisions} 次`]);
  // 自救也要摆出来：中途等过十几分钟或换过模型，人只看耗时会以为是项目难
  const recN = f.outcome?.recoveryCount || 0;
  if (recN) facts.push(['供应商故障自动恢复', `${recN} 次`]);

  const base = { tone: TONE[stop] || 'idle', facts, outcome: f.outcome || null, actions: [ACT.terminal, ACT.resume] };
  switch (stop) {
    case 'project_done':
      return { ...base,
        title: '✅ 项目已完成',
        summary: `监督者判定需求已满足：${legs} 次调用、${elapsed}、花费 ${money(cost)}。`,
        next: '建议先验收：看下面的快照 commit 里改了什么，再跑一遍测试。确认没问题就「转为终端」接着开发，或「续跑长程」追加新需求。' };
    case 'needs_human':
      return { ...base,
        title: '✋ 它需要你拍板',
        summary: needs ? `卡在这里：${needs}` : '执行者停下来等人，但没说清要什么。',
        next: '任务已经停机，回答不能直接发给它：把决定写进「续跑长程」的新增需求里，它会从记忆接上；'
          + '想直接对话就「转为终端」。' };
    case 'budget':
      return { ...base,
        title: '💰 预算花完了',
        summary: `花到 ${money(cost)} 触线停机，${legs} 次调用、${elapsed}。活多半没干完。`,
        next: `想接着做就「续跑长程」，并把预算调到 ${money(suggestBudget(cost))} 以上；`
          + '只差收尾的话，「转为终端」自己接手更省。' };
    case 'max_legs':
      return { ...base,
        title: '🔁 调用次数用完了',
        summary: `跑满 ${legs} 次调用停机，${elapsed}、花费 ${money(cost)}。`,
        next: '在「续跑长程」的高级参数里调大调用次数上限；如果是卡在同一步反复试，先「转为终端」看一眼再决定。' };
    case 'error': {
      // 归类来自服务端（outcome.failure）。错在供应商时，「转为终端手工跑」这条默认建议
      // 是有害的 —— 手工跑必然再撞同一个 503/限流，白花时间。所以按归类改口。
      const fail = base.outcome?.failure || null;
      return { ...base,
        title: fail?.label ? `⚠ 停机了：${fail.label}` : '⚠ 连续异常，停机了',
        summary: fail?.detail
          ? `${needs ? `${needs}\n` : ''}执行者报的原话：${fail.detail}`
          : (needs ? `最后的错误：${needs}` : '执行者连续异常，已停机。'),
        next: fail?.advice
          ? `${fail.advice}。${fail.actionable === 'provider' ? '这类错误与项目代码无关，手工跑也会撞同一个坑。' : '编排日志在 .run/loop.log。'}`
          : '别直接续跑（多半会再撞同一个坑）：先「转为终端」手工跑一下看报什么错，编排日志在 .run/loop.log。' };
    }
    case 'interrupted':
      return { ...base,
        title: '■ 你终止了它',
        summary: `本轮做到 ${legs} 次调用、${elapsed}、花费 ${money(cost)}。进度与记忆都留着。`,
        next: '想接着做就「续跑长程」（从记忆接上），或「转为终端」自己接手。' };
    default:
      return { ...base,
        title: '本轮已结束',
        summary: `停机原因：${stop}。${legs} 次调用、${elapsed}、花费 ${money(cost)}。`,
        next: '可以「转为终端」接手，或「续跑长程」让它从记忆接上继续。' };
  }
}

/** 成果摘要的一行文字；没有统计到就返回空串（不显示这一行） */
export function outcomeLine(outcome) {
  if (!outcome) return '';
  const parts = [];
  if (outcome.fileCount) {
    const names = (outcome.files || []).join('、');
    parts.push(`改动 ${outcome.fileCount} 个文件（+${outcome.insertions || 0}/−${outcome.deletions || 0}）${names ? `：${names}` : ''}`
      + (outcome.fileCount > (outcome.files || []).length ? ' 等' : ''));
  } else if (outcome.commit) {
    parts.push('本轮没有文件改动');
  }
  if (outcome.memoryCount) parts.push(`记忆 ${outcome.memoryCount} 个文件`);
  return parts.join(' · ');
}

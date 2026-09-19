/**
 * 把执行者的错误正文压成「人一眼能决定下一步」的一行，并判断它归谁处理。
 *
 * 由来（Hitech 2026-09-18 实测）：一轮长程连续四发全失败后停机，界面只说
 * 「最后的错误：连续 3 次进程异常」，loop.log 里也只有四行 `error`。
 * 真因其实一直都在 .run/events/*.jsonl 里躺着：
 *   API Error: 503 分组 zhangzong 下模型 claude-fable-5-1 无可用渠道（distributor）
 * 那是**供应商侧没有该模型的渠道**，人该做的是换模型或换供应商 —— 而提示语却说
 * 「先转为终端手工跑一下看报什么错」，手工跑只会再撞一次同样的 503，白花钱白花时间。
 *
 * 所以这里不只截断文本，还给出归类：错在我们、错在供应商、还是错在项目代码。
 */

/** 单行化并截断到适合面板一行显示的长度 */
export function briefLine(text, max = 160) {
  const one = String(text || '').replace(/\s+/g, ' ').trim();
  if (!one) return '';
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/**
 * 错误归类表。顺序有意义：越具体的排前面。
 * advice 要写「该做什么」，不是「出了什么」—— 后者错误正文自己会说。
 */
const RULES = [
  {
    kind: 'provider_no_channel',
    re: /无可用渠道|no available channel|no channel available|分组.{0,20}下模型/i,
    label: '供应商没有这个模型的渠道',
    advice: '换一个模型或换供应商（右侧面板可改），重试同一个模型多半还是这个结果',
  },
  {
    kind: 'provider_overloaded',
    re: /\b(503|502|504)\b|overloaded|server_error|Service Unavailable|temporarily unavailable/i,
    label: '供应商服务不可用',
    advice: '等几分钟再续跑；若持续如此，换供应商',
  },
  {
    kind: 'rate_limit',
    re: /rate.?limit|429|too many requests|quota|额度|限流/i,
    label: '被限流或额度用尽',
    advice: '等限流窗口过去再续跑，或换一个有额度的供应商',
  },
  {
    kind: 'auth',
    re: /\b401\b|\b403\b|unauthorized|forbidden|invalid.{0,10}(api.?key|token)|authentication/i,
    label: '认证失败',
    advice: '去 CC Switch 检查当前供应商的 Key 是否有效',
  },
  {
    kind: 'network',
    re: /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|network/i,
    label: '连不上供应商',
    advice: '检查网络与代理（本机 DNS 被污染过），或换供应商',
  },
  {
    kind: 'cli_missing',
    re: /command not found|ENOENT.{0,40}claude|spawn.{0,20}ENOENT/i,
    label: '找不到 CLI 可执行文件',
    advice: '确认 claude 命令在 PATH 里，且长程用的是同一个 shell 环境',
  },
  {
    kind: 'context_overflow',
    re: /prompt is too long|context.{0,20}(exceed|too large)|maximum context/i,
    label: '上下文超限',
    advice: '把交接水位调低，让它更早换窗口',
  },
];

/**
 * 归类一条错误正文。
 * @param {string} text 错误正文（来自 result 事件或 stderr）
 * @returns {{kind:string, label:string, advice:string, detail:string, actionable:'provider'|'project'}}
 *   actionable=provider 表示手工跑也会撞同一个坑，别劝人「转终端试试」
 */
export function classifyError(text) {
  const detail = briefLine(text);
  for (const r of RULES) {
    if (r.re.test(String(text || ''))) {
      return { kind: r.kind, label: r.label, advice: r.advice, detail, actionable: 'provider' };
    }
  }
  return {
    kind: 'unknown',
    label: detail ? '执行者报错' : '执行者异常退出但没给出错误正文',
    advice: detail
      ? '先「转为终端」手工跑一遍看是否复现，编排日志在 .run/loop.log'
      : '看 .run/events/ 里最后一个 jsonl 的 result 事件',
    detail,
    actionable: 'project',
  };
}

export default { briefLine, classifyError };

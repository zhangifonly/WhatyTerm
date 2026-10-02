/**
 * Codex rollout 增量扫描：把用量按**当时实际在用的模型**分开累计（v1.4.78）。
 *
 * 旧做法只读文件尾的累计 total_token_usage，再按尾部模型给整份记录计价——会话中途从 gpt-6-sol
 * 换到 gpt-6.1-sol，前面几十亿 token 全被按新模型重算，也无从分模型显示。
 *
 * 做法：相邻两条 token_count 的累计差值，归给这段时间最近一次 turn_context 声明的模型。
 * 实测 iSpring 记录（gpt-6-sol / gpt-6-luna / gpt-6.1-sol 三个模型，2.3 万条 token_count）：
 * 累计值零回退，分模型结果与逐请求的 token_usage_record 按 turn_id 归集相差 < 0.1%，
 * 且各模型之和恰等于末条累计值（与 Codex 自己的总数对得上）。新旧格式的 rollout 都有这两种行。
 */
import { codexBillable } from './costMath.js';

export const CODEX_SCAN_VERSION = 2;
const RELEVANT = /"type":"(?:turn_context|token_count)"/;

export function freshCodexState() {
  return { v: CODEX_SCAN_VERSION, remainder: '', models: {}, curModel: '', lastTotal: null };
}

const add = (into, b) => {
  for (const k of ['input', 'cacheRead', 'cacheWrite', 'output']) into[k] = (into[k] || 0) + (b[k] || 0);
};

/**
 * 扫一段文本（可在行中间切开，残行留在 remainder，下一段拼上再解析）。
 * @param {string} fallbackModel 还没见到任何 turn_context 时用（会话已知模型 / codex 配置默认）
 */
export function scanCodexChunk(text, st, fallbackModel = '') {
  const lines = (st.remainder + text).split('\n');
  st.remainder = lines.pop();
  for (const line of lines) {
    if (!RELEVANT.test(line)) continue;            // 绝大多数行（工具输出、推理）不解析，大文件首扫才扛得住
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const p = d.payload || {};
    if (d.type === 'turn_context') {
      if (p.model) st.curModel = p.model;
    } else if (p.type === 'token_count' && p.info?.total_token_usage) {
      const total = p.info.total_token_usage;
      const prev = st.lastTotal || {};
      const delta = {};
      let regressed = false;
      for (const k of Object.keys(total)) {
        delta[k] = (total[k] || 0) - (prev[k] || 0);
        if (delta[k] < 0) regressed = true;
      }
      // 累计值实测单调不退；万一退了，这一步不计，以新值为基准（宁可少记，不记负数）
      if (!regressed) {
        const m = st.curModel || fallbackModel || '';
        add(st.models[m] || (st.models[m] = {}), codexBillable(delta));
      }
      st.lastTotal = total;
    }
  }
  return st;
}

#!/usr/bin/env node
/**
 * 看监控策略到底有没有用。
 *
 *   node scripts/monitor-effectiveness.mjs [最近N条]
 *
 * 读 ~/.webtmux/action-outcomes.jsonl，按判定类型列出空转率。
 * 空转率高的判定说明那条规则在做无用功——它发出的操作对 CLI 没产生任何影响，
 * 该改判据、该收窄触发条件，或者干脆删掉。
 */
import actionOutcome from '../server/services/ActionOutcome.js';

const limit = parseInt(process.argv[2], 10) || 5000;
const { sampled, byState } = actionOutcome.stats(limit);

if (!sampled) {
  console.log('台账还没有数据。启动服务并让自动操作跑一段时间后再看。');
  console.log('（记录位置：~/.webtmux/action-outcomes.jsonl）');
  process.exit(0);
}

const pad = (s, n) => {
  // 中文按两格宽算，否则表格会错位
  const w = [...String(s)].reduce((a, c) => a + (/[一-鿿　-〿]/.test(c) ? 2 : 1), 0);
  return String(s) + ' '.repeat(Math.max(0, n - w));
};

console.log(`\n样本 ${sampled} 条\n`);
console.log(pad('判定类型', 34), pad('次数', 8), pad('有效率', 10), pad('空转率', 10), '打断率');
console.log('─'.repeat(80));
for (const g of byState) {
  const flag = g.noEffectRate >= 50 ? '  ← 空转' : g.interruptRate >= 10 ? '  ← 在打断工作' : '';
  const label = g.rule ? `[${g.rule}] ${g.state}` : g.state;
  console.log(
    pad(label, 34), pad(g.total, 8),
    pad(g.effectiveRate + '%', 10), pad(g.noEffectRate + '%', 10),
    g.interruptRate + '%' + flag
  );
}

console.log('\n口径：');
console.log('  有效 = CLI 真动起来了(advanced) + 屏幕有实质变化(changed)');
console.log('  空转 = 发出去之后屏幕纹丝不动，等于没发');
console.log('  打断 = 屏上出现 Interrupted，说明操作落在了正在跑的任务上');
console.log('  屏幕比对已抹掉走秒/token/spinner，不会把状态栏跳动当成变化\n');

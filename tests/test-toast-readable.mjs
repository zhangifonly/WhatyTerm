/**
 * 提示弹窗（toast）要看得清。
 *
 * 由来（2026-09-25）：切换供应商时右上角的绿色提示背景只有 15% 不透明度，底下终端的字透上来和提示叠在一起，
 * 看不清；浅色主题下还是浅绿字配白底。改为「主题弹层底色 + 淡色调」的不透明背景，正文用主题前景色。
 * 预览桩截图验过深色/浅色两套主题；这里钉住不能退化的两条。
 *
 * 运行: node tests/test-toast-readable.mjs
 */

import fs from 'fs';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n    ${e.message}`); } };
const assert = (c, m) => { if (!c) throw new Error(m); };
const src = fs.readFileSync(new URL('../src/components/Toast.jsx', import.meta.url), 'utf8');
const { toastBackground } = await import('../src/components/Toast.jsx').catch(() => ({}));

t('背景最底层是主题的不透明弹层色，不是只有一层半透明色块', () => {
  const m = src.match(/export const toastBackground = \(hue\) => `([^`]*)`/);
  assert(m, '找不到 toastBackground');
  assert(/,\s*hsl\(var\(--popover\)\)$/.test(m[1]), `最底层不是 hsl(var(--popover))：${m[1]}`);
  assert(/background: toastBackground\(config\.hue\)/.test(src), 'ToastItem 没用 toastBackground');
  if (toastBackground) assert(toastBackground('1 2% 3%').endsWith('hsl(var(--popover))'), '函数返回值不对');
});

t('正文用主题前景色（深浅主题都可读），不再写死浅色字', () => {
  assert(/color: 'hsl\(var\(--popover-foreground\)\)'/.test(src), '正文颜色不是主题前景色');
  assert(!/color: 'hsl\(\d+ \d+% (6|7)\d%\)'/.test(src), '又出现写死的浅色文字（浅色主题白底上看不清）');
});

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);

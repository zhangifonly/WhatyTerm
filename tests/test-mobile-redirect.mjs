/**
 * 桌面版 ⇄ 移动版 的跳转必须是**双向**的。
 *
 * 实测反馈（2026-09-22）：手机上点过一次移动版页头的「桌面版」链接后，
 * `wt_force_desktop` 标记永久留在 localStorage，之后每次打开都是 PC 版；
 * 而桌面版页面上**没有任何回移动版的入口** —— 一道有去无回的门。
 *
 * 这个脚本内联在 index.html 里（要在下载桌面 bundle 之前跑完），没法直接 import，
 * 所以把它抠出来在假 window 上执行，验证四条路径。
 *
 * 运行: node tests/test-mobile-redirect.mjs
 */

import fs from 'fs';

const results = { passed: 0, failed: 0, errors: [] };
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function test(name, fn) {
  try { fn(); results.passed++; console.log(`✅ ${name}`); }
  catch (err) { results.failed++; results.errors.push({ name, error: err.message }); console.log(`❌ ${name}`); }
}

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
assert(m, 'index.html 里找不到内联跳转脚本');
const code = m[1];

/** 在假环境里跑一遍脚本，返回跳到哪、标记还在不在 */
function run({ ua = '', search = '', flag = null } = {}) {
  const store = new Map();
  if (flag !== null) store.set('wt_force_desktop', flag);
  let replaced = null;
  const sandbox = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    location: { search, replace: (u) => { replaced = u; } },
    navigator: { userAgent: ua },
  };
  // eslint-disable-next-line no-new-func
  new Function('localStorage', 'location', 'navigator', code)(
    sandbox.localStorage, sandbox.location, sandbox.navigator,
  );
  return { replaced, flag: store.get('wt_force_desktop') ?? null };
}

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120';

test('手机首次打开 → 跳移动版', () => {
  const r = run({ ua: IPHONE });
  assert(r.replaced === '/m/', `没跳移动版：${r.replaced}`);
});

test('电脑打开 → 不跳（PC 上移动版没意义）', () => {
  assert(run({ ua: MAC }).replaced === null, '电脑不该被跳走');
});

test('?desktop=1 → 记住留在桌面版，之后手机打开也不再跳', () => {
  const r = run({ ua: IPHONE, search: '?desktop=1' });
  assert(r.replaced === null && r.flag === '1', JSON.stringify(r));
  assert(run({ ua: IPHONE, flag: '1' }).replaced === null, '标记在就不该跳');
});

test('?mobile=1 → 清掉标记并跳回移动版（这次补的逃生口）', () => {
  const r = run({ ua: IPHONE, search: '?mobile=1', flag: '1' });
  assert(r.replaced === '/m/', `没跳回移动版：${r.replaced}`);
  assert(r.flag === null, '标记没清掉 —— 下次打开又会是 PC 版');
});

test('电脑上带 ?mobile=1 也照跳（用户明确要求就该听）', () => {
  assert(run({ ua: MAC, search: '?mobile=1' }).replaced === '/m/', '显式请求应当满足');
});

test('两个方向都存在，任何一方向缺失都是有去无回的门', () => {
  assert(/desktop=1/.test(code) && /mobile=1/.test(code), '缺一个方向');
  assert(/removeItem\(['"]wt_force_desktop['"]\)/.test(code), '回移动版时没清标记');
});

// ── 界面入口守卫 ──────────────────────────────────────────────────
const app = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const mobileApp = fs.readFileSync(new URL('../src/mobile/MobileApp.jsx', import.meta.url), 'utf8');

test('守卫：两端界面上都要有去对面的链接（光有 URL 参数等于没有）', () => {
  assert(/href="\/\?mobile=1"/.test(app), '桌面版没有回移动版的链接 —— 人不知道 ?mobile=1 这个口令');
  assert(/href="\/\?desktop=1"/.test(mobileApp), '移动版没有去桌面版的链接');
});

test('守卫：桌面版那个链接只在手机 UA 下显示，且与跳转脚本同一套正则', () => {
  assert(/isMobileUA && \(/.test(app), '没有按 UA 收起 —— 电脑上显示「移动版」按钮没有意义');
  const uaRe = /Mobi\|Android\|iPhone\|iPod/;
  assert(uaRe.test(app) && uaRe.test(code),
    '两处 UA 判定口径不一致，会出现"跳过来了却看不到回去的链接"的死角');
});

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed) for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
process.exitCode = results.failed ? 1 : 0;

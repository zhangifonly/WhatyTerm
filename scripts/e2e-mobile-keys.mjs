/**
 * 移动版快捷键布局检查：iPhone SE（320px）/ iPhone 13（390px）/ Pixel 7（412px）三种宽度，
 * 10 个键必须两行、全部在屏幕内、无横向滚动、按钮高 ≥44px（触控下限）。截图 /tmp/keys.png。
 * 运行：node scripts/e2e-mobile-keys.mjs（需本机服务在 3928 且至少有一个会话）
 */
const { chromium, devices } = await import('/Users/zhangzhen/Documents/ClaudeCode/EasyVizControl/poc/node_modules/playwright-core/index.mjs');
const b = await chromium.launch();
let fail = 0;
for (const name of ['iPhone SE', 'iPhone 13', 'Pixel 7']) {
  const page = await (await b.newContext({ ...devices[name] })).newPage();
  await page.goto('http://127.0.0.1:3928/m/', { waitUntil: 'networkidle' });
  await page.locator('.m-card').first().tap();
  await page.waitForSelector('.m-actions-keys .m-btn', { timeout: 20000 });
  const r = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const btns = [...document.querySelectorAll('.m-actions-keys .m-btn')].map((e) => e.getBoundingClientRect());
    const rows = new Set(btns.map((x) => Math.round(x.top))).size;
    const out = btns.filter((x) => x.left < 0 || x.right > vw + 0.5).length;
    const minW = Math.min(...btns.map((x) => x.width)), minH = Math.min(...btns.map((x) => x.height));
    return { vw, n: btns.length, rows, out, minW: Math.round(minW), minH: Math.round(minH), scrollX: document.documentElement.scrollWidth > vw };
  });
  const good = r.out === 0 && r.rows === 2 && !r.scrollX && r.minH >= 44;
  if (!good) fail++;
  console.log(`${good ? '✅' : '❌'} ${name} 宽 ${r.vw}px：${r.n} 个键 ${r.rows} 行，出界 ${r.out} 个，最小 ${r.minW}×${r.minH}px，横向滚动 ${r.scrollX}`);
  if (name === 'iPhone 13') await page.locator('.m-actions').screenshot({ path: '/tmp/keys.png' });
}
await b.close(); process.exit(fail ? 1 : 0);

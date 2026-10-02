/**
 * 用量卡片折叠 E2E：真页面 + Playwright 真点击/键盘。默认收起、点摘要展开/收起、点明细不收起、
 * 收起后明细 inert、回车/空格可切换、刷新并换会话后保持上次状态。截图在 /tmp/fold-*.png。
 * 运行：node scripts/e2e-usage-card-fold.mjs（需本机服务在 3928，且有 iSpring 与 Hitech 会话）
 */
const { chromium } = await import('/Users/zhangzhen/Documents/ClaudeCode/EasyVizControl/poc/node_modules/playwright-core/index.mjs');
const b = await chromium.launch(); const page = await (await b.newContext({ viewport: { width: 1500, height: 1100 }, deviceScaleFactor: 2 })).newPage();
let fail = 0; const ok = (n, c, d = '') => { console.log(`${c ? '✅' : '❌'} ${n} ${c ? '' : d}`); if (!c) fail++; };
await page.goto('http://127.0.0.1:3928/', { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.removeItem('webtmux_usage_card_expanded'));
await page.reload({ waitUntil: 'networkidle' });
await page.locator('.session-item', { hasText: 'iSpring' }).first().click();
await page.waitForSelector('.usage-card .usage-summary', { timeout: 120000 });
const card = page.locator('.usage-card');
const sum = page.locator('.usage-card .usage-summary');
const tableVisible = async () => { const t = page.locator('.usage-models'); return (await t.count()) > 0 && (await t.boundingBox())?.height > 0 && await page.evaluate(() => getComputedStyle(document.querySelector('.usage-body')).opacity) === '1'; };
ok('默认收起', (await sum.getAttribute('aria-expanded')) === 'false' && !(await tableVisible()));
ok('收起时摘要四项都在', await page.locator('.usage-card .usage-main').isVisible() && await page.locator('.usage-card .usage-today').isVisible() && await page.locator('.usage-card .usage-tokens').isVisible());
ok('收起时提示模型数', (await page.locator('.usage-toggle-hint').textContent())?.includes('个模型'));
await card.screenshot({ path: '/tmp/fold-collapsed.png' });
await sum.click(); await page.waitForTimeout(400);
ok('点击展开', (await sum.getAttribute('aria-expanded')) === 'true' && await tableVisible());
await card.screenshot({ path: '/tmp/fold-expanded.png' });
await page.locator('.usage-models td').first().click(); await page.waitForTimeout(300);
ok('点明细区不会收起', (await sum.getAttribute('aria-expanded')) === 'true');
await sum.click(); await page.waitForTimeout(400);
ok('再点收起', (await sum.getAttribute('aria-expanded')) === 'false' && !(await tableVisible()));
ok('收起后明细不可 Tab 到（inert）', await page.evaluate(() => document.querySelector('.usage-body').inert === true));
await sum.focus(); await page.keyboard.press('Enter'); await page.waitForTimeout(400);
ok('键盘回车展开', (await sum.getAttribute('aria-expanded')) === 'true');
await page.reload({ waitUntil: 'networkidle' });
await page.locator('.session-item', { hasText: 'Hitech' }).first().click();
await page.waitForSelector('.usage-card .usage-summary', { timeout: 120000 });
ok('刷新并换会话后保持展开', (await page.locator('.usage-card .usage-summary').getAttribute('aria-expanded')) === 'true');
await page.keyboard.press('Tab');
await page.locator('.usage-card .usage-summary').focus(); await page.keyboard.press(' '); await page.waitForTimeout(400);
ok('空格键收起', (await page.locator('.usage-card .usage-summary').getAttribute('aria-expanded')) === 'false');
await page.evaluate(() => localStorage.removeItem('webtmux_usage_card_expanded'));
await b.close(); process.exit(fail ? 1 : 0);

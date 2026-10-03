/**
 * 「拖动选择，松开即复制」三浏览器 E2E：真 WebTmux 页面 + 真 tmux + Playwright 真鼠标（受信任手势）。
 *
 * 判据：剪贴板写入调用**成功返回**且内容就是拖选的那段字（只看调用发起不算——
 * Safari / Firefox 在非手势下会拒绝，那正是「提示说复制了、实际没复制」的根因）。
 * 三个都必过。Firefox 不认 Promise 形式的 ClipboardItem（DataError），会退回普通写入。
 * diag 字段逐环记录：页面是否开了鼠标上报、发出的鼠标帧数、tmux 是否进入选择模式、页面收到的 OSC 52 帧数。
 * 测试会话需先输出几行再输出探针（不能在第一行：拖在屏幕最上沿会触发 tmux 自动上滚）。
 * v1.4.88 必测场景：会话里的应用开着 1003（Claude Code 全屏模式就是），探针输出后接
 *   printf '\033[?1003h\033[?1006h'; cat > /dev/null
 * 去掉 attachMouseModeGuard 时三浏览器都只发出 3~5 个鼠标事件、不复制（实测），装上后全过。
 *
 * 用法：node scripts/e2e-drag-copy.mjs <playwright-core/index.mjs> <测试会话在列表里的文字前缀> [tmux 会话名]
 * 产物：~/.webtmux/e2e/drag-copy-<时间>.json
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
const tmuxIn = (t) => execFileSync('tmux', ['display', '-p', '-t', t, '#{pane_in_mode}'], { encoding: 'utf-8' }).trim();

const [pwPath, itemPrefix, tmuxTarget] = process.argv.slice(2);
const { chromium, firefox, webkit } = await import(pwPath);
const EXPECT = 'COPYPROBE_abc_123_xyz';
const results = [];

const hook = `(() => {
  window.__clip = [];
  const c = navigator.clipboard;
  const ow = c.write?.bind(c), ot = c.writeText?.bind(c);
  if (ow) c.write = (items) => ow(items).then(async (r) => {
    const t = await (await items[0].getType('text/plain')).text();
    window.__clip.push({ via: 'write(手势预约)', ok: true, t }); return r;
  }, (e) => { window.__clip.push({ via: 'write(手势预约)', ok: false, err: String(e) }); throw e; });
  if (ot) c.writeText = (t) => ot(t).then((r) => { window.__clip.push({ via: 'writeText', ok: true, t }); return r; },
    (e) => { window.__clip.push({ via: 'writeText', ok: false, err: String(e) }); throw e; });
})();`;

for (const [bname, btype] of [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]]) {
  for (const mode of ['fixed']) {
    const browser = await btype.launch();
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    if (bname === 'chromium') await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:3928' });
    await ctx.addInitScript(hook);
    const page = await ctx.newPage();
    const diag = { mouseFrames: 0, osc52: 0, inMode: null, mouseClass: null };
    page.on('websocket', (ws) => {
      ws.on('framesent', (f) => { if (String(f.payload).includes('\\u001b[<')) diag.mouseFrames++; });
      ws.on('framereceived', (f) => { if (String(f.payload).includes(']52;')) diag.osc52++; });
    });
    let r = { browser: bname, mode };
    try {
      await page.goto('http://127.0.0.1:3928/', { waitUntil: 'networkidle' });
      await page.locator('.session-item', { hasText: itemPrefix }).first().click();
      await page.waitForFunction((t) => document.querySelector('.xterm-rows')?.textContent.includes(t), EXPECT, { timeout: 10000 });
      // 等尺寸同步完：前端 fit 后 100ms 才把新尺寸发给 tmux，之前拖动坐标会和 tmux 的行对不上（实测会选到上一行）
      await page.waitForTimeout(2500);
      const box = await page.locator('.xterm-screen').boundingBox();
      // 选探针所在那一行，而且它不在第一行：拖在屏幕最上沿会触发 tmux 自动往上滚，选区被带到上一行
      const { rows, idx } = await page.evaluate((t) => {
        const rs = [...document.querySelector('.xterm-rows').children];
        return { rows: rs.length, idx: rs.findIndex((r) => r.textContent.startsWith(t)) };
      }, EXPECT);
      if (idx < 1) throw new Error(`探针行位置不对（第 ${idx} 行），测试前先在会话里多输出几行再输出探针`);
      const y = box.y + (box.height / rows) * (idx + 0.5);
      await page.mouse.move(box.x + 2, y);
      diag.mouseClass = await page.evaluate(() => document.querySelector('.xterm').classList.contains('enable-mouse-events'));
      await page.mouse.down();
      for (let i = 1; i <= 15; i++) await page.mouse.move(box.x + 2 + i * 12, y, { steps: 2 });
      if (tmuxTarget) diag.inMode = tmuxIn(tmuxTarget);
      await page.mouse.up();
      await page.waitForTimeout(1800);
      const clip = await page.evaluate(() => window.__clip);
      // 选完直接打字：高亮收起、退出选择模式，字进命令行（tmux 选择模式会吃按键，这一步是 v1.4.77 补的）
      if (tmuxTarget) {
        diag.heldAfterRelease = tmuxIn(tmuxTarget);
        await page.keyboard.type('zq');
        await page.waitForTimeout(600);
        diag.inModeAfterType = tmuxIn(tmuxTarget);
        diag.typedReached = execFileSync('tmux', ['capture-pane', '-p', '-t', tmuxTarget], { encoding: 'utf-8' }).includes('zq');
        await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace');
      }
      const typedOk = !tmuxTarget || (diag.heldAfterRelease === '1' && diag.inModeAfterType === '0' && diag.typedReached);
      const ok = typedOk && clip.find((c) => c.ok && c.t && EXPECT.startsWith(c.t.trim()) && c.t.trim().length >= 10);
      r = { ...r, copied: !!ok, text: ok?.t, attempts: clip, diag };
    } catch (e) {
      r = { ...r, copied: false, error: e.message.slice(0, 200) };
    }
    results.push(r);
    console.log(`${r.copied ? '✅' : '❌'} ${bname.padEnd(8)} ${mode.padEnd(6)} ${r.copied ? `复制到「${r.text}」` : (r.error || JSON.stringify(r.attempts))}  ${JSON.stringify(r.diag)}`);
    await browser.close();
  }
}
const out = path.join(os.homedir(), '.webtmux', 'e2e', `drag-copy-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(results, null, 2));
console.log(`产物：${out}`);
const fixedOk = results.every((r) => r.copied);
process.exit(fixedOk ? 0 : 1);

/**
 * 自动发送的文本有没有真的落进 CLI 输入框，没落进就重试一次，再不行就如实报出来。
 *
 * 由来（2026-09-25，WebOffice）：17:13 之后监控发了 12 次「继续」，tmux send-keys 全部成功，
 * 但输入框里连这两个字都没出现、transcript 里没有任何新输入 —— 按键到了窗格，CLI 没收进去。
 * 台账把 12 次都记成 no_effect、熔断后停手，界面却一直写着「检测到等待输入状态，发送继续」，
 * 没人知道它停了。同一时段其他会话发送全部正常；事后手动发一次就进去了，原因没能复现。
 *
 * 做法：先只打字、不回车，确认输入框里多出了这段文本再按回车。没多出来 → 重打一次；
 * 还是没有 → **不按回车**（按了也只是提交空输入框或别的东西），返回未落地，由调用方标记会话。
 */

import { promptPendingText, stripPromptSuggestion } from './promptState.js';

const stripAnsi = (s) => String(s || '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

/**
 * 输入框里这段文本出现了几次（提示符行找不到时为 -1）。
 * screen 要带颜色码（capture-pane -e）：先去掉暗色的建议文字 —— 它剥了颜色码就和打进去的字分不开。
 */
export function pendingCount(screen, text) {
  const pending = promptPendingText(stripAnsi(stripPromptSuggestion(String(screen || ''))));
  if (pending === null) return -1;
  if (!text) return 0;
  return pending.split(text).length - 1;
}

/**
 * 判「落地」用**次数比发送前多了**，而不是「输入框里有这段字」：输入框里本来就可能有同样的字
 * （比如用户草稿）。暗色建议文字已在 pendingCount 里剥掉，不会干扰计数。
 */
export function landed(before, after, text) {
  const b = pendingCount(before, text);
  const a = pendingCount(after, text);
  return a > Math.max(b, 0);
}

/**
 * @param {object} o
 * @param {string} o.text
 * @param {(text:string)=>void} o.typeText      只打字、不回车
 * @param {()=>void} o.pressEnter
 * @param {()=>Promise<string>} o.capture       抓**当前**屏幕（不能走缓存，否则看到的是打字前那一屏）
 * @param {(ms:number)=>Promise<void>} [o.sleep]
 * @param {number} [o.pollMs]   每隔多久看一次
 * @param {number} [o.waitMs]   每次打字后最多等多久
 * @param {number} [o.retries]  没落地时重打几次
 * @returns {Promise<{landed:boolean|null, attempts:number}>} landed 为 null = 认不出输入框、无从核对
 */
export async function sendTextVerified({ text, typeText, pressEnter, capture, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  pollMs = 250, waitMs = 1500, retries = 1 }) {
  const before = await capture();
  // 认不出输入框（Codex 的 ›、Grok 的盒装提示符等）→ 无从核对，按原来的方式打字后回车。
  // 绝不能因为「核对不了」就不按回车 —— 那会把这些 CLI 的自动继续全部卡死
  if (pendingCount(before, text) === -1) {
    typeText(text);
    await sleep(50);   // 文本与回车分两次发（Ink TextInput 的要求）
    pressEnter();
    return { landed: null, attempts: 1 };
  }
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    typeText(text);
    for (let waited = 0; waited < waitMs; waited += pollMs) {
      await sleep(pollMs);
      if (landed(before, await capture(), text)) {
        pressEnter();
        return { landed: true, attempts: attempt };
      }
    }
  }
  return { landed: false, attempts: retries + 1 };
}

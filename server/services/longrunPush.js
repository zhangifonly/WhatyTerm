/**
 * 长程 → 手机推送：只推两件事 —— **开始等你** 与 **收工**。
 *
 * 为什么只推这两件：长程本就是你不在电脑前时跑的，只有这两个时刻需要你做点什么
 * （回答 / 验收）。每发结束、监督者代答这类进度推给你，一晚上几十条，很快就会被关掉通知，
 * 真到等你的那一条也就看不到了。
 *
 * 判定走「边沿」而不是「状态」：任务摘要一分钟能广播几十次，按状态推会刷屏。
 * 只在 未等→等 与 在跑→不跑 的那一下推一次。
 */

/** 停机原因的一句话说法。服务端单独打包（不带 src/），不能复用前端的 longrunAdvice，这里只要标题级别 */
const STOP_TITLE = {
  project_done: '✅ 长程完成',
  needs_human: '🔔 长程停下等你',
  budget: '💰 长程预算用完',
  max_legs: '⏹ 长程到发次上限',
  error: '❌ 长程出错停机',
  interrupted: '⏸ 长程被中断',
};
const QUESTION_HEAD = 120;

/**
 * @param {{awaiting:boolean, state:string}|undefined} prev  上一次看到的状态（首次为 undefined）
 * @param {object} t  任务摘要（task.toJSON()）
 * @returns {'waiting'|'finished'|null}
 */
export function longRunPushEdge(prev, t) {
  if (!t) return null;
  const running = t.state === 'running';
  const awaiting = running && !!t.awaitingHuman;
  if (awaiting && !prev?.awaiting) return 'waiting';
  // 只认「看见过它在跑、现在不跑了」。首次就看到已收工的（刷新列表、服务端重放）不是新消息
  if (prev?.state === 'running' && !running) return 'finished';
  return null;
}

/** 下一次比较用的状态 */
export function longRunPushState(t) {
  return { awaiting: t?.state === 'running' && !!t?.awaitingHuman, state: t?.state || '' };
}

const money = (n) => `$${Number(n || 0).toFixed(2)}`;
const oneLine = (s, n) => {
  const x = String(s || '').replace(/\s+/g, ' ').trim();
  return x.length > n ? `${x.slice(0, n - 1)}…` : x;
};

/**
 * 组通知内容。推送经第三方推送服务器中转，**只放摘要**：问题取开头一句，不放代码和完整原文。
 * @param {'waiting'|'finished'} kind
 * @param {object} t      任务摘要
 * @param {object|null} brief  longRunBrief 的结果（只有 waiting 需要，用来取问题）
 */
export function longRunPushPayload(kind, t, brief = null) {
  const name = t.sandboxName || '长程';
  const url = t.sessionId ? `/m/?session=${encodeURIComponent(t.sessionId)}` : '/m/';
  // 同一任务一个 topic：手机离线时推送服务器只留最新那条（收工会顶掉之前的"在等你"）
  const topic = `lr-${String(t.id || '').replace(/[^A-Za-z0-9_-]/g, '')}`.slice(0, 32);
  if (kind === 'waiting') {
    const nh = brief?.needHuman;
    const ask = oneLine(nh?.needs || nh?.question || '', QUESTION_HEAD);
    return { title: `🔔 ${name} 在等你回答`, body: ask || '执行者停下来等你拍板，点开回答', url, topic,
      tag: `lr-${t.id}`, urgency: 'high' };
  }
  const r = t.report || {};
  const facts = [`${r.legs ?? t.legs ?? 0} 发`, money(r.cost_usd ?? t.costUsd)].join(' · ');
  return { title: `${STOP_TITLE[r.stop] || '⏹ 长程已收工'}：${name}`, body: `${facts}，点开看结论`, url, topic,
    tag: `lr-${t.id}`, urgency: 'normal' };
}

/**
 * 有状态的观察者：挂在任务摘要广播上，算出边沿就发。
 * getBrief 惰性调用：看板快照动辄几百 KB，只在真要推"在等你"时才取。
 */
export class LongRunPushNotifier {
  constructor({ push, log = console }) {
    this.push = push;
    this.log = log;
    this.seen = new Map();
  }

  observe(t, getBrief = () => null) {
    if (!t?.id) return null;
    const kind = longRunPushEdge(this.seen.get(t.id), t);
    this.seen.set(t.id, longRunPushState(t));
    if (!kind) return null;
    if (!this.push.list().length) return null;      // 没人订阅就不取快照、不组内容
    let brief = null;
    if (kind === 'waiting') { try { brief = getBrief(); } catch { /* 取不到问题也照推，只是没原文 */ } }
    const payload = longRunPushPayload(kind, t, brief);
    this.push.send(payload).then((r) => {
      this.log.log?.(`[推送] ${kind} ${t.sandboxName || t.id}: 送达 ${r.sent}，清理失效 ${r.removed}，失败 ${r.failed}`
        + (r.errors.length ? ` (${r.errors.join('; ')})` : ''));
    }).catch((e) => this.log.error?.('[推送] 发送出错:', e?.message || e));
    return payload;
  }
}

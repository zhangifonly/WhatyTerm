// 微信认证前端逻辑：状态查询 / 发起授权 / 处理回跳
// 云端中转（crs.owly.cn/wxauth/*）换 openid + HMAC 签名，本机白名单校验。

/** 查询微信认证状态 { configured, bound, relayBase, openids } */
export async function fetchWxStatus() {
  try {
    const res = await fetch('/api/auth/wx-status');
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** 是否在微信内置浏览器（网页授权必须在微信内打开） */
export function isWeChatBrowser() {
  return /MicroMessenger/i.test(navigator.userAgent);
}

/**
 * 发起微信授权：跳到云端中转 /wxauth/start。
 * mode: 'login' 远程免密登录 | 'bind' 本机绑定（需 bindToken）
 * 回跳地址用当前页面（去掉已有的 wx_* 参数）。
 */
export function startWxAuth(relayBase, mode = 'login', bindToken = '') {
  const here = new URL(window.location.href);
  ['wx_openid', 'wx_ts', 'wx_sig', 'wx_mode', 'wx_bt'].forEach((k) => here.searchParams.delete(k));
  const u = new URL('/wxauth/start', relayBase);
  u.searchParams.set('redirect', here.toString());
  u.searchParams.set('mode', mode);
  if (bindToken) u.searchParams.set('bt', bindToken);
  window.location.href = u.toString();
}

/**
 * 处理授权回跳：URL 带 wx_openid/wx_ts/wx_sig 时调用对应接口。
 * 返回 { mode, ok, token?, error? }；无回跳参数返回 null。
 * 成功后清掉 URL 里的 wx_* 参数。
 */
export async function handleWxCallback() {
  const params = new URLSearchParams(window.location.search);
  const openid = params.get('wx_openid');
  const ts = params.get('wx_ts');
  const sig = params.get('wx_sig');
  if (!openid || !ts || !sig) return null;
  const mode = params.get('wx_mode') === 'bind' ? 'bind' : 'login';
  const bindToken = params.get('wx_bt') || '';

  const path = mode === 'bind' ? '/api/auth/wx-bind' : '/api/auth/wx-login';
  let result;
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ openid, ts: Number(ts), sig, bindToken }),
    });
    const data = await res.json().catch(() => ({}));
    result = { mode, ok: res.ok, token: data.token, error: data.error };
  } catch (err) {
    result = { mode, ok: false, error: err.message };
  }

  const clean = new URL(window.location.href);
  ['wx_openid', 'wx_ts', 'wx_sig', 'wx_mode', 'wx_bt'].forEach((k) => clean.searchParams.delete(k));
  window.history.replaceState({}, '', clean.toString());
  return result;
}

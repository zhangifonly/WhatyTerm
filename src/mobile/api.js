/** 移动版认证 HTTP 封装（同源，session cookie 自动携带） */

async function jsonFetch(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON 响应 */ }
  return { ok: res.ok, status: res.status, data };
}

/** 认证状态：{authenticated, enabled, isLocal, requirePasswordSetup} */
export async function getAuthStatus() {
  const { data } = await jsonFetch('/api/auth/status');
  return data || { authenticated: false, enabled: false };
}

/** 在线账号登录（term.whaty.org 账户） */
export async function onlineLogin(email, password) {
  const { data } = await jsonFetch('/api/auth/online-login', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  });
  return data || { success: false, error: '网络错误' };
}

/** 发起扫码免密登录（电脑端弹窗确认）→ {id, code} 或 {error} */
export async function requestScanLogin() {
  const { ok, status, data } = await jsonFetch('/api/auth/scan-login-request', {
    method: 'POST'
  });
  if (!ok) return { error: data?.error || (status === 429 ? '请求过于频繁' : '发起失败') };
  return data;
}

/** 轮询扫码审批结果：'pending' | 'approved' | 'denied' | 'expired' */
export async function pollScanLogin(id) {
  const { data } = await jsonFetch(`/api/auth/scan-login-status?id=${encodeURIComponent(id)}`);
  return data?.status || 'expired';
}

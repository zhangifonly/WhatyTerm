#!/usr/bin/env node
/**
 * WhatyTerm 微信 OAuth 云端中转（部署 CN-BJ，crs.owly.cn/wxauth/*）
 * 职责最小：发起授权 → code 换 openid → HMAC 签名 → 回跳客户端。
 * 不存任何用户数据；openid 白名单校验在客户端本机。
 */
import http from 'http';
import crypto from 'crypto';

const PORT = Number(process.env.WX_RELAY_PORT || 4900);
const APPID = process.env.WX_APPID || '';
const SECRET = process.env.WX_APPSECRET || '';
const RELAY_SECRET = process.env.WX_RELAY_SECRET || '';
const SELF_BASE = process.env.WX_SELF_BASE || 'https://crs.owly.cn';

// 允许回跳的客户端域名（隧道域名 + 本地调试），防开放重定向
const REDIRECT_ALLOW = [
  /\.frp\.whaty\.org$/i, /\.frp-kc01\.whaty\.org$/i, /\.frp-lax01\.whaty\.org$/i,
  /\.trycloudflare\.com$/i, /^localhost$/i, /^127\.0\.0\.1$/,
];

function allowRedirect(u) {
  try { const h = new URL(u).hostname; return REDIRECT_ALLOW.some(re => re.test(h)); }
  catch { return false; }
}
const b64e = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const b64d = (s) => { try { return JSON.parse(Buffer.from(s, 'base64url').toString()); } catch { return null; } };

async function codeToOpenid(code) {
  const u = `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${APPID}&secret=${SECRET}&code=${code}&grant_type=authorization_code`;
  const r = await fetch(u);
  const j = await r.json();
  if (!j.openid) throw new Error(`wx api: ${JSON.stringify(j)}`);
  return j.openid;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, SELF_BASE);
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  const redir = (loc) => { res.writeHead(302, { Location: loc }); res.end(); };
  try {
    if (url.pathname === '/wxauth/health') {
      return send(200, { ok: true, configured: !!(APPID && SECRET && RELAY_SECRET) });
    }
    if (url.pathname === '/wxauth/start') {
      // redirect=客户端回跳地址  mode=login|bind  bt=绑定一次性令牌（bind 模式）
      const redirect = url.searchParams.get('redirect') || '';
      const mode = url.searchParams.get('mode') === 'bind' ? 'bind' : 'login';
      const bt = url.searchParams.get('bt') || '';
      if (!allowRedirect(redirect)) return send(400, { error: 'redirect 域名不在白名单' });
      const state = b64e({ r: redirect, m: mode, bt });
      const cb = encodeURIComponent(`${SELF_BASE}/wxauth/callback`);
      return redir(`https://open.weixin.qq.com/connect/oauth2/authorize?appid=${APPID}&redirect_uri=${cb}&response_type=code&scope=snsapi_userinfo&state=${state}#wechat_redirect`);
    }
    if (url.pathname === '/wxauth/callback') {
      const code = url.searchParams.get('code');
      const st = b64d(url.searchParams.get('state') || '');
      if (!code || !st || !allowRedirect(st.r)) return send(400, { error: '非法回调' });
      const openid = await codeToOpenid(code);
      const ts = Date.now();
      const sig = crypto.createHmac('sha256', RELAY_SECRET).update(`${openid}.${ts}`).digest('hex');
      const back = new URL(st.r);
      back.searchParams.set('wx_openid', openid);
      back.searchParams.set('wx_ts', String(ts));
      back.searchParams.set('wx_sig', sig);
      back.searchParams.set('wx_mode', st.m);
      if (st.bt) back.searchParams.set('wx_bt', st.bt);
      return redir(back.toString());
    }
    send(404, { error: 'not found' });
  } catch (e) {
    send(500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`[wx-relay] listening 127.0.0.1:${PORT}`));

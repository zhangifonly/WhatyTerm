# 微信登录 — 进度与测试文档

> 需求：左下角「远程访问二维码」扫码后走**微信认证替代密码**——首次授权、之后免密。
> 状态：**全链路代码完成（v1.2.35），云端中转已部署 CN-BJ，仅差服务号 AppSecret**（后台启用时遇「操作频繁」限流，待重试）。

## 1. 方案（已定）

认证服务号网页授权(snsapi_userinfo) + **openid 白名单（仅本人）** + 保留密码备选。
安全红线：不是「微信授权就放行」，而是首次绑定记住本人 openid，其他微信一律拒。

## 2. 服务号信息

- 服务号：进化三部曲AI，**AppID `wxfd05762d2d892451`**
- AppSecret：⏳ 待后台「启用」（需管理员扫码验证，遇限流等 30 分钟重试）
- 网页授权域名：`crs.owly.cn`（**微信强制 ICP 备案** → 弃 term.whaty.org 改用 CN-BJ 的 owly.cn）
- IP 白名单：`110.42.98.154`（CN-BJ）

## 3. 架构

```
本机绑定（首次）：设置→安全→绑定微信→POST /api/auth/wx-bind-start 签发一次性 bindToken(10min)
  →显示二维码(crs.owly.cn/wxauth/start?mode=bind&bt=..&redirect=隧道URL)→本人微信扫→授权
  →回跳隧道页→POST /api/auth/wx-bind{openid,ts,sig,bindToken} 双重校验→写白名单
远程登录（日常）：微信扫左下角码→登录页「微信登录」→/wxauth/start→授权→换openid
  →HMAC签名回跳→POST /api/auth/wx-login 校验签名+白名单→建session→免密进入
```

签名：`HMAC-SHA256(openid.ts, WX_RELAY_SECRET)`，5 分钟有效，timingSafeEqual 比对。
密钥读取顺序：环境变量 `WX_RELAY_SECRET` > 本地 `server/db/auth-settings.json` 的
`wxRelaySecret`（已 gitignore，本机已写入）> 占位符（占位时 configured=false 隐藏入口）。

## 4. 已完成组件（v1.2.35）

| 层 | 文件 | 状态 |
|----|------|------|
| 后端认证 | `server/services/AuthService.js` | ✅ 白名单/HMAC 校验/getWxRelaySecret 三级读取 |
| 后端路由 | `server/index.js` | ✅ wx-status / wx-login / wx-bind / wx-bind-start / wx-unbind，authMiddleware 放行 |
| 云端中转 | `deploy/wx-relay/` | ✅ **已部署 CN-BJ /root/wx-relay，pm2 `wx-relay`，Caddy `crs.owly.cn/wxauth/*`→4900** |
| 前端逻辑 | `src/utils/wxAuth.js` | ✅ fetchWxStatus/startWxAuth/handleWxCallback/isWeChatBrowser |
| 前端 UI | `src/App.jsx` | ✅ 登录页微信按钮+回跳处理；设置→安全→绑定二维码/解绑 |

## 5. 已通过的测试（2026-07-19 实测）

云端中转（线上）：
- `curl https://crs.owly.cn/wxauth/health` → `{"ok":true,"configured":false}`（AppSecret 未填）
- 防开放重定向：evil.com→400，`*.frp.whaty.org`→302，Sub2API 原路由不受影响→200

客户端后端（临时实例 + 测试密钥六项闭环，全部符合预期）：

| 用例 | 期望 | 实测 |
|------|------|------|
| 伪造签名登录 | 401 | ✅ |
| 合法签名未绑定登录 | 403 | ✅ |
| 本机 bindToken 绑定 | 200 | ✅ |
| 绑定后登录 | 200 | ✅ |
| 其他 openid 登录 | 403 | ✅ |
| 过期时间戳(6min) | 401 | ✅ |

## 6. 剩余步骤（仅两步）

1. **拿 AppSecret**：mp.weixin.qq.com→设置与开发→基本配置→开发者密码「启用」
   （管理员扫码验证；限流则等 30 分钟）。拿到后：
   `ssh cn-bj "sed -i 's/^WX_APPSECRET=.*/WX_APPSECRET=真实值/' /root/wx-relay/.env && pm2 restart wx-relay"`
   校验 health `configured:true`。
2. **配网页授权域名**：公众号设置→功能设置→网页授权域名 填 `crs.owly.cn`，
   下载 MP_verify_xxx.txt → `scp` 到 cn-bj `/var/www/wxverify/`（Caddy 已配 file_server）。
   同时基本配置里 IP 白名单加 `110.42.98.154`。

然后按「阶段 B」真机联调：本机绑定→远程微信免密登录→未绑定微信被拒。

## 7. 注意事项

- 扫码必须**微信扫一扫**（微信内置浏览器才能网页授权）；相机扫走不通，前端有 isWeChatBrowser 检测。
- 绑定回跳经隧道 URL——绑定前需先启动隧道并在设置里保存 URL。
- 服务号后台自动化操作浏览器留有登录态（puppeteer 会话）；「操作频繁」是账号侧风控，换浏览器无效，等即可。
- 相关记忆：`wechat-auth-framework`。

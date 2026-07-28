# wx-relay 微信 OAuth 云端中转

部署位置：**CN-BJ (110.42.98.154) `/root/wx-relay/`**，Caddy 路由 `crs.owly.cn/wxauth/*` → `127.0.0.1:4900`。

选 CN-BJ 的原因：微信网页授权域名**必须 ICP 备案**，`owly.cn` 已备案（term.whaty.org 在美国 LAX02，过不了）。

## 服务号信息

- AppID: `wxfd05762d2d892451`（进化三部曲AI）
- 网页授权域名：`crs.owly.cn`（MP_verify 校验文件放 `/var/www/wxverify/`，Caddy file_server）
- IP 白名单：`110.42.98.154`

## 部署步骤

```bash
# 1. 同步代码
rsync -az deploy/wx-relay/ cn-bj:/root/wx-relay/

# 2. 写 .env（不进 git）
ssh cn-bj "cat > /root/wx-relay/.env" <<EOF
WX_APPID=wxfd05762d2d892451
WX_APPSECRET=<服务号后台启用后填入>
WX_RELAY_SECRET=<openssl rand -hex 32，客户端必须用同一个>
EOF

# 3. pm2 启动
ssh cn-bj "cd /root/wx-relay && pm2 start ecosystem.config.cjs && pm2 save"

# 4. Caddy 路由（/etc/caddy/Caddyfile 的 crs.owly.cn 块内，reverse_proxy 之前）：
#   handle /wxauth/* { reverse_proxy 127.0.0.1:4900 }
#   handle /MP_verify_*.txt { root * /var/www/wxverify
#     file_server }
# 然后 systemctl reload caddy

# 5. 校验
curl https://crs.owly.cn/wxauth/health   # {"ok":true,"configured":true}
```

## 接口

| 路径 | 说明 |
|------|------|
| `GET /wxauth/health` | 健康检查 |
| `GET /wxauth/start?redirect=<客户端URL>&mode=login\|bind&bt=<绑定令牌>` | 发起微信授权（redirect 仅限隧道域名/localhost） |
| `GET /wxauth/callback` | 微信回调：code→openid→HMAC 签名→带 `wx_openid/wx_ts/wx_sig/wx_mode/wx_bt` 参数回跳客户端 |

签名：`HMAC-SHA256(openid + "." + ts, WX_RELAY_SECRET)`，客户端 AuthService.verifyWxSignature 校验，5 分钟有效。

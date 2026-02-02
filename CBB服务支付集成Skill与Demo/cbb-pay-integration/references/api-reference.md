# CBB 支付服务 API 参考文档

## 认证接口

### 获取访问令牌

**接口地址**
```
POST /auth/v2/security/oauth/token
```

**请求头**
```http
Content-Type: application/x-www-form-urlencoded
```

**请求参数**

| 参数名 | 类型 | 必填 | 说明 |
|-------|------|------|------|
| grant_type | string | 是 | 固定值：client_credentials |
| client_id | string | 是 | 应用客户端ID |
| client_secret | string | 是 | 应用客户端密钥 |

**请求示例**
```bash
curl -X POST "https://api.webtrn.cn/auth/v2/security/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id=your_client_id" \
  -d "client_secret=your_client_secret"
```

**成功响应**
```json
{
  "access_token": "fa8196df-fd66-42c9-aa35-2a840126520d",
  "token_type": "bearer",
  "expires_in": 43199,
  "scope": "api"
}
```

**响应字段说明**

| 字段名 | 类型 | 说明 |
|-------|------|------|
| access_token | string | 访问令牌，有效期约12小时 |
| token_type | string | 令牌类型，固定为 bearer |
| expires_in | number | 有效期（秒） |
| scope | string | 授权范围 |

---

## 订单接口

### 创建订单

**接口地址**
```
POST /api/v2/pay/trade
```

**请求参数**

| 参数名 | 类型 | 必填 | 说明 |
|-------|------|------|------|
| goodName | string | 是 | 商品名称，在支付页面显示 |
| totalNumber | string | 是 | 订单金额，单位元，如 "100.01" |
| outTradeNo | string | 是 | 业务订单号，需保证唯一性 |
| expireTime | string | 是 | 过期时间，UTC格式：yyyy-MM-ddTHH:mm:ssZ |
| businessParams | string | 否 | 业务参数，JSON字符串，回调时原样返回 |

**请求示例**
```json
{
  "goodName": "测试商品",
  "totalNumber": "100.01",
  "outTradeNo": "20250825001",
  "expireTime": "2025-08-25T08:30:00Z",
  "businessParams": "{\"orderId\":\"123\",\"userId\":\"456\"}"
}
```

**成功响应**
```json
{
  "success": true,
  "data": {
    "tradeNo": "202508251430001234567890",
    "outTradeNo": "20250825001",
    "goodName": "测试商品",
    "totalNumber": "100.01",
    "status": "WAIT_PAY",
    "createTime": "2025-08-25 14:30:00",
    "expireTime": "2025-08-25T08:30:00Z"
  },
  "requestId": "c8e10426-0dec-49be-8edd-703b81c6d553"
}
```

**注意事项**
- expireTime 必须使用 UTC 格式（以 Z 结尾）
- 同一个 outTradeNo 在未过期时返回相同订单
- 如果订单已支付，返回错误

---

### 查询订单

**接口地址**
```
GET /api/v2/pay/trade/{tradeNo}
```

**路径参数**

| 参数名 | 类型 | 必填 | 说明 |
|-------|------|------|------|
| tradeNo | string | 是 | CBB系统订单号 |

**查询参数**

| 参数名 | 类型 | 必填 | 说明 |
|-------|------|------|------|
| includeThirdPayData | boolean | 否 | 是否包含第三方支付数据，默认false |

**成功响应**
```json
{
  "success": true,
  "data": {
    "tradeNo": "202508251430001234567890",
    "outTradeNo": "20250825001",
    "goodName": "测试商品",
    "totalNumber": 100.01,
    "payStatus": "PAYED",
    "createTime": "2025-08-25T14:30:00.000+00:00",
    "payTime": "2025-08-25T14:35:00.000+00:00",
    "channel": "WX_PAGE",
    "payThird": "WE_CHAT",
    "channelTradeNo": "4200002961202508257839226483"
  },
  "requestId": "c8e10426-0dec-49be-8edd-703b81c6d553"
}
```

**响应字段说明**

| 字段名 | 类型 | 说明 |
|-------|------|------|
| tradeNo | string | CBB 系统订单号 |
| outTradeNo | string | 业务订单号 |
| goodName | string | 商品名称 |
| totalNumber | **number** | 订单金额（⚠️ 注意：是数字类型，不是字符串） |
| payStatus | string | 支付状态（⚠️ 注意：字段名是 payStatus，不是 status） |
| createTime | string | 创建时间（ISO 8601 格式） |
| payTime | string | 支付时间（已支付时返回） |
| channel | string | 支付渠道 |
| payThird | string | 第三方支付类型 |
| channelTradeNo | string | 第三方支付订单号 |

**订单状态枚举（payStatus 字段）**

| 状态值 | 说明 |
|-------|------|
| WAIT_TO_PAY | 待支付 |
| PAYED | 已支付 |
| CLOSED | 已关闭 |

> ⚠️ **注意**：实际 API 返回的状态值与部分旧文档描述不同，请以此表为准。

---

### 根据业务订单号查询

**接口地址**
```
POST /api/v2/pay/trade/outTradeNo
```

**请求参数**

| 参数名 | 类型 | 必填 | 说明 |
|-------|------|------|------|
| outTradeNo | string | 是 | 业务订单号 |
| createDate | string | 是 | 订单创建日期，格式：yyyyMMdd |

**请求示例**
```json
{
  "outTradeNo": "20250825001",
  "createDate": "20250825"
}
```

**成功响应**
```json
{
  "success": true,
  "errorCode": null,
  "errorMsg": null,
  "requestId": "8e735cd9-37f2-442c-9fa5-7df9c0ddaa92",
  "data": {
    "clientId": "2004201503566462",
    "customerCode": "api",
    "tradeNo": "202601050019387904329407",
    "channel": "WX_PAGE",
    "payThird": "WE_CHAT",
    "channelTradeNo": "4200002961202601057839226483",
    "expireTime": "2026-01-04T16:49:38.000+00:00",
    "goodName": "充值 10 美元",
    "payStatus": "PAYED",
    "outTradeNo": "31767543578984",
    "notifyUrl": null,
    "totalNumber": 0.10,
    "createTime": "2026-01-04T16:19:39.000+00:00",
    "refundDesc": null,
    "thirdPayDataList": null
  }
}
```

> ⚠️ **重要提示**：
> - `totalNumber` 是 **number 类型**（如 `0.10`），不是字符串
> - 状态字段名是 `payStatus`，不是 `status`
> - 已支付状态值是 `PAYED`，不是 `SUCCESS`

---

## 退款接口

### 申请退款

**接口地址**
```
POST /api/v2/pay/refund/apply
```

**请求参数**

| 参数名 | 类型 | 必填 | 说明 |
|-------|------|------|------|
| tradeNo | string | 是 | CBB系统订单号 |
| refundAmount | string | 是 | 退款金额，不能超过订单金额 |
| outRequestNo | string | 是 | 退款请求号，需保证唯一性 |
| refundReason | string | 是 | 退款原因 |

**请求示例**
```json
{
  "tradeNo": "202508251430001234567890",
  "refundAmount": "50.00",
  "outRequestNo": "refund001",
  "refundReason": "用户申请退款"
}
```

**成功响应**
```json
{
  "success": true,
  "data": {
    "refundId": "rf202508251435001234567890",
    "tradeNo": "202508251430001234567890",
    "outRequestNo": "refund001",
    "refundAmount": "50.00",
    "status": "PROCESSING"
  },
  "requestId": "c8e10426-0dec-49be-8edd-703b81c6d553"
}
```

---

### 查询退款结果

**接口地址**
```
GET /api/v2/pay/refund/query/{tradeNo}/{outRequestNo}
```

**路径参数**

| 参数名 | 类型 | 必填 | 说明 |
|-------|------|------|------|
| tradeNo | string | 是 | CBB系统订单号 |
| outRequestNo | string | 是 | 退款请求号 |

**成功响应**
```json
{
  "success": true,
  "data": {
    "refundId": "rf202508251435001234567890",
    "tradeNo": "202508251430001234567890",
    "outRequestNo": "refund001",
    "refundAmount": "50.00",
    "status": "SUCCESS",
    "refundTime": "2025-08-25 14:40:00"
  },
  "requestId": "c8e10426-0dec-49be-8edd-703b81c6d553"
}
```

---

## 支付辅助接口

### 获取支付二维码

**接口地址**
```
GET /api/v2/pay/trade/qrCode/{payThird}/{tradeNo}
```

**路径参数**

| 参数名 | 类型 | 必填 | 说明 |
|-------|------|------|------|
| payThird | string | 是 | 第三方支付类型：WE_CHAT 或 ALIPAY |
| tradeNo | string | 是 | CBB系统订单号 |

**成功响应**
```json
{
  "success": true,
  "data": {
    "qrCodeUrl": "weixin://wxpay/bizpayurl?pr=ABC123",
    "tradeNo": "202508251430001234567890",
    "payThird": "WE_CHAT",
    "outTradeNo": "20250825001",
    "scanRemark": "请使用微信支付等常用支付APP扫码付款"
  },
  "requestId": "c8e10426-0dec-49be-8edd-703b81c6d553"
}
```

---

### 获取支付渠道列表

**接口地址**
```
GET /api/v2/pay/trade/channel/{environment}
```

**路径参数**

| 参数名 | 类型 | 必填 | 说明 |
|-------|------|------|------|
| environment | string | 是 | 支付环境 |

**支付环境枚举**

| 值 | 说明 |
|---|------|
| PC | 电脑端网站 |
| WAP | 手机端网站 |
| WE_CHAT_OFFICIAL | 微信公众号 |
| WE_CHAT_MINI_PROGRAM | 微信小程序 |
| APP | 手机APP |

**成功响应**
```json
{
  "success": true,
  "data": [
    {
      "clientId": "2004201503566462",
      "customerCode": "api",
      "channel": "WX_PAGE",
      "createTime": "2025-08-25 10:00:00"
    },
    {
      "clientId": "2004201503566462",
      "customerCode": "api",
      "channel": "ALIPAY_PAGE",
      "createTime": "2025-08-25 10:00:00"
    }
  ],
  "requestId": "c8e10426-0dec-49be-8edd-703b81c6d553"
}
```

---

### 获取微信小程序支付参数

**接口地址**
```
GET /api/v2/pay/trade/getWxMiniProgramParam/{tradeNo}/{openId}
```

**路径参数**

| 参数名 | 类型 | 必填 | 说明 |
|-------|------|------|------|
| tradeNo | string | 是 | CBB系统订单号 |
| openId | string | 是 | 用户在小程序中的openId |

**成功响应**
```json
{
  "success": true,
  "data": {
    "appId": "wx1234567890abcdef",
    "timeStamp": "1640966400",
    "nonceStr": "abc123def456",
    "package": "prepay_id=wx123456789012345",
    "signType": "MD5",
    "paySign": "A1B2C3D4E5F6"
  },
  "requestId": "c8e10426-0dec-49be-8edd-703b81c6d553"
}
```

**小程序端调用示例**
```javascript
wx.requestPayment({
  timeStamp: data.timeStamp,
  nonceStr: data.nonceStr,
  package: data.package,
  signType: data.signType,
  paySign: data.paySign,
  success: function(res) {
    console.log('支付成功', res);
  },
  fail: function(res) {
    console.log('支付失败', res);
  }
});
```

---

## 页面服务

### PC端支付页面

**页面地址**
```
/page/v2/pay/trade/pc/toPay
```

**参数**

| 参数名 | 类型 | 必填 | 说明 |
|-------|------|------|------|
| tradeNo | string | 是 | CBB系统订单号 |
| turnUrl | string | 否 | 支付成功跳转地址 |
| channelCode | string | 否 | 指定支付渠道 |
| showWhatyLogo | boolean | 否 | 是否显示网梯logo |
| nonceStr | string | 是 | 随机字符串 |
| timeStamp | string | 是 | 时间戳（毫秒） |
| charset | string | 是 | 字符集，固定 utf-8 |
| client_id | string | 是 | 客户端ID |
| sign | string | 是 | RSA签名 |

---

### 移动端H5支付页面

**页面地址**
```
/page/v2/pay/trade/wap/toPay
```

**参数**

| 参数名 | 类型 | 必填 | 说明 |
|-------|------|------|------|
| tradeNo | string | 是 | CBB系统订单号 |
| turnUrl | string | 否 | 支付成功跳转地址 |
| quitUrl | string | 否 | 取消支付跳转地址 |
| channelCode | string | 否 | 指定支付渠道 |
| nonceStr | string | 是 | 随机字符串 |
| timeStamp | string | 是 | 时间戳（毫秒） |
| charset | string | 是 | 字符集，固定 utf-8 |
| client_id | string | 是 | 客户端ID |
| sign | string | 是 | RSA签名 |

---

### 微信公众号支付页面

**页面地址**
```
/page/v2/pay/trade/wechat_official/toPay
```

**参数**

| 参数名 | 类型 | 必填 | 说明 |
|-------|------|------|------|
| tradeNo | string | 是 | CBB系统订单号 |
| openId | string | 是 | 用户在公众号中的openId |
| turnUrl | string | 否 | 支付成功跳转地址 |
| quitUrl | string | 否 | 取消支付跳转地址 |
| nonceStr | string | 是 | 随机字符串 |
| timeStamp | string | 是 | 时间戳（毫秒） |
| charset | string | 是 | 字符集，固定 utf-8 |
| client_id | string | 是 | 客户端ID |
| sign | string | 是 | RSA签名 |

---

## 异步回调

### 支付成功回调

支付成功后，CBB 会向配置的回调地址发送 POST 请求。

**回调数据格式**
```
Content-Type: application/x-www-form-urlencoded
```

**回调参数**

| 参数名 | 类型 | 说明 |
|-------|------|------|
| tradeNo | string | CBB系统订单号 |
| outTradeNo | string | 业务订单号 |
| status | string | 订单状态：SUCCESS |
| totalNumber | string | 订单金额 |
| payTime | string | 支付时间 |
| channel | string | 支付渠道 |
| payThird | string | 第三方支付类型 |
| businessParams | string | 业务参数（创建订单时传入） |
| sign | string | RSA签名 |

**处理要求**
- 验证签名
- 更新本地订单状态
- 返回 `SUCCESS` 表示处理成功
- 返回 `FAIL` 表示处理失败（CBB会重试）

---

### 退款回调

退款成功后，CBB 会向配置的回调地址发送 POST 请求。

**回调参数**

| 参数名 | 类型 | 说明 |
|-------|------|------|
| tradeNo | string | CBB系统订单号 |
| outTradeNo | string | 业务订单号 |
| outRequestNo | string | 退款请求号 |
| refundAmount | string | 退款金额 |
| status | string | 退款状态：SUCCESS |
| refundTime | string | 退款时间 |
| sign | string | RSA签名 |

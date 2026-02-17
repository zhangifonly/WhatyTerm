# WhatyTerm Subscription Server API 文档

## 基础信息

- **Base URL**: `https://term.whaty.org`
- **认证方式**: JWT Bearer Token
- **内容类型**: `application/json`

---

## 认证 API

### 用户注册

```http
POST /api/auth/register
```

**请求体**:
```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

**响应**:
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "name": "user"
  }
}
```

**说明**: 新用户注册后自动获得个人版永久免费许可证（3 台设备）。

---

### 用户登录

```http
POST /api/auth/login
```

**请求体**:
```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

**响应**:
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "name": "user"
  }
}
```

---

### 忘记密码

```http
POST /api/auth/forgot-password
```

**请求体**:
```json
{
  "email": "user@example.com"
}
```

**响应**:
```json
{
  "success": true,
  "message": "如果该邮箱已注册，您将收到密码重置链接"
}
```

---

### 重置密码

```http
POST /api/auth/reset-password
```

**请求体**:
```json
{
  "token": "reset-token-from-email",
  "newPassword": "newpassword123"
}
```

**响应**:
```json
{
  "success": true,
  "message": "密码重置成功"
}
```

---

### 验证重置令牌

```http
GET /api/auth/verify-reset-token?token=xxx
```

**响应**:
```json
{
  "valid": true,
  "email": "us***@example.com"
}
```

---

### 验证用户凭据（客户端远程访问用）

```http
POST /api/auth/verify-credentials
```

**请求体**:
```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

**响应**:
```json
{
  "success": true,
  "user": {
    "id": "uuid",
    "email": "user@example.com"
  },
  "license": {
    "key": "WT-XXXXXXXX",
    "plan": "personal",
    "expiresAt": 1735689600,
    "maxDevices": 3
  }
}
```

---

## 订阅计划 API

### 获取订阅计划列表

```http
GET /api/plans
```

**响应**:
```json
[
  {
    "id": "personal",
    "name": "个人版",
    "description": "开源免费，适合个人开发者",
    "price_monthly": 0,
    "price_yearly": 0,
    "max_devices": 3,
    "features": ["all-plugins", "community-support", "open-source"]
  },
  {
    "id": "enterprise",
    "name": "企业版",
    "description": "适合企业团队，每人每月 29 元",
    "price_monthly": 2900,
    "price_yearly": 29000,
    "max_devices": 999,
    "features": ["all-plugins", "relay-server", "dedicated-support", "custom-features", "sla"]
  }
]
```

---

## 支付 API

### 获取可用支付方式

```http
GET /api/payment/methods
```

**响应**:
```json
[
  {
    "id": "cbb_alipay",
    "name": "支付宝",
    "icon": "alipay"
  },
  {
    "id": "cbb_wechat",
    "name": "微信支付",
    "icon": "wechat"
  }
]
```

---

### 创建支付订单

```http
POST /api/payment/create
```

**请求体**:
```json
{
  "planId": "enterprise",
  "period": "yearly",
  "paymentMethod": "cbb_alipay",
  "email": "user@example.com",
  "machineId": "optional-machine-id"
}
```

**注意**: 免费计划（个人版）无需支付，传入免费计划会返回 400 错误。

**响应（CBB 支付）**:
```json
{
  "success": true,
  "orderNo": "WT20260201120000XXXX",
  "payUrl": "https://api.webtrn.cn/pay/...",
  "expireMinutes": 30
}
```

**响应（直连支付）**:
```json
{
  "success": true,
  "orderNo": "WT20260201120000XXXX",
  "qrCodeImage": "data:image/png;base64,...",
  "expireMinutes": 30
}
```

---

### 查询订单状态

```http
GET /api/payment/status/:orderNo
```

**响应（待支付）**:
```json
{
  "success": true,
  "status": "pending",
  "order": {
    "orderNo": "WT20260201120000XXXX",
    "amount": 29900,
    "planName": "个人版"
  }
}
```

**响应（已支付）**:
```json
{
  "success": true,
  "status": "paid",
  "order": {
    "orderNo": "WT20260201120000XXXX",
    "amount": 29900,
    "planName": "个人版",
    "paidAt": 1706745600
  },
  "license": {
    "key": "WT-XXXXXXXX",
    "expiresAt": "2027-02-01T00:00:00.000Z"
  }
}
```

---

### 取消订单

```http
POST /api/payment/cancel/:orderNo
```

**响应**:
```json
{
  "success": true,
  "message": "订单已取消"
}
```

---

## 许可证 API

### 激活许可证

```http
POST /api/license/activate
```

**请求体**:
```json
{
  "email": "user@example.com",
  "password": "password123",
  "machineId": "unique-machine-id",
  "hostname": "MacBook-Pro",
  "platform": "darwin",
  "arch": "arm64"
}
```

**响应**:
```json
{
  "success": true,
  "license": {
    "key": "WT-XXXXXXXX",
    "plan": "personal",
    "planName": "个人版",
    "expiresAt": 1735689600,
    "maxDevices": 3,
    "currentDevices": 1
  }
}
```

---

### 验证许可证

```http
POST /api/license/verify
```

**请求体**:
```json
{
  "licenseKey": "WT-XXXXXXXX",
  "machineId": "unique-machine-id"
}
```

**响应**:
```json
{
  "valid": true,
  "license": {
    "plan": "personal",
    "planName": "个人版",
    "expiresAt": 1735689600,
    "features": ["all-plugins", "email-support"]
  }
}
```

---

### 停用许可证（解绑设备）

```http
POST /api/license/deactivate
```

**请求体**:
```json
{
  "licenseKey": "WT-XXXXXXXX",
  "machineId": "unique-machine-id"
}
```

**响应**:
```json
{
  "success": true,
  "message": "设备已解绑"
}
```

---

## 用户中心 API

> 以下 API 需要在请求头中携带 JWT Token:
> `Authorization: Bearer <token>`

### 获取用户许可证列表

```http
GET /api/user/licenses
```

**响应**:
```json
[
  {
    "id": "uuid",
    "license_key": "WT-XXXXXXXX",
    "plan_id": "personal",
    "plan_name": "个人版",
    "expires_at": 1735689600,
    "max_devices": 3,
    "status": "active",
    "activations": [
      {
        "machine_id": "xxx",
        "hostname": "MacBook-Pro",
        "platform": "darwin",
        "arch": "arm64"
      }
    ]
  }
]
```

---

### 获取用户设备列表

```http
GET /api/user/devices
```

**响应**:
```json
[
  {
    "id": "uuid",
    "machine_id": "unique-machine-id",
    "hostname": "MacBook-Pro",
    "platform": "darwin",
    "arch": "arm64",
    "activated_at": 1706745600,
    "last_seen_at": 1706832000,
    "is_active": 1
  }
]
```

---

### 解绑设备

```http
POST /api/user/devices/:deviceId/deactivate
```

**响应**:
```json
{
  "success": true,
  "message": "设备已解绑"
}
```

---

### 兑换激活码

```http
POST /api/user/redeem
```

**请求体**:
```json
{
  "code": "WT-XXXXXXXX"
}
```

**响应**:
```json
{
  "success": true,
  "license": {
    "key": "WT-YYYYYYYY",
    "plan": "personal",
    "expires_at": 1735689600
  }
}
```

---

## 管理后台 API

> 以下 API 需要在请求头中携带管理员密钥:
> `X-Admin-Key: <admin-key>`

### 获取统计信息

```http
GET /api/admin/stats
```

**响应**:
```json
{
  "users": {
    "total": 1000,
    "today": 10
  },
  "orders": {
    "total": 500,
    "paid": 450,
    "pending": 30,
    "todayRevenue": 29900
  },
  "licenses": {
    "total": 450,
    "active": 400,
    "expired": 50
  },
  "devices": {
    "total": 380,
    "active": 350
  }
}
```

---

### 订单管理

```http
GET /api/admin/orders?page=1&limit=20&status=paid
```

**查询参数**:
- `page`: 页码（默认 1）
- `limit`: 每页数量（默认 20）
- `status`: 订单状态（pending/paid/expired/cancelled）

---

### 用户管理

```http
GET /api/admin/users?page=1&limit=20&search=keyword
```

**查询参数**:
- `page`: 页码
- `limit`: 每页数量
- `search`: 搜索关键词（邮箱）

---

### 许可证管理

```http
GET /api/admin/licenses?page=1&limit=20&status=active
```

**查询参数**:
- `page`: 页码
- `limit`: 每页数量
- `status`: 许可证状态（active/expired/disabled）

---

### 许可证延期

```http
POST /api/admin/licenses/:id/extend
```

**请求体**:
```json
{
  "days": 30
}
```

---

### 生成激活码

```http
POST /api/admin/codes/generate
```

**请求体**:
```json
{
  "planId": "personal",
  "durationDays": 365,
  "count": 10,
  "prefix": "PROMO"
}
```

**响应**:
```json
{
  "success": true,
  "codes": [
    "PROMO-XXXXXXXX",
    "PROMO-YYYYYYYY"
  ]
}
```

---

## 支付回调 API

### 支付宝异步通知

```http
POST /api/payment/alipay/notify
Content-Type: application/x-www-form-urlencoded
```

### 微信支付异步通知

```http
POST /api/payment/wechat/notify
Content-Type: application/json
```

### CBB 聚合支付异步通知

```http
POST /api/payment/cbb/notify
Content-Type: application/json
```

---

## 错误响应

所有 API 在发生错误时返回以下格式：

```json
{
  "error": "错误描述信息"
}
```

**常见 HTTP 状态码**:
- `400`: 请求参数错误
- `401`: 未授权（未登录或 Token 无效）
- `403`: 禁止访问（权限不足）
- `404`: 资源不存在
- `429`: 请求过于频繁
- `500`: 服务器内部错误

---

## 速率限制

- 普通 API: 100 次/分钟
- 认证 API: 10 次/分钟
- 支付 API: 30 次/分钟

超出限制时返回 `429 Too Many Requests`。

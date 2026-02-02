---
name: cbb-pay-integration
description: CBB聚合支付服务HTTP对接助手。**默认使用页面服务方式**（跳转到CBB聚合支付页面），简单统一。当用户需要对接CBB支付服务、实现支付功能、处理支付回调时使用此skill。支持创建订单、页面服务签名、回调验签、查询订单、申请退款等完整支付流程。
---

# CBB 聚合支付服务对接助手

## 概述

此 skill 提供 CBB 聚合支付服务的完整 HTTP 对接指导。

**默认集成方式：页面服务（跳转到 CBB 支付页面）**，这是最简单、最统一的方式。

## 使用场景

- 对接 CBB 支付服务（默认使用页面服务方式）
- 集成支付页面（PC/H5/微信公众号）
- 处理支付成功回调通知
- 实现退款功能
- 特殊场景：自定义二维码界面、小程序支付（需用户明确要求）

## 前置配置

对接前需要获取以下配置信息（向用户询问或使用占位符）：

| 配置项 | 说明 | 示例 |
|-------|------|------|
| CBB_GATEWAY_URL | 网关地址 | https://api.webtrn.cn |
| CBB_CLIENT_ID | 应用客户端ID | 2004201503566462 |
| CBB_CLIENT_SECRET | 应用客户端密钥 | xxxxxx |
| CBB_CUSTOMER_CODE | 客户编号 | api |
| CBB_PRIVATE_KEY | RSA私钥（页面签名用） | MIIEvgIBADANBg... |
| CBB_PUBLIC_KEY | RSA公钥（回调验签用） | MIIBIjANBgkqhk... |

## 对接工作流程

### 1. 确认集成方式

**默认使用页面服务方式，无需询问用户。** 仅在以下情况询问用户：

| 用户表述 | 处理方式 |
|---------|---------|
| "实现支付功能"、"对接支付" | 直接使用页面服务方式 |
| "显示二维码"、"扫码支付"、"自定义支付界面" | 询问是否需要 API 方式 |
| "小程序支付" | 使用小程序支付参数 API |
| 明确指定方式 | 按用户要求 |

**两种集成方式对比：**

| 方式 | 说明 | 适用场景 | 推荐度 |
|-----|------|---------|-------|
| **页面服务** | 跳转到 CBB 聚合支付页面 | PC网站、H5网站、微信公众号 | ⭐⭐⭐ 默认推荐 |
| API 直接调用 | 获取二维码/支付参数，自行渲染 | 自定义界面、小程序 | 特殊场景使用 |

### 2. 收集配置信息

询问用户是否已有配置信息。如果没有，说明需要联系CBB管理员获取。

### 3. 生成对接代码

根据用户的技术栈（Java/Python/Node.js/Go等）生成相应代码。

**页面服务方式的标准流程：**
1. 创建订单 → 获取 tradeNo
2. 构造签名参数 → RSA 签名
3. 拼接支付页面 URL
4. 跳转到 CBB 支付页面
5. 用户完成支付
6. 处理异步回调通知

## 核心接口

### 认证接口

获取 access_token（有效期12小时）：

```http
POST /auth/v2/security/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&client_id={client_id}&client_secret={client_secret}
```

### API 调用规范

所有业务接口需携带请求头：
```http
Authorization: Bearer {access_token}
x-cbb-client-customer: {customer_code}
x-cbb-client-type: api
Content-Type: application/json
```

### 主要接口

**核心接口（页面服务方式必需）：**

| 接口 | 方法 | 路径 | 说明 |
|-----|------|------|------|
| 创建订单 | POST | /api/v2/pay/trade | 创建支付订单 |
| 查询订单 | GET | /api/v2/pay/trade/{tradeNo} | 根据订单号查询 |
| 业务订单查询 | POST | /api/v2/pay/trade/outTradeNo | 根据业务订单号查询 |
| 申请退款 | POST | /api/v2/pay/refund/apply | 申请退款 |
| 查询退款 | GET | /api/v2/pay/refund/query/{tradeNo}/{outRequestNo} | 查询退款结果 |

**特殊场景接口（仅在用户明确要求时使用）：**

| 接口 | 方法 | 路径 | 说明 |
|-----|------|------|------|
| 获取二维码 | GET | /api/v2/pay/trade/qrCode/{payThird}/{tradeNo} | 自定义扫码界面时使用 |
| 支付渠道 | GET | /api/v2/pay/trade/channel/{environment} | 获取可用支付渠道 |
| 小程序参数 | GET | /api/v2/pay/trade/getWxMiniProgramParam/{tradeNo}/{openId} | 小程序支付时使用 |

详细接口文档参见 `references/api-reference.md`。

## 页面服务签名（默认推荐方式）

**这是默认的支付集成方式。** 页面服务使用 RSA SHA256WithRSA 签名机制。

### 页面地址

| 场景 | 页面地址 |
|-----|---------|
| PC 端 | `/page/v2/pay/trade/pc/toPay` |
| 移动端 H5 | `/page/v2/pay/trade/wap/toPay` |
| 微信公众号 | `/page/v2/pay/trade/wechat_official/toPay` |

### 签名步骤

1. 构造签名参数（nonceStr, timeStamp, charset, client_id, tradeNo等）
2. 按 key 字母序排序
3. 拼接成 `key1=value1&key2=value2` 格式
4. 使用私钥进行 SHA256WithRSA 签名
5. Base64 编码签名结果
6. URL 双重编码所有参数值和签名

签名工具脚本参见 `scripts/rsa_utils.py`。

## 回调验签

支付成功后 CBB 会发送回调通知。验签步骤：

1. 从参数中取出 sign 字段
2. 剩余参数按 key 字母序排序
3. 拼接成 `key1=value1&key2=value2` 格式
4. 使用公钥验证签名

处理成功返回 `SUCCESS`，失败返回 `FAIL`。

## ⚠️ 常见陷阱（重要）

在对接 CBB 支付 API 时，以下是经过实际验证的常见问题，请务必注意：

### 1. 请求头缺失

**问题**：调用业务接口返回 `errorCode: 2003, errorMsg: "parameter illegal"`

**原因**：缺少必需的请求头。所有业务接口必须携带**全部 4 个**请求头：

```http
Authorization: Bearer {access_token}
x-cbb-client-customer: {customer_code}
x-cbb-client-type: api
Content-Type: application/json
```

**解决**：确保每个业务接口调用都包含完整的请求头。

### 2. 响应字段类型不一致

**问题**：JSON 反序列化失败，提示类型不匹配

**原因**：`totalNumber` 字段在**请求时是字符串**，但**响应时是数字类型**。

| 场景 | 类型 | 示例 |
|------|------|------|
| 创建订单请求 | string | `"totalNumber": "100.01"` |
| 查询订单响应 | **number** | `"totalNumber": 100.01` |

**解决**：在定义响应结构体时，`totalNumber` 使用 `float64`（Go）或 `number`（JS/TS）类型。

### 3. 状态字段名差异

**问题**：解析响应后状态字段为空

**原因**：订单状态字段名在不同场景下不同：

| 场景 | 字段名 |
|------|--------|
| 创建订单响应 | `status` |
| 查询订单响应 | `payStatus` |

**解决**：根据接口类型使用正确的字段名。

### 4. 状态值差异

**问题**：状态判断逻辑不生效

**原因**：实际 API 返回的状态值与部分旧文档描述不同：

| 状态 | 旧文档值 | 实际值 |
|------|---------|--------|
| 待支付 | `WAIT_PAY` | `WAIT_TO_PAY` |
| 已支付 | `SUCCESS` | `PAYED` |
| 已关闭 | `CLOSED` | `CLOSED` |

**解决**：使用实际的状态值进行判断。

### 5. 代码示例（Go 语言）

```go
// ✅ 正确的响应结构体定义
type CBBQueryOrderResponse struct {
    Success bool   `json:"success"`
    Message string `json:"message"`
    Data    struct {
        TradeNo     string  `json:"tradeNo"`
        OutTradeNo  string  `json:"outTradeNo"`
        TotalNumber float64 `json:"totalNumber"` // 数字类型
        Status      string  `json:"payStatus"`   // 字段名是 payStatus
        PayTime     string  `json:"payTime"`
    } `json:"data"`
}

// ✅ 正确的状态判断
if queryResp.Data.Status == "PAYED" {  // 不是 "SUCCESS"
    // 处理已支付逻辑
}
```

## 错误处理

常见错误码参见 `references/error-codes.md`。

## 代码模板

生成代码时参考 `assets/` 目录下的模板文件：
- `assets/python_template.py` - Python 客户端模板
- `assets/nodejs_template.js` - Node.js 客户端模板
- `assets/java_template.java` - Java 客户端模板

## 测试建议

1. 使用小金额（0.01元）测试
2. 确保回调地址可被外网访问
3. 测试完整流程：创建订单 → 支付 → 回调 → 查询
4. 测试退款流程
5. **验证响应解析**：在正式对接前，先用工具（如 Postman/curl）调用 API，确认实际响应结构

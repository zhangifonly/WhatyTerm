# CBB 支付服务错误码参考

## 通用错误码

### 认证相关

| 错误码 | 错误信息 | 说明 | 解决方案 |
|-------|---------|------|---------|
| 1000 | Token illegal | 令牌非法或已过期 | 重新获取 access_token |
| 1001 | Unauthorized | 未授权访问 | 检查 Authorization 请求头 |
| 1002 | Invalid client | 客户端认证失败 | 检查 client_id 和 client_secret |

### 参数相关

| 错误码 | 错误信息 | 说明 | 解决方案 |
|-------|---------|------|---------|
| 2001 | Missing required parameter | 缺少必需参数 | 检查请求参数完整性 |
| 2002 | Invalid parameter format | 参数格式错误 | 检查参数格式是否符合要求 |
| 2003 | Parameter value out of range | 参数值超出范围 | 检查参数值是否在有效范围内 |

### 系统相关

| 错误码 | 错误信息 | 说明 | 解决方案 |
|-------|---------|------|---------|
| 5001 | Internal server error | 服务器内部错误 | 联系技术支持 |
| 5002 | Service unavailable | 服务暂时不可用 | 稍后重试 |
| 5003 | Request timeout | 请求超时 | 检查网络或稍后重试 |

---

## 支付服务专用错误码

### 订单相关

| 错误码 | 错误信息 | 说明 | 解决方案 |
|-------|---------|------|---------|
| 1001 | Third party call error | 第三方调用错误 | 检查支付配置是否正确 |
| 1002 | Trade not found | 订单不存在 | 确认订单号是否正确 |
| 1003 | Trade has been payed | 订单已支付 | 不能重复支付已支付订单 |
| 1004 | No permission to operate trade | 没有订单操作权限 | 确认 customer 参数是否正确 |
| 1005 | Different params for same outTradeNo | 同一个outTradeNo传入了不同的参数 | 保证相同业务订单号的参数一致性 |
| 1006 | Merchant id not found | 商户id未找到 | 检查支付渠道配置 |

### 退款相关

| 错误码 | 错误信息 | 说明 | 解决方案 |
|-------|---------|------|---------|
| 1007 | Trade not paid when refund | 退款时订单还没有支付成功 | 只能对已支付订单申请退款 |
| 1008 | Channel not support refund | 订单支付的渠道当前暂不支持退款 | 更换支持退款的支付渠道 |
| 1011 | Refund amount exceeds | 累计退款余额超过订单支付金额 | 检查退款金额是否超限 |
| 1012 | Refund record not found | 没有找到指定的退款记录 | 确认退款请求号是否正确 |

---

## HTTP 状态码

| 状态码 | 说明 | 处理方式 |
|-------|------|---------|
| 200 | 请求成功 | 正常处理响应数据 |
| 400 | 请求参数错误 | 检查请求参数 |
| 401 | 认证失败或令牌过期 | 重新获取 access_token |
| 403 | 权限不足 | 检查客户端权限配置 |
| 404 | 资源不存在 | 检查请求路径 |
| 429 | 请求过于频繁 | 降低请求频率 |
| 500 | 服务器内部错误 | 联系技术支持 |

---

## 错误处理最佳实践

### 1. Token 过期处理

```python
def call_api_with_retry(self, method, url, **kwargs):
    try:
        response = self._call_api(method, url, **kwargs)
        return response
    except Exception as e:
        if self._is_token_expired(e):
            self.refresh_token()
            return self._call_api(method, url, **kwargs)
        raise
```

### 2. 重试机制

```python
import time

def call_with_retry(func, max_retries=3, backoff_factor=2):
    for i in range(max_retries):
        try:
            return func()
        except Exception as e:
            if i == max_retries - 1:
                raise
            wait_time = backoff_factor ** i
            time.sleep(wait_time)
```

### 3. 错误日志记录

建议记录以下信息用于问题排查：
- requestId（响应中的唯一标识）
- 请求 URL 和参数
- 响应状态码和内容
- 错误码和错误信息
- 请求时间戳

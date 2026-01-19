# API 集成 - 认证配置阶段

## 阶段目标
配置安全的认证机制。

## 认证方式

### API Key
```javascript
// 请求头
headers: {
  'X-API-Key': 'your-api-key'
}
```

### Bearer Token (JWT)
```javascript
// 请求头
headers: {
  'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIs...'
}

// JWT 结构
// Header.Payload.Signature
```

### OAuth 2.0
```
1. 获取授权码
2. 用授权码换取 access_token
3. 使用 access_token 访问 API
4. 使用 refresh_token 刷新
```

## 安全配置

### 密钥管理
```javascript
// 使用环境变量
const apiKey = process.env.API_KEY;

// 不要硬编码
// const apiKey = 'sk-xxx';  // 错误！
```

### HTTPS
- 始终使用 HTTPS
- 验证 SSL 证书
- 使用 TLS 1.2+

### 速率限制
```javascript
// 响应头
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 99
X-RateLimit-Reset: 1640000000
```

## 配置清单

- [ ] 认证方式是否安全
- [ ] 密钥是否妥善保管
- [ ] 权限控制是否合理

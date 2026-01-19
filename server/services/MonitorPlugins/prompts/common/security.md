# 安全检查指南

## OWASP Top 10 防护

### 1. 注入攻击 (Injection)

#### SQL 注入
```javascript
// 危险：字符串拼接
const query = `SELECT * FROM users WHERE id = ${userId}`;

// 安全：参数化查询
const query = 'SELECT * FROM users WHERE id = ?';
db.query(query, [userId]);

// 安全：ORM
const user = await User.findById(userId);
```

#### 命令注入
```javascript
// 危险：直接拼接用户输入
exec(`ls ${userInput}`);

// 安全：使用参数数组
execFile('ls', [userInput]);

// 安全：白名单验证
const allowedCommands = ['list', 'status'];
if (!allowedCommands.includes(command)) {
  throw new Error('Invalid command');
}
```

### 2. 跨站脚本 (XSS)

#### 防护措施
```javascript
// 危险：直接插入 HTML
element.innerHTML = userInput;

// 安全：使用 textContent
element.textContent = userInput;

// 安全：转义 HTML
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// React 自动转义（安全）
<div>{userInput}</div>

// React 危险操作（需要审查）
<div dangerouslySetInnerHTML={{__html: sanitizedHtml}} />
```

#### CSP 配置
```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'
```

### 3. 身份认证漏洞

#### 密码安全
```javascript
// 使用 bcrypt 哈希密码
const bcrypt = require('bcrypt');
const saltRounds = 12;

// 存储密码
const hash = await bcrypt.hash(password, saltRounds);

// 验证密码
const match = await bcrypt.compare(password, hash);
```

#### 会话管理
- 使用安全的随机 token
- 设置合理的过期时间
- 登出时销毁会话
- 敏感操作要求重新认证

### 4. 敏感数据泄露

#### 禁止硬编码
```javascript
// 危险：硬编码密钥
const apiKey = 'sk-1234567890abcdef';

// 安全：环境变量
const apiKey = process.env.API_KEY;

// 安全：配置文件（不提交到 git）
const config = require('./config.local.json');
```

#### 日志脱敏
```javascript
// 危险：记录敏感信息
console.log('User login:', { email, password });

// 安全：脱敏处理
console.log('User login:', { email, password: '***' });

// 安全：只记录必要信息
console.log('User login:', { userId, timestamp });
```

### 5. 访问控制

#### 权限检查
```javascript
// 每个 API 都要检查权限
app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  // ...
});

// 检查资源所有权
app.get('/api/orders/:id', requireAuth, async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (order.userId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  // ...
});
```

### 6. 安全配置

#### HTTP 安全头
```javascript
// 使用 helmet 中间件
const helmet = require('helmet');
app.use(helmet());

// 或手动设置
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});
```

### 7. 依赖安全

```bash
# 检查依赖漏洞
npm audit

# 自动修复
npm audit fix

# 使用 Snyk 扫描
npx snyk test
```

## 输入验证清单

| 输入类型 | 验证方法 |
|---------|---------|
| 邮箱 | 正则验证 + 长度限制 |
| 密码 | 长度 + 复杂度要求 |
| 数字 | 范围检查 + 类型转换 |
| 文件 | 类型 + 大小 + 内容检查 |
| URL | 协议白名单 + 域名验证 |
| JSON | Schema 验证 |

## 安全检查清单

- [ ] 所有用户输入都经过验证和转义
- [ ] 敏感信息未硬编码在代码中
- [ ] 密码使用强哈希算法存储
- [ ] API 有适当的认证和授权
- [ ] 使用 HTTPS 传输敏感数据
- [ ] 设置了安全的 HTTP 头
- [ ] 定期更新依赖包
- [ ] 日志不包含敏感信息
- [ ] 错误信息不泄露系统细节
- [ ] 文件上传有类型和大小限制

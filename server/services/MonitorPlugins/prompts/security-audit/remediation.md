# 安全审计 - 修复建议阶段

## 阶段目标
提供可行的修复方案。

## 修复优先级

| 优先级 | 风险等级 | 修复时间 |
|--------|----------|----------|
| P0 | Critical | 立即 |
| P1 | High | 24小时内 |
| P2 | Medium | 1周内 |
| P3 | Low | 下个版本 |

## 常见漏洞修复

### SQL 注入
```javascript
// 错误
const query = `SELECT * FROM users WHERE id = ${id}`;

// 正确 - 参数化查询
const query = 'SELECT * FROM users WHERE id = ?';
db.query(query, [id]);
```

### XSS
```javascript
// 错误
element.innerHTML = userInput;

// 正确 - 转义
element.textContent = userInput;
// 或使用 DOMPurify
element.innerHTML = DOMPurify.sanitize(userInput);
```

### CSRF
```html
<!-- 添加 CSRF Token -->
<form>
  <input type="hidden" name="_csrf" value="{{csrfToken}}">
</form>
```

### 命令注入
```javascript
// 错误
exec(`ls ${userInput}`);

// 正确 - 使用数组参数
execFile('ls', [userInput]);
```

## 临时缓解措施

| 漏洞 | 临时措施 |
|------|----------|
| SQL 注入 | WAF 规则 |
| XSS | CSP 头 |
| 暴力破解 | 速率限制 |
| 敏感信息泄露 | 访问控制 |

## 修复清单

- [ ] 修复建议是否可行
- [ ] 是否有临时缓解措施
- [ ] 是否验证了修复效果

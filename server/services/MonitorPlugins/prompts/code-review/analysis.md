# 代码审查 - 代码分析阶段

## 阶段目标
深入分析代码变更，识别潜在问题和改进点。

## 分析维度

### 1. 功能正确性
- 代码是否实现了预期功能
- 边界情况是否处理
- 错误处理是否完善

```javascript
// 检查点：边界情况
function getUser(id) {
  // ✅ 好：处理了无效输入
  if (!id || typeof id !== 'number') {
    throw new Error('Invalid user ID');
  }
  return users.find(u => u.id === id);
}

// ❌ 差：未处理边界情况
function getUser(id) {
  return users.find(u => u.id === id);
}
```

### 2. 代码质量

#### 命名规范
```javascript
// ✅ 好：清晰的命名
const isUserActive = user.status === 'active';
const getUserById = (id) => { ... };

// ❌ 差：模糊的命名
const flag = user.status === 'active';
const get = (id) => { ... };
```

#### 函数设计
```javascript
// ✅ 好：单一职责
function validateEmail(email) { ... }
function sendEmail(to, subject, body) { ... }

// ❌ 差：职责混乱
function processEmail(email, subject, body, validate) {
  if (validate) { ... }
  // 发送逻辑
}
```

### 3. 安全检查

| 检查项 | 说明 |
|-------|------|
| 输入验证 | 用户输入是否验证和转义 |
| SQL 注入 | 是否使用参数化查询 |
| XSS | 是否正确转义输出 |
| 认证授权 | 是否检查用户权限 |
| 敏感数据 | 是否有硬编码的密钥 |

### 4. 性能考虑

```javascript
// ✅ 好：避免 N+1 查询
const users = await User.findAll({
  include: [{ model: Order }]
});

// ❌ 差：N+1 查询
const users = await User.findAll();
for (const user of users) {
  user.orders = await Order.findAll({ where: { userId: user.id } });
}
```

### 5. 可维护性

- 代码是否易于理解
- 是否有适当的注释
- 是否遵循项目规范
- 是否有重复代码

## 常见问题模式

| 问题 | 示例 | 建议 |
|------|------|------|
| 魔法数字 | `if (status === 1)` | 使用常量 |
| 深层嵌套 | 4+ 层 if/for | 提前返回 |
| 过长函数 | 100+ 行 | 拆分函数 |
| 重复代码 | 复制粘贴 | 提取公共函数 |

## 检查清单

- [ ] 功能实现是否正确
- [ ] 边界情况是否处理
- [ ] 命名是否清晰
- [ ] 是否有安全问题
- [ ] 是否有性能问题
- [ ] 代码是否易于维护

{{include:common/code-quality}}

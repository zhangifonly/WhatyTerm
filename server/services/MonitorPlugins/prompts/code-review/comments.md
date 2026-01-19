# 代码审查 - 评论反馈阶段

## 阶段目标
提供建设性的审查意见，帮助作者改进代码。

## 评论原则

### 1. 建设性
```markdown
# ✅ 好的评论
这里可以考虑使用 `Array.find()` 代替 `filter()[0]`，
性能更好且语义更清晰。

# ❌ 差的评论
这代码写得不好。
```

### 2. 具体明确
```markdown
# ✅ 好的评论
建议将这个函数拆分为两个：
1. `validateInput()` - 负责输入验证
2. `processData()` - 负责数据处理
这样更符合单一职责原则。

# ❌ 差的评论
这个函数太长了。
```

### 3. 区分严重程度

| 标签 | 含义 | 示例 |
|------|------|------|
| `[必须]` | 必须修改 | 安全漏洞、严重 bug |
| `[建议]` | 建议修改 | 代码质量改进 |
| `[讨论]` | 需要讨论 | 设计决策 |
| `[提问]` | 需要解释 | 不理解的逻辑 |
| `[赞]` | 值得学习 | 好的实现 |

## 评论模板

### 问题反馈
```markdown
**[必须]** 安全问题：SQL 注入风险

当前代码：
```javascript
const query = `SELECT * FROM users WHERE id = ${userId}`;
```

建议修改为：
```javascript
const query = 'SELECT * FROM users WHERE id = ?';
db.query(query, [userId]);
```

原因：直接拼接用户输入可能导致 SQL 注入攻击。
```

### 改进建议
```markdown
**[建议]** 可以简化这段代码

当前：
```javascript
if (user !== null && user !== undefined) {
  return user.name;
}
return 'Unknown';
```

建议：
```javascript
return user?.name ?? 'Unknown';
```
```

### 提问
```markdown
**[提问]** 这里为什么要延迟 100ms？

```javascript
setTimeout(() => {
  doSomething();
}, 100);
```

是为了等待某个异步操作完成吗？如果是，建议使用 Promise 或事件机制。
```

### 赞扬
```markdown
**[赞]** 这个错误处理写得很好！

考虑了多种错误情况，并提供了有意义的错误信息，
方便调试和用户理解。
```

## 评论位置

- **行内评论**：针对具体代码行
- **文件评论**：针对整个文件的问题
- **总体评论**：PR 级别的反馈

## 检查清单

- [ ] 评论是否建设性
- [ ] 是否提供了具体的改进建议
- [ ] 是否标注了严重程度
- [ ] 是否有正面反馈

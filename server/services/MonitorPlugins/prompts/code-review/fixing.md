# 代码审查 - 问题修复阶段

## 阶段目标
跟踪审查意见的修复情况，确保所有问题都得到解决。

## 修复跟踪

### 问题状态
| 状态 | 说明 |
|------|------|
| 待处理 | 等待作者修复 |
| 已修复 | 作者已提交修复 |
| 已验证 | 审查者确认修复 |
| 不修复 | 经讨论决定不修复 |

### 跟踪模板
```markdown
## 审查问题跟踪

| # | 问题 | 严重程度 | 状态 | 备注 |
|---|------|---------|------|------|
| 1 | SQL 注入风险 | 必须 | 已验证 | commit abc123 |
| 2 | 函数过长 | 建议 | 已修复 | 待验证 |
| 3 | 缺少测试 | 建议 | 待处理 | |
| 4 | 命名不清晰 | 建议 | 不修复 | 经讨论保留 |
```

## 验证修复

### 验证步骤
1. 查看修复的 commit
2. 确认修复是否正确
3. 检查是否引入新问题
4. 运行相关测试

### 验证命令
```bash
# 查看最新提交
git log -1 --stat

# 查看具体修改
git show HEAD

# 运行测试
npm test

# 检查代码风格
npm run lint
```

## 常见修复模式

### 安全问题修复
```javascript
// 修复前：SQL 注入
const query = `SELECT * FROM users WHERE id = ${id}`;

// 修复后：参数化查询
const query = 'SELECT * FROM users WHERE id = ?';
db.query(query, [id]);
```

### 性能问题修复
```javascript
// 修复前：N+1 查询
for (const user of users) {
  user.orders = await getOrders(user.id);
}

// 修复后：批量查询
const userIds = users.map(u => u.id);
const orders = await getOrdersByUserIds(userIds);
users.forEach(u => {
  u.orders = orders.filter(o => o.userId === u.id);
});
```

### 代码质量修复
```javascript
// 修复前：魔法数字
if (status === 1) { ... }

// 修复后：使用常量
const STATUS_ACTIVE = 1;
if (status === STATUS_ACTIVE) { ... }
```

## 审查完成标准

### 必须满足
- [ ] 所有"必须"级别问题已修复
- [ ] 安全问题已解决
- [ ] 测试通过

### 建议满足
- [ ] "建议"级别问题已处理（修复或说明原因）
- [ ] 代码风格检查通过
- [ ] 文档已更新

## 审查结论

| 结论 | 说明 |
|------|------|
| 批准 | 代码可以合并 |
| 需要修改 | 有问题需要修复 |
| 拒绝 | 需要重新设计 |

### 批准模板
```markdown
## 审查结论：批准 ✅

### 审查内容
- 代码变更：+150 / -30 行
- 涉及文件：5 个
- 测试覆盖：85%

### 审查意见
1. 功能实现正确
2. 代码质量良好
3. 测试覆盖充分

### 建议（非阻塞）
- 考虑添加更多边界测试
- 可以优化 XXX 函数的性能

LGTM! 可以合并。
```

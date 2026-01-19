# Bug 修复 - 预防措施阶段

## 阶段目标
防止类似问题再次发生，总结经验教训，提升代码质量。

## 预防措施清单

### 1. 添加自动化测试

针对修复的 bug 添加测试用例，确保问题不会复发：

```javascript
// 单元测试示例
describe('UserService', () => {
  describe('getUserName', () => {
    it('should return user name when user exists', async () => {
      const user = { id: 1, name: 'John' };
      mockFetchUser.mockResolvedValue(user);

      const result = await getUserName(1);

      expect(result).toBe('John');
    });

    it('should throw error when user not found', async () => {
      mockFetchUser.mockResolvedValue(null);

      await expect(getUserName(999)).rejects.toThrow('User not found');
    });

    it('should handle network timeout', async () => {
      mockFetchUser.mockRejectedValue(new Error('Timeout'));

      await expect(getUserName(1)).rejects.toThrow('Timeout');
    });
  });
});
```

### 2. 添加代码检查规则

```javascript
// .eslintrc.js
module.exports = {
  rules: {
    // 禁止未使用的变量
    'no-unused-vars': 'error',

    // 要求使用 === 和 !==
    'eqeqeq': 'error',

    // 禁止使用 any 类型（TypeScript）
    '@typescript-eslint/no-explicit-any': 'warn',

    // 要求 Promise 有错误处理
    'promise/catch-or-return': 'error',

    // 禁止 console.log（生产环境）
    'no-console': process.env.NODE_ENV === 'production' ? 'error' : 'warn'
  }
};
```

### 3. 添加类型检查

```typescript
// 使用 TypeScript 或 JSDoc 添加类型注解
interface User {
  id: number;
  name: string;
  email: string;
  createdAt: Date;
}

function processUser(user: User): void {
  // TypeScript 会在编译时检查类型
}

// JSDoc 方式
/**
 * @param {User} user
 * @returns {void}
 */
function processUser(user) {
  // ...
}
```

### 4. 更新文档

```markdown
## 已知问题和解决方案

### Token 过期处理
**问题**: Token 过期后未自动刷新，导致用户被登出
**原因**: 组件卸载时清除了全局刷新定时器
**解决**: 将定时器移至全局状态管理，组件卸载不影响
**日期**: 2024-01-15
**相关 PR**: #123

### API 超时处理
**问题**: API 超时时返回空响应，前端未处理导致崩溃
**原因**: 缺少超时错误处理
**解决**: 添加超时检测和错误处理
**日期**: 2024-01-10
**相关 PR**: #120
```

### 5. 代码审查检查点

在 PR 模板中添加检查项：

```markdown
## PR 检查清单

### 代码质量
- [ ] 代码符合项目规范
- [ ] 没有硬编码的敏感信息
- [ ] 错误处理完善

### 测试
- [ ] 添加了单元测试
- [ ] 所有测试通过
- [ ] 测试覆盖了边界情况

### 安全
- [ ] 用户输入已验证
- [ ] 没有 SQL 注入风险
- [ ] 没有 XSS 风险

### 文档
- [ ] 更新了相关文档
- [ ] 添加了必要的注释
```

## 经验总结模板

```markdown
## Bug 修复总结

### 问题描述
[简要描述问题]

### 根本原因
[描述根本原因]

### 解决方案
[描述解决方案]

### 经验教训
1. [教训1：例如"异步操作必须有错误处理"]
2. [教训2：例如"组件卸载时要清理副作用"]
3. [教训3：例如"API 返回值要做空值检查"]

### 预防措施
1. [措施1：例如"添加 ESLint 规则检查未处理的 Promise"]
2. [措施2：例如"添加单元测试覆盖边界情况"]
3. [措施3：例如"更新代码审查检查清单"]

### 相关链接
- Issue: #xxx
- PR: #xxx
- 文档: [链接]
```

## 团队分享

### 分享内容
- Bug 的现象和影响
- 排查过程和方法
- 根本原因分析
- 修复方案和权衡
- 预防措施和建议

### 分享形式
- 团队周会分享
- 技术博客文章
- 内部 Wiki 文档
- Code Review 讨论

## 检查清单

- [ ] 是否添加了回归测试用例
- [ ] 是否更新了相关文档
- [ ] 是否有预防类似问题的措施
- [ ] 是否总结了经验教训
- [ ] 是否与团队分享了经验

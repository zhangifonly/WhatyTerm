# 代码审查 - 测试检查阶段

## 阶段目标
检查测试覆盖率和测试质量，确保代码变更有足够的测试保障。

## 测试检查维度

### 1. 测试覆盖率

```bash
# 运行测试并查看覆盖率
npm test -- --coverage

# 覆盖率指标
# - 行覆盖率 (Line Coverage)
# - 分支覆盖率 (Branch Coverage)
# - 函数覆盖率 (Function Coverage)
```

**覆盖率标准**：
| 级别 | 覆盖率 | 说明 |
|------|--------|------|
| 优秀 | > 80% | 核心代码应达到 |
| 良好 | 60-80% | 一般代码 |
| 需改进 | < 60% | 需要补充测试 |

### 2. 测试类型检查

| 测试类型 | 检查点 |
|---------|-------|
| 单元测试 | 是否覆盖核心函数 |
| 集成测试 | 是否测试模块交互 |
| E2E 测试 | 是否覆盖关键流程 |

### 3. 测试质量

#### 好的测试特征
```javascript
// ✅ 好的测试
describe('UserService', () => {
  describe('createUser', () => {
    it('should create user with valid data', async () => {
      const userData = { name: 'John', email: 'john@example.com' };
      const user = await userService.createUser(userData);

      expect(user.id).toBeDefined();
      expect(user.name).toBe('John');
      expect(user.email).toBe('john@example.com');
    });

    it('should throw error when email is invalid', async () => {
      const userData = { name: 'John', email: 'invalid' };

      await expect(userService.createUser(userData))
        .rejects.toThrow('Invalid email');
    });

    it('should throw error when email already exists', async () => {
      // 先创建一个用户
      await userService.createUser({ name: 'John', email: 'john@example.com' });

      // 尝试创建相同邮箱的用户
      await expect(userService.createUser({ name: 'Jane', email: 'john@example.com' }))
        .rejects.toThrow('Email already exists');
    });
  });
});
```

#### 差的测试特征
```javascript
// ❌ 差的测试
it('test user', () => {
  const user = createUser({ name: 'test' });
  expect(user).toBeTruthy(); // 断言太弱
});
```

### 4. 边界情况测试

需要测试的边界情况：
- 空值输入 (null, undefined, '')
- 边界值 (0, -1, MAX_INT)
- 特殊字符
- 并发操作
- 超时情况
- 网络错误

```javascript
describe('边界情况', () => {
  it('should handle null input', () => {
    expect(() => processData(null)).toThrow('Invalid input');
  });

  it('should handle empty array', () => {
    expect(processArray([])).toEqual([]);
  });

  it('should handle very large input', () => {
    const largeArray = new Array(10000).fill(1);
    expect(() => processArray(largeArray)).not.toThrow();
  });
});
```

## 测试审查清单

### 必须检查
- [ ] 新功能是否有对应的测试
- [ ] 修复的 bug 是否有回归测试
- [ ] 测试是否能独立运行
- [ ] 测试是否稳定（不 flaky）

### 建议检查
- [ ] 测试命名是否清晰
- [ ] 测试是否覆盖边界情况
- [ ] 是否有不必要的 mock
- [ ] 测试代码是否易于维护

## 常见测试问题

| 问题 | 说明 | 解决方案 |
|------|------|---------|
| 测试太脆弱 | 依赖实现细节 | 测试行为而非实现 |
| 测试太慢 | 执行时间长 | 使用 mock，减少 I/O |
| 测试不稳定 | 时而通过时而失败 | 消除时序依赖 |
| 断言太弱 | 只检查 truthy | 使用具体的断言 |

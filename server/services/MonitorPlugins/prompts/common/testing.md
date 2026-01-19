# 测试指南

## 测试类型

### 1. 单元测试 (Unit Test)
测试单个函数或模块的功能。

```javascript
// Jest 示例
describe('add', () => {
  it('should add two numbers', () => {
    expect(add(1, 2)).toBe(3);
  });

  it('should handle negative numbers', () => {
    expect(add(-1, 1)).toBe(0);
  });

  it('should handle zero', () => {
    expect(add(0, 0)).toBe(0);
  });
});
```

### 2. 集成测试 (Integration Test)
测试多个模块之间的交互。

```javascript
describe('UserService', () => {
  it('should create user and send welcome email', async () => {
    const user = await userService.createUser({
      name: 'John',
      email: 'john@example.com'
    });

    expect(user.id).toBeDefined();
    expect(emailService.sendWelcome).toHaveBeenCalledWith(user.email);
  });
});
```

### 3. 端到端测试 (E2E Test)
测试完整的用户流程。

```javascript
// Cypress 示例
describe('Login Flow', () => {
  it('should login successfully', () => {
    cy.visit('/login');
    cy.get('[data-testid="email"]').type('user@example.com');
    cy.get('[data-testid="password"]').type('password123');
    cy.get('[data-testid="submit"]').click();
    cy.url().should('include', '/dashboard');
  });
});
```

## 测试原则

### AAA 模式
```javascript
it('should calculate total price', () => {
  // Arrange - 准备测试数据
  const items = [
    { price: 10, quantity: 2 },
    { price: 5, quantity: 3 }
  ];

  // Act - 执行被测试的操作
  const total = calculateTotal(items);

  // Assert - 验证结果
  expect(total).toBe(35);
});
```

### 测试隔离
- 每个测试独立运行
- 不依赖其他测试的结果
- 使用 beforeEach/afterEach 重置状态

### Mock 使用
```javascript
// Mock 外部依赖
jest.mock('./emailService', () => ({
  sendEmail: jest.fn().mockResolvedValue(true)
}));

// Mock 时间
jest.useFakeTimers();
jest.setSystemTime(new Date('2024-01-15'));

// Mock 网络请求
jest.mock('axios');
axios.get.mockResolvedValue({ data: { id: 1 } });
```

## 测试覆盖率

### 覆盖率类型
| 类型 | 说明 |
|------|------|
| 行覆盖率 | 执行的代码行数 |
| 分支覆盖率 | 执行的条件分支 |
| 函数覆盖率 | 调用的函数数量 |
| 语句覆盖率 | 执行的语句数量 |

### 覆盖率目标
- 核心业务逻辑：> 80%
- 工具函数：> 90%
- UI 组件：> 60%

## 常用断言

```javascript
// 相等
expect(value).toBe(expected);
expect(value).toEqual(expected);

// 真值
expect(value).toBeTruthy();
expect(value).toBeFalsy();
expect(value).toBeNull();
expect(value).toBeUndefined();

// 数字
expect(value).toBeGreaterThan(3);
expect(value).toBeLessThan(5);
expect(value).toBeCloseTo(0.3, 5);

// 字符串
expect(value).toMatch(/pattern/);
expect(value).toContain('substring');

// 数组
expect(array).toContain(item);
expect(array).toHaveLength(3);

// 异常
expect(() => fn()).toThrow();
expect(() => fn()).toThrow('error message');

// 异步
await expect(promise).resolves.toBe(value);
await expect(promise).rejects.toThrow();
```

## 测试命令

```bash
# 运行所有测试
npm test

# 运行特定文件
npm test -- user.test.js

# 监听模式
npm test -- --watch

# 覆盖率报告
npm test -- --coverage

# 更新快照
npm test -- -u
```

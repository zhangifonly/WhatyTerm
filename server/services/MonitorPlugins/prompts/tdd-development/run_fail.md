# TDD 开发 - 运行失败阶段（红色）

## 阶段目标
确认测试按预期失败，理解失败原因。

## 验证失败

### 预期的失败
```bash
# 运行测试
npm test

# 预期输出
FAIL  src/calculator.test.js
  ✕ should add two numbers (5ms)

  ● Calculator › add › should add two numbers

    ReferenceError: add is not defined
```

### 非预期的失败
- 语法错误
- 导入错误
- 配置错误

## 失败分析

### 检查失败原因
1. 函数未定义 → 正确，需要实现
2. 语法错误 → 修复测试代码
3. 断言错误 → 检查测试逻辑

### 常见问题
| 问题 | 原因 | 解决 |
|------|------|------|
| ReferenceError | 函数未定义 | 正常，继续实现 |
| SyntaxError | 语法错误 | 修复测试代码 |
| TypeError | 类型错误 | 检查参数类型 |

## 确认清单

- [ ] 测试是否按预期失败
- [ ] 失败原因是否明确
- [ ] 是否准备好实现

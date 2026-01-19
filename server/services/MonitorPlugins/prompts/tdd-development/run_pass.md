# TDD 开发 - 测试通过阶段（绿色）

## 阶段目标
确认所有测试通过，准备重构。

## 验证通过

### 运行测试
```bash
npm test

# 预期输出
PASS  src/calculator.test.js
  Calculator
    add
      ✓ should add two positive numbers (2ms)
      ✓ should handle negative numbers (1ms)
      ✓ should handle zero (1ms)

Test Suites: 1 passed, 1 total
Tests:       3 passed, 3 total
```

### 检查覆盖率
```bash
npm test -- --coverage

# 目标覆盖率
# 语句覆盖率 > 80%
# 分支覆盖率 > 80%
# 函数覆盖率 > 90%
```

## 下一步决策

### 是否需要更多测试？
- 边界情况是否覆盖？
- 异常情况是否覆盖？
- 是否有遗漏的场景？

### 是否需要重构？
- 代码是否有重复？
- 命名是否清晰？
- 结构是否合理？

## 通过清单

- [ ] 所有测试是否通过
- [ ] 是否有遗漏的测试
- [ ] 是否需要重构

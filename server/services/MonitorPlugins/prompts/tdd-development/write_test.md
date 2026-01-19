# TDD 开发 - 编写测试阶段（红色）

## 阶段目标
先编写失败的测试，描述预期行为。

## TDD 原则

### 红-绿-重构循环
```
1. 红色：编写失败的测试
2. 绿色：编写最少代码让测试通过
3. 重构：改进代码质量
```

### 测试先行
- 先写测试，再写实现
- 测试描述预期行为
- 测试是活文档

## 编写测试

### 测试结构
```javascript
describe('Calculator', () => {
  describe('add', () => {
    it('should add two positive numbers', () => {
      expect(add(1, 2)).toBe(3);
    });

    it('should handle negative numbers', () => {
      expect(add(-1, 1)).toBe(0);
    });

    it('should handle zero', () => {
      expect(add(0, 0)).toBe(0);
    });
  });
});
```

### 测试命名
```javascript
// 好的命名
it('should return empty array when input is empty')
it('should throw error when user is not found')

// 不好的命名
it('test1')
it('works')
```

## 编写清单

- [ ] 测试是否描述了预期行为
- [ ] 测试是否足够具体
- [ ] 是否覆盖边界情况

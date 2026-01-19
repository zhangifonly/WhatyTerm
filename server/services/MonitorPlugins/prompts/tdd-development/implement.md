# TDD 开发 - 实现代码阶段（绿色）

## 阶段目标
编写最少的代码让测试通过。

## 实现原则

### 最小实现
```javascript
// 测试
it('should add two numbers', () => {
  expect(add(1, 2)).toBe(3);
});

// 最小实现（不是最终实现）
function add(a, b) {
  return 3;  // 先让测试通过
}

// 添加更多测试后再完善
function add(a, b) {
  return a + b;
}
```

### 不要过度设计
- 只写让测试通过的代码
- 不要预测未来需求
- 不要添加额外功能

## 实现步骤

```
1. 看测试失败信息
2. 写最少代码让测试通过
3. 运行测试确认通过
4. 如果有更多测试，重复
```

## 代码示例

### 逐步实现
```javascript
// 第一个测试
it('should return 0 for empty array', () => {
  expect(sum([])).toBe(0);
});

// 第一个实现
function sum(arr) {
  return 0;
}

// 第二个测试
it('should sum single element', () => {
  expect(sum([5])).toBe(5);
});

// 第二个实现
function sum(arr) {
  return arr[0] || 0;
}

// 第三个测试
it('should sum multiple elements', () => {
  expect(sum([1, 2, 3])).toBe(6);
});

// 最终实现
function sum(arr) {
  return arr.reduce((a, b) => a + b, 0);
}
```

## 实现清单

- [ ] 实现是否最小化
- [ ] 是否只为通过测试
- [ ] 代码是否简洁

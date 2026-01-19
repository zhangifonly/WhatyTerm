# TDD 开发 - 重构阶段

## 阶段目标
在测试保护下改进代码质量。

## 重构原则

### 保持测试通过
```bash
# 每次小改动后运行测试
npm test

# 测试失败立即回滚
git checkout -- .
```

### 小步重构
- 每次只做一件事
- 频繁运行测试
- 及时提交

## 常见重构

### 消除重复
```javascript
// 重构前
function calculateArea(width, height) {
  return width * height;
}

function calculatePerimeter(width, height) {
  return 2 * width + 2 * height;
}

// 重构后
class Rectangle {
  constructor(width, height) {
    this.width = width;
    this.height = height;
  }

  get area() {
    return this.width * this.height;
  }

  get perimeter() {
    return 2 * (this.width + this.height);
  }
}
```

### 提取方法
```javascript
// 重构前
function processOrder(order) {
  // 验证订单
  if (!order.items || order.items.length === 0) {
    throw new Error('Empty order');
  }
  // 计算总价
  let total = 0;
  for (const item of order.items) {
    total += item.price * item.quantity;
  }
  return total;
}

// 重构后
function processOrder(order) {
  validateOrder(order);
  return calculateTotal(order.items);
}

function validateOrder(order) {
  if (!order.items || order.items.length === 0) {
    throw new Error('Empty order');
  }
}

function calculateTotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}
```

## 重构清单

- [ ] 重构是否保持测试通过
- [ ] 代码是否更清晰
- [ ] 是否消除重复

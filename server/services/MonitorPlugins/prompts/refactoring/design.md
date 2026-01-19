# 重构优化 - 方案设计阶段

## 阶段目标
设计重构方案，评估风险，选择最佳策略。

## 重构策略

### 1. 提取方法 (Extract Method)
```javascript
// 重构前
function printOwing() {
  printBanner();
  // 打印详情
  console.log("name: " + name);
  console.log("amount: " + getOutstanding());
}

// 重构后
function printOwing() {
  printBanner();
  printDetails();
}

function printDetails() {
  console.log("name: " + name);
  console.log("amount: " + getOutstanding());
}
```

### 2. 提取类 (Extract Class)
将一个类的部分职责移到新类中。

### 3. 移动方法 (Move Method)
将方法移到更合适的类中。

### 4. 引入参数对象 (Introduce Parameter Object)
```javascript
// 重构前
function amountInvoiced(start, end) { }
function amountReceived(start, end) { }

// 重构后
function amountInvoiced(dateRange) { }
function amountReceived(dateRange) { }
```

### 5. 用多态替换条件 (Replace Conditional with Polymorphism)
```javascript
// 重构前
function getSpeed() {
  switch (type) {
    case 'european': return getBaseSpeed();
    case 'african': return getBaseSpeed() - getLoadFactor();
  }
}

// 重构后
class European {
  getSpeed() { return this.getBaseSpeed(); }
}
class African {
  getSpeed() { return this.getBaseSpeed() - this.getLoadFactor(); }
}
```

## 风险评估

| 风险类型 | 评估要点 | 缓解措施 |
|----------|----------|----------|
| 功能回归 | 是否有足够测试覆盖 | 先补充测试 |
| 性能影响 | 重构是否影响性能 | 性能基准测试 |
| 兼容性 | 是否影响外部接口 | 保持接口稳定 |
| 时间成本 | 重构需要多长时间 | 分阶段进行 |

## 设计清单

- [ ] 列出多个重构方案
- [ ] 评估每个方案的风险
- [ ] 考虑向后兼容性
- [ ] 确定重构顺序
- [ ] 准备回滚方案

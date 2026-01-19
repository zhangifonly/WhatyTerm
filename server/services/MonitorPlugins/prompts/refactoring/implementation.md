# 重构优化 - 重构实施阶段

## 阶段目标
小步安全地实施重构，保持代码始终可工作。

## 重构原则

### 小步前进
```
1. 做一个小改动
2. 运行测试
3. 如果通过，继续
4. 如果失败，回滚
```

### 保持绿灯
- 每次修改后运行测试
- 测试失败立即修复
- 不要积累多个改动

### 频繁提交
```bash
# 每完成一个小重构就提交
git add -A
git commit -m "refactor: 提取 calculateTotal 方法"
```

## 常用重构手法

### 重命名 (Rename)
```javascript
// IDE 快捷键
// VSCode: F2
// IntelliJ: Shift + F6
```

### 提取变量 (Extract Variable)
```javascript
// 重构前
if (platform.toUpperCase().indexOf("MAC") > -1 &&
    browser.toUpperCase().indexOf("IE") > -1) {
  // ...
}

// 重构后
const isMacOS = platform.toUpperCase().indexOf("MAC") > -1;
const isIE = browser.toUpperCase().indexOf("IE") > -1;
if (isMacOS && isIE) {
  // ...
}
```

### 内联变量 (Inline Variable)
```javascript
// 重构前
const basePrice = order.basePrice;
return basePrice > 1000;

// 重构后
return order.basePrice > 1000;
```

### 改变函数声明 (Change Function Declaration)
```javascript
// 添加参数
// 修改返回类型
// 重命名函数
```

## 实施清单

- [ ] 确保测试覆盖
- [ ] 小步进行修改
- [ ] 每步运行测试
- [ ] 及时提交代码
- [ ] 保留原有功能

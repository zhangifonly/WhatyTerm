# Bug 修复 - 原因分析阶段

## 阶段目标
通过系统化分析找出问题的根本原因，而非表面现象。

## 根因分析方法

### 1. 5 Why 分析法
连续问 5 次"为什么"，直到找到根本原因：

```
问题：用户登录失败
Why 1: 为什么登录失败？→ API 返回 401 错误
Why 2: 为什么返回 401？→ Token 验证失败
Why 3: 为什么 Token 验证失败？→ Token 已过期
Why 4: 为什么 Token 过期？→ 刷新机制未触发
Why 5: 为什么刷新机制未触发？→ 组件卸载时清除了定时器

根因：组件卸载时错误地清除了全局 Token 刷新定时器
```

### 2. 二分法定位
在代码中插入检查点，逐步缩小问题范围：

```javascript
// 第一轮：粗粒度检查
console.log('=== Checkpoint A: 函数入口 ===', { input });
// ... 代码块 1 ...
console.log('=== Checkpoint B: 数据处理后 ===', { processed });
// ... 代码块 2 ...
console.log('=== Checkpoint C: 函数出口 ===', { output });

// 确定问题在 A-B 之间后，细化检查
console.log('=== Checkpoint A1 ===', { step1 });
console.log('=== Checkpoint A2 ===', { step2 });
// ...
```

### 3. 堆栈分析
```
Error: Cannot read property 'name' of undefined
    at getUserName (user.js:15:23)      ← 直接原因：user 为 undefined
    at renderProfile (profile.js:42:10)  ← 调用位置
    at App.render (App.js:28:5)          ← 上层调用
    at processChild (react-dom.js:...)   ← 框架代码（通常可忽略）
```

**分析步骤**：
1. 找到第一个自己代码的位置（user.js:15）
2. 检查该位置的变量来源
3. 向上追溯，找到数据的源头

### 4. 差异对比法
对比正常和异常情况的差异：

| 对比项 | 正常情况 | 异常情况 |
|-------|---------|---------|
| 输入数据 | `{id: 1, name: "test"}` | `{id: null}` |
| 环境变量 | `NODE_ENV=production` | `NODE_ENV=undefined` |
| 请求头 | 包含 Authorization | 缺少 Authorization |
| 时序 | A → B → C | A → C → B |

## 常见问题类型分析

### 空引用错误
**症状**: `Cannot read property 'x' of undefined/null`

**分析方向**:
- 数据来源是否可靠（API 返回、用户输入）
- 初始化时机是否正确
- 异步操作是否完成
- 条件分支是否覆盖所有情况

### 类型错误
**症状**: `TypeError`, `is not a function`

**分析方向**:
- 变量类型是否符合预期
- 函数参数类型是否正确
- 隐式类型转换是否有问题
- 第三方库 API 是否正确使用

### 异步错误
**症状**: `UnhandledPromiseRejection`, 数据不一致

**分析方向**:
- Promise 链是否正确
- await 是否遗漏
- 并发操作是否有竞态条件
- 错误处理是否完善

### 状态错误
**症状**: 数据不一致、UI 不更新、重复操作

**分析方向**:
- 状态更新时机是否正确
- 是否有直接修改状态（应该用 setState）
- 组件生命周期是否正确处理
- 是否有内存泄漏（未清理的订阅/定时器）

## 分析记录模板

```markdown
## 原因分析报告

### 问题描述
[简要描述问题现象]

### 直接原因
[导致错误的直接原因，如：变量 user 为 undefined]

### 根本原因
[问题的根本原因，如：API 在网络超时时返回空响应，前端未处理]

### 影响范围
- 影响的功能: [列出受影响的功能]
- 影响的用户: [所有用户/特定条件用户]
- 数据影响: [是否有数据损坏/丢失]

### 问题代码位置
文件: [文件路径]
行号: [行号范围]
```javascript
// 问题代码
```

### 分析过程
1. [分析步骤1]
2. [分析步骤2]
3. [分析步骤3]
```

## 检查清单

- [ ] 是否找到了根本原因（不是表面现象）
- [ ] 是否理解了问题发生的机制
- [ ] 是否确定了影响范围
- [ ] 是否排除了其他可能原因
- [ ] 是否记录了分析过程

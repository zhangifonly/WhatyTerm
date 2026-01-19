# Bug 修复 - 修复实施阶段

## 阶段目标
实施针对根本原因的修复，确保修复有效且无副作用。

## 修复原则

### 1. 针对根因修复
```javascript
// ❌ 错误：绕过问题（治标不治本）
function getUserName(user) {
  // 只是避免报错，没解决 user 为何为空
  if (user && user.name) {
    return user.name;
  }
  return 'Unknown';
}

// ✅ 正确：修复根因
async function getUserName(userId) {
  // 确保正确获取用户数据
  const user = await fetchUser(userId);
  if (!user) {
    throw new UserNotFoundError(userId);
  }
  return user.name;
}
```

### 2. 最小化修改
- 只修改必要的代码
- 避免顺便重构（另开 PR）
- 保持代码风格一致
- 不引入新功能

### 3. 防御性编码
```javascript
// 添加参数验证
function processUser(user) {
  if (!user || typeof user !== 'object') {
    throw new TypeError('Invalid user object');
  }
  if (!user.id || typeof user.id !== 'number') {
    throw new TypeError('User must have a numeric id');
  }
  // ... 业务逻辑
}

// 添加边界检查
function getItem(array, index) {
  if (!Array.isArray(array)) {
    throw new TypeError('First argument must be an array');
  }
  if (index < 0 || index >= array.length) {
    return null; // 或抛出错误，取决于业务需求
  }
  return array[index];
}

// 使用可选链和空值合并
const userName = user?.profile?.name ?? 'Anonymous';
```

## 常见修复模式

### 空引用修复
```javascript
// 方案1：添加空值检查
if (data?.items?.length > 0) {
  processItems(data.items);
}

// 方案2：设置默认值
const items = data?.items ?? [];

// 方案3：提前验证
function processData(data) {
  if (!data?.items) {
    console.warn('No items to process');
    return;
  }
  // ...
}
```

### 异步错误修复
```javascript
// 方案1：添加 try/catch
async function fetchData() {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error('Fetch failed:', error);
    throw error; // 或返回默认值
  }
}

// 方案2：Promise 错误处理
fetchData()
  .then(handleSuccess)
  .catch(handleError)
  .finally(cleanup);

// 方案3：并发错误处理
const results = await Promise.allSettled([
  fetchUser(),
  fetchOrders(),
  fetchSettings()
]);
// 分别处理成功和失败的结果
```

### 状态错误修复
```javascript
// React：使用函数式更新避免竞态
setCount(prev => prev + 1);

// React：正确清理副作用
useEffect(() => {
  const timer = setInterval(tick, 1000);
  return () => clearInterval(timer); // 清理
}, []);

// 避免直接修改状态
// ❌ 错误
state.items.push(newItem);
// ✅ 正确
setState(prev => ({
  ...prev,
  items: [...prev.items, newItem]
}));
```

### 类型错误修复
```javascript
// 方案1：类型转换
const num = Number(input) || 0;
const str = String(value);

// 方案2：类型验证
function add(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') {
    throw new TypeError('Arguments must be numbers');
  }
  return a + b;
}

// 方案3：TypeScript 类型注解
function greet(name: string): string {
  return `Hello, ${name}`;
}
```

## 修复记录模板

```markdown
## 修复方案

### 修复内容
[描述具体修改了什么]

### 修改的文件
| 文件 | 修改说明 |
|------|---------|
| src/user.js | 添加空值检查 |
| src/api.js | 添加错误处理 |

### 代码变更
```diff
- const name = user.name;
+ const name = user?.name ?? 'Unknown';
```

### 潜在影响
[描述修复可能影响的其他功能]

### 回滚方案
[如果修复有问题，如何回滚]
```

## 代码审查要点

- [ ] 修复是否针对根本原因
- [ ] 是否有副作用
- [ ] 是否保持向后兼容
- [ ] 代码是否符合规范
- [ ] 是否添加了必要的注释
- [ ] 是否考虑了边界情况

## 检查清单

- [ ] 修复针对根本原因（而非绕过问题）
- [ ] 修复没有引入新问题
- [ ] 代码符合项目规范
- [ ] 添加了必要的注释说明
- [ ] 考虑了边界情况
- [ ] 准备了回滚方案

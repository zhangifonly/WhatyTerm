# 代码质量检查指南

## 命名规范

### JavaScript/TypeScript
| 类型 | 规范 | 示例 |
|------|------|------|
| 变量 | camelCase | `userName`, `isActive` |
| 常量 | UPPER_SNAKE_CASE | `MAX_RETRY_COUNT`, `API_BASE_URL` |
| 函数 | camelCase，动词开头 | `getUserInfo()`, `handleClick()` |
| 类 | PascalCase | `UserService`, `HttpClient` |
| React 组件 | PascalCase | `UserProfile`, `NavBar` |
| 文件名 | 与导出内容一致 | `UserService.js`, `utils.js` |
| 私有成员 | 下划线前缀 | `_privateMethod()`, `_cache` |

### 命名语义
- **布尔值**: `is`, `has`, `can`, `should` 前缀
- **数组**: 复数形式 `users`, `items`
- **回调函数**: `on` 或 `handle` 前缀
- **异步函数**: 可加 `async` 后缀或返回 Promise 的动词

## 代码结构

### 函数设计原则
1. **单一职责**: 一个函数只做一件事
2. **长度限制**: 建议不超过 50 行
3. **参数数量**: 建议不超过 3 个，多了用对象
4. **嵌套深度**: 最多 3 层，超过需要重构

### 文件组织
```
src/
├── components/     # UI 组件
│   ├── common/     # 通用组件
│   └── features/   # 功能组件
├── hooks/          # 自定义 Hooks
├── services/       # API 服务
├── utils/          # 工具函数
├── types/          # 类型定义
└── constants/      # 常量定义
```

### 模块导入顺序
```javascript
// 1. 外部依赖
import React from 'react';
import { useState } from 'react';

// 2. 内部模块
import { UserService } from '@/services';
import { formatDate } from '@/utils';

// 3. 类型定义
import type { User } from '@/types';

// 4. 样式文件
import './styles.css';
```

## 代码复杂度控制

### 圈复杂度
- **1-10**: 简单，易于测试
- **11-20**: 中等，需要关注
- **21+**: 复杂，建议重构

### 降低复杂度的方法
```javascript
// 不好：深层嵌套
if (user) {
  if (user.isActive) {
    if (user.hasPermission) {
      doSomething();
    }
  }
}

// 好：提前返回
if (!user) return;
if (!user.isActive) return;
if (!user.hasPermission) return;
doSomething();

// 不好：复杂条件
if (status === 'active' || status === 'pending' || status === 'review') {
  // ...
}

// 好：使用集合
const validStatuses = ['active', 'pending', 'review'];
if (validStatuses.includes(status)) {
  // ...
}
```

## 注释规范

### 何时需要注释
- 复杂的业务逻辑
- 非显而易见的算法
- 临时解决方案（TODO）
- API 文档（JSDoc）

### 何时不需要注释
- 代码本身已经清晰表达意图
- 简单的 getter/setter
- 显而易见的操作

### JSDoc 示例
```javascript
/**
 * 计算用户的订阅剩余天数
 * @param {Date} expiresAt - 订阅到期时间
 * @returns {number} 剩余天数，已过期返回 0
 */
function getRemainingDays(expiresAt) {
  const diff = expiresAt - new Date();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}
```

## 性能考虑

### 避免的模式
- 在循环中创建函数
- 不必要的重新渲染（React）
- 大数组的频繁操作
- 同步阻塞操作

### 推荐的模式
```javascript
// 使用 Map 代替对象查找（大数据量）
const userMap = new Map(users.map(u => [u.id, u]));

// 使用 Set 去重
const uniqueIds = [...new Set(ids)];

// 延迟加载
const HeavyComponent = React.lazy(() => import('./HeavyComponent'));

// 防抖/节流
const debouncedSearch = debounce(search, 300);
```

## 检查清单

- [ ] 命名是否清晰、一致
- [ ] 函数是否单一职责
- [ ] 是否有过深的嵌套
- [ ] 是否有重复代码
- [ ] 是否有未使用的变量/导入
- [ ] 错误处理是否完善
- [ ] 是否有潜在的性能问题

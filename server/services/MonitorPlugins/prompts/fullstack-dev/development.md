# 全栈开发 - 编码开发阶段

## 阶段目标
按照实施计划高质量完成代码开发，确保代码规范、功能完整、安全可靠。

## 开发流程

### 1. 开始任务前
- 阅读任务描述和验收标准
- 确认技术方案中的相关设计
- 创建 todolist 跟踪子任务

### 2. 开发过程中
- 遵循代码规范
- 及时提交代码
- 编写必要的注释

### 3. 完成任务后
- 自测功能是否正常
- 在实施计划中标记完成
- 更新 todolist 状态

## 代码规范

### 命名规范
```javascript
// 变量：camelCase
const userName = 'John';
const isActive = true;

// 常量：UPPER_SNAKE_CASE
const MAX_RETRY_COUNT = 3;
const API_BASE_URL = '/api';

// 函数：camelCase，动词开头
function getUserInfo() {}
function handleSubmit() {}

// 类：PascalCase
class UserService {}

// React 组件：PascalCase
const UserProfile = () => {};
```

### 文件结构
```
src/
├── components/          # 可复用组件
│   ├── ui/              # 基础 UI 组件
│   └── features/        # 功能组件
├── pages/               # 页面组件
├── hooks/               # 自定义 Hooks
├── services/            # API 服务
├── utils/               # 工具函数
├── types/               # 类型定义
└── constants/           # 常量定义
```

### React 组件模板
```jsx
import { useState, useEffect } from 'react';

/**
 * 组件描述
 * @param {Object} props
 * @param {string} props.title - 标题
 */
export default function ComponentName({ title }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // 副作用逻辑
  }, []);

  if (loading) {
    return <div>加载中...</div>;
  }

  return (
    <div className="p-4">
      <h1 className="text-xl font-bold">{title}</h1>
      {/* 组件内容 */}
    </div>
  );
}
```

### API 服务模板
```javascript
const API_BASE = '/api';

export const userService = {
  async getUsers() {
    const res = await fetch(`${API_BASE}/users`);
    if (!res.ok) throw new Error('获取用户列表失败');
    return res.json();
  },

  async getUserById(id) {
    const res = await fetch(`${API_BASE}/users/${id}`);
    if (!res.ok) throw new Error('获取用户详情失败');
    return res.json();
  },

  async createUser(data) {
    const res = await fetch(`${API_BASE}/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error('创建用户失败');
    return res.json();
  },
};
```

## 安全检查清单

- [ ] 用户输入已验证和转义
- [ ] 敏感信息未硬编码
- [ ] API 调用有错误处理
- [ ] 避免 SQL 注入和 XSS
- [ ] 文件上传有类型和大小限制

## 常见问题处理

| 问题 | 解决方案 |
|------|---------|
| 依赖安装失败 | 检查网络，尝试换源 `npm config set registry https://registry.npmmirror.com` |
| 类型错误 | 检查 TypeScript 类型定义 |
| 样式不生效 | 检查 Tailwind 配置，确认类名正确 |
| 组件不渲染 | 检查导入导出和 props 传递 |
| API 请求失败 | 检查 URL、参数、CORS 配置 |

## 检查清单

- [ ] 是否严格按照实施计划执行
- [ ] 是否制定了 todolist 跟踪进度
- [ ] 完成任务后是否标记完成
- [ ] 代码是否符合技术方案要求
- [ ] 是否包含 mock 数据
- [ ] 代码是否符合命名规范
- [ ] 是否有适当的错误处理
- [ ] 是否避免了安全漏洞

{{include:common/code-quality}}

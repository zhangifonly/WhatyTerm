# 全栈开发 - 技术方案阶段

## 阶段目标
制定合理的技术架构和选型方案，确保项目可实施、可维护、可扩展。

## 推荐技术栈

### 前端技术栈
| 层级 | 推荐方案 | 说明 |
|------|---------|------|
| 框架 | React / Vue / Next.js | 根据项目需求选择 |
| UI 组件 | shadcn/ui | 基于 Radix，高度可定制 |
| 样式方案 | Tailwind CSS | 原子化 CSS，开发效率高 |
| 状态管理 | Zustand / Jotai | 轻量级状态管理 |
| 图标库 | Lucide / FontAwesome | 丰富的图标资源 |

### 后端技术栈
| 层级 | 推荐方案 | 说明 |
|------|---------|------|
| 运行时 | Node.js | JavaScript 全栈 |
| 框架 | Express / Fastify | 轻量级 Web 框架 |
| 数据库 | SQLite / PostgreSQL | 根据规模选择 |
| ORM | Prisma / Drizzle | 类型安全的数据库操作 |
| 认证 | JWT / Session | 根据场景选择 |

### CDN 配置
使用国内可访问的 CDN：
- unpkg.com（备选）
- cdn.jsdelivr.net
- cdnjs.cloudflare.com

## 文档结构模板

```markdown
# 技术方案

## 1. 技术选型

### 1.1 前端技术栈
| 技术 | 版本 | 用途 | 选型理由 |
|------|------|------|---------|
| React | 18.x | UI 框架 | 生态丰富，团队熟悉 |
| Tailwind CSS | 3.x | 样式方案 | 开发效率高 |
| shadcn/ui | latest | UI 组件 | 可定制性强 |

### 1.2 后端技术栈
| 技术 | 版本 | 用途 | 选型理由 |
|------|------|------|---------|
| Node.js | 20.x | 运行时 | 前后端统一 |
| Express | 4.x | Web 框架 | 简单灵活 |
| SQLite | 3.x | 数据库 | 轻量级，无需部署 |

## 2. 架构设计

### 2.1 系统架构图
```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Browser   │────▶│   Server    │────▶│  Database   │
│  (React)    │◀────│  (Express)  │◀────│  (SQLite)   │
└─────────────┘     └─────────────┘     └─────────────┘
```

### 2.2 目录结构
```
project/
├── src/                 # 前端源码
│   ├── components/      # UI 组件
│   ├── pages/           # 页面组件
│   ├── hooks/           # 自定义 Hooks
│   ├── services/        # API 服务
│   └── utils/           # 工具函数
├── server/              # 后端源码
│   ├── routes/          # 路由定义
│   ├── services/        # 业务逻辑
│   ├── models/          # 数据模型
│   └── middleware/      # 中间件
├── public/              # 静态资源
└── docs/                # 项目文档
```

## 3. 数据模型

### 3.1 数据库表设计
```sql
-- 用户表
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 其他表...
```

### 3.2 API 接口设计
| 接口 | 方法 | 描述 | 请求参数 | 响应 |
|------|------|------|---------|------|
| /api/users | GET | 获取用户列表 | page, limit | User[] |
| /api/users/:id | GET | 获取用户详情 | id | User |

## 4. 安全设计

### 4.1 认证方案
- 使用 JWT Token 认证
- Token 有效期 7 天
- 支持 Token 刷新

### 4.2 数据安全
- 密码使用 bcrypt 哈希
- 敏感数据加密存储
- API 使用 HTTPS
```

## 检查清单

- [ ] 技术选型有明确理由
- [ ] 架构图清晰完整
- [ ] 数据模型设计合理
- [ ] 考虑了安全性
- [ ] CDN 国内可访问
- [ ] 文档已保存到 `docs/技术方案.md`

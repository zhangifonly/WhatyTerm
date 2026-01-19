# API 集成 - 接口设计阶段

## 阶段目标
设计清晰、规范的 API 接口。

## RESTful 设计

### 资源命名
```
# 好的命名
GET /users
GET /users/123
GET /users/123/orders

# 不好的命名
GET /getUsers
GET /user_list
GET /getUserOrders
```

### HTTP 方法
| 方法 | 用途 | 示例 |
|------|------|------|
| GET | 获取资源 | GET /users |
| POST | 创建资源 | POST /users |
| PUT | 完整更新 | PUT /users/123 |
| PATCH | 部分更新 | PATCH /users/123 |
| DELETE | 删除资源 | DELETE /users/123 |

### 状态码
| 状态码 | 含义 |
|--------|------|
| 200 | 成功 |
| 201 | 创建成功 |
| 204 | 无内容 |
| 400 | 请求错误 |
| 401 | 未认证 |
| 403 | 无权限 |
| 404 | 未找到 |
| 500 | 服务器错误 |

## 请求/响应格式

### 请求格式
```json
{
  "name": "John",
  "email": "john@example.com"
}
```

### 响应格式
```json
{
  "code": 0,
  "message": "success",
  "data": {
    "id": 123,
    "name": "John"
  }
}
```

## 设计清单

- [ ] 接口是否符合 RESTful 规范
- [ ] 请求/响应格式是否清晰
- [ ] 错误处理是否完善

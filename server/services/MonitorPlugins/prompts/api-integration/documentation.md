# API 集成 - 文档编写阶段

## 阶段目标
编写清晰的 API 文档。

## 文档格式

### OpenAPI (Swagger)
```yaml
openapi: 3.0.0
info:
  title: User API
  version: 1.0.0

paths:
  /users:
    get:
      summary: 获取用户列表
      responses:
        '200':
          description: 成功
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/User'

components:
  schemas:
    User:
      type: object
      properties:
        id:
          type: integer
        name:
          type: string
        email:
          type: string
```

## 文档内容

### 端点文档
```markdown
## GET /api/users

获取用户列表

### 请求参数
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| page | int | 否 | 页码，默认 1 |
| limit | int | 否 | 每页数量，默认 10 |

### 响应示例
```json
{
  "code": 0,
  "data": [
    { "id": 1, "name": "John" }
  ],
  "total": 100
}
```

### 错误码
| 错误码 | 说明 |
|--------|------|
| 0 | 成功 |
| -1 | 参数错误 |
| -2 | 未认证 |
```

## 文档工具

- Swagger UI
- Redoc
- Postman
- Apifox

## 文档清单

- [ ] 文档是否完整
- [ ] 示例是否清晰
- [ ] 是否有使用说明

# API 集成 - 测试验证阶段

## 阶段目标
测试 API 端点，确保功能正确。

## 测试方法

### 使用 curl
```bash
# GET 请求
curl -X GET http://localhost:3000/api/users

# POST 请求
curl -X POST http://localhost:3000/api/users \
  -H "Content-Type: application/json" \
  -d '{"name": "John", "email": "john@example.com"}'

# 带认证
curl -X GET http://localhost:3000/api/users \
  -H "Authorization: Bearer token"
```

### 使用 Postman
1. 创建请求集合
2. 设置环境变量
3. 编写测试脚本
4. 运行自动化测试

### 单元测试
```javascript
const request = require('supertest');
const app = require('../app');

describe('GET /api/users', () => {
  it('should return users list', async () => {
    const res = await request(app)
      .get('/api/users')
      .expect(200);

    expect(res.body.code).toBe(0);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});
```

## 测试场景

| 场景 | 测试点 |
|------|--------|
| 正常请求 | 返回正确数据 |
| 参数错误 | 返回 400 |
| 未认证 | 返回 401 |
| 无权限 | 返回 403 |
| 资源不存在 | 返回 404 |

## 测试清单

- [ ] 所有端点是否正常
- [ ] 边界情况是否处理
- [ ] 性能是否达标

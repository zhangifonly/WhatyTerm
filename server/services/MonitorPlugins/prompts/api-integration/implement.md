# API 集成 - 端点实现阶段

## 阶段目标
实现 API 端点，处理请求和响应。

## 端点实现

### Express 示例
```javascript
const express = require('express');
const router = express.Router();

// GET /users
router.get('/users', async (req, res) => {
  try {
    const users = await User.findAll();
    res.json({ code: 0, data: users });
  } catch (error) {
    res.status(500).json({ code: -1, message: error.message });
  }
});

// POST /users
router.post('/users', async (req, res) => {
  try {
    const { name, email } = req.body;
    const user = await User.create({ name, email });
    res.status(201).json({ code: 0, data: user });
  } catch (error) {
    res.status(400).json({ code: -1, message: error.message });
  }
});
```

## 参数验证

### 使用 Joi
```javascript
const Joi = require('joi');

const userSchema = Joi.object({
  name: Joi.string().min(2).max(50).required(),
  email: Joi.string().email().required(),
  age: Joi.number().integer().min(0).max(150)
});

const validate = (schema) => (req, res, next) => {
  const { error } = schema.validate(req.body);
  if (error) {
    return res.status(400).json({ message: error.message });
  }
  next();
};
```

## 错误处理

```javascript
// 统一错误处理中间件
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    code: -1,
    message: err.message || 'Internal Server Error'
  });
});
```

## 实现清单

- [ ] 端点是否正确实现
- [ ] 参数验证是否完善
- [ ] 错误处理是否到位

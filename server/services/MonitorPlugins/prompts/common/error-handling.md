# 错误处理通用指南

## 错误分类

### 1. 语法错误 (SyntaxError)
**特征**: `SyntaxError`, `unexpected token`, `语法错误`

**排查步骤**:
1. 检查错误提示的行号和列号
2. 检查括号、引号、分号是否匹配
3. 检查是否有未闭合的字符串或模板字面量
4. 检查 JSON 格式是否正确

**常见原因**:
- 缺少闭合括号 `)`、`}`、`]`
- 字符串引号不匹配
- 对象/数组末尾多余逗号
- 使用了保留关键字作为变量名

### 2. 类型错误 (TypeError)
**特征**: `TypeError`, `is not a function`, `Cannot read property`

**排查步骤**:
1. 检查变量是否已正确初始化
2. 使用 `typeof` 或 `instanceof` 验证类型
3. 检查函数调用时参数类型是否正确
4. 检查对象属性访问链是否有 null/undefined

**防御性编码**:
```javascript
// 使用可选链
const name = user?.profile?.name;

// 使用空值合并
const count = value ?? 0;

// 类型检查
if (typeof callback === 'function') {
  callback();
}
```

### 3. 引用错误 (ReferenceError)
**特征**: `ReferenceError`, `is not defined`, `未定义`

**排查步骤**:
1. 检查变量是否在使用前声明
2. 检查变量作用域是否正确
3. 检查模块导入是否正确
4. 检查拼写是否正确

### 4. 网络错误 (NetworkError)
**特征**: `ECONNREFUSED`, `ETIMEDOUT`, `fetch failed`, `网络错误`

**排查步骤**:
1. 检查目标服务是否启动
2. 检查 URL 和端口是否正确
3. 检查网络连接和防火墙
4. 检查 CORS 配置（浏览器环境）

**处理建议**:
```javascript
// 添加重试机制
async function fetchWithRetry(url, options, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}
```

### 5. 异步错误 (AsyncError)
**特征**: `UnhandledPromiseRejection`, `Promise`, `async/await`

**排查步骤**:
1. 检查 Promise 链是否有 `.catch()` 处理
2. 检查 async 函数是否有 try/catch
3. 检查 await 是否在 async 函数内
4. 检查并发 Promise 是否正确处理

**最佳实践**:
```javascript
// 始终处理 Promise 错误
promise.then(handleSuccess).catch(handleError);

// async/await 使用 try/catch
async function doSomething() {
  try {
    const result = await asyncOperation();
    return result;
  } catch (err) {
    console.error('操作失败:', err);
    throw err; // 或返回默认值
  }
}
```

## 错误日志分析

### 堆栈追踪阅读方法
```
Error: Something went wrong
    at functionName (file.js:10:5)      ← 错误发生位置
    at callerFunction (caller.js:20:3)  ← 调用者
    at Object.<anonymous> (main.js:5:1) ← 入口点
```

1. **从上往下阅读** - 第一行是错误发生的直接位置
2. **找到自己的代码** - 跳过 node_modules 中的堆栈
3. **分析调用链** - 理解错误是如何传播的

## 错误恢复策略

| 错误类型 | 恢复策略 |
|---------|---------|
| 语法错误 | 修复代码后重新运行 |
| 类型错误 | 添加类型检查和默认值 |
| 网络错误 | 重试或提示用户检查网络 |
| 权限错误 | 检查文件/目录权限 |
| 内存错误 | 优化代码或增加资源限制 |

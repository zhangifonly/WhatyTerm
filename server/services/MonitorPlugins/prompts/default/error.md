# 通用监控 - 错误状态

## 状态说明
检测到程序错误，需要分析和处理。

## 错误分析步骤

### 1. 识别错误类型

| 错误类型 | 关键词 | 常见原因 |
|---------|-------|---------|
| SyntaxError | `SyntaxError`, `unexpected token` | 代码语法错误 |
| TypeError | `TypeError`, `is not a function` | 类型不匹配 |
| ReferenceError | `ReferenceError`, `is not defined` | 变量未定义 |
| ModuleNotFoundError | `Cannot find module` | 模块未安装 |
| PermissionError | `EACCES`, `Permission denied` | 权限不足 |
| ConnectionError | `ECONNREFUSED`, `timeout` | 网络问题 |

### 2. 定位错误位置

从堆栈信息中找到：
- 错误发生的文件路径
- 错误发生的行号
- 调用链（从上到下）

```
Error: Something went wrong
    at functionName (file.js:10:5)      ← 错误位置
    at callerFunction (caller.js:20:3)  ← 调用者
    at Object.<anonymous> (main.js:5:1) ← 入口
```

### 3. 分析根本原因

**代码问题**:
- 语法错误 → 检查括号、引号、分号
- 类型错误 → 检查变量类型
- 引用错误 → 检查变量声明和作用域

**环境问题**:
- 模块缺失 → `npm install` 或 `pip install`
- 权限问题 → `chmod` 或 `sudo`
- 配置错误 → 检查环境变量和配置文件

**外部依赖**:
- 网络问题 → 检查连接和防火墙
- 服务不可用 → 检查依赖服务状态
- API 变更 → 检查 API 文档

## 常见修复方案

### 语法错误
```bash
# 使用 ESLint 检查
npx eslint file.js

# 使用 Prettier 格式化
npx prettier --write file.js
```

### 模块缺失
```bash
# Node.js
npm install missing-module

# Python
pip install missing-module
```

### 权限问题
```bash
# 修改文件权限
chmod 755 script.sh

# 使用 sudo（谨慎）
sudo command
```

### 网络问题
```bash
# 检查连接
ping hostname
curl -v http://api.example.com

# 检查端口
netstat -an | grep PORT
```

## 操作建议

**当前状态**: 错误，需要人工处理

1. 仔细阅读错误信息
2. 定位错误发生的位置
3. 分析错误原因
4. 实施修复方案
5. 重新运行验证

{{include:common/error-handling}}

# 远程访问安全认证功能测试计划

## 测试范围
- 新用户注册赠送一个月 Pro 版本
- 远程访问安全认证（邮箱+密码）
- 登录速率限制
- Socket.IO 认证保护

## 测试环境
- 项目目录: `/Users/zhangzhen/Documents/ClaudeCode/WebTmux`
- 订阅服务器: `subscription-server/`
- 测试时间: 2026-01-25
- 测试完成时间: 2026-01-25

---

## 模块一：订阅服务器 API 测试 ✅ (9/9 通过)

### 1.1 用户注册 API
- [x] **T1.1.1** 验证 `/api/auth/register` 接口存在
- [x] **T1.1.2** 验证注册成功返回 token 和 trialLicense
- [x] **T1.1.3** 验证 trialLicense 包含 30 天有效期
- [x] **T1.1.4** 验证重复邮箱注册被拒绝

### 1.2 凭据验证 API
- [x] **T1.2.1** 验证 `/api/auth/verify-credentials` 接口存在
- [x] **T1.2.2** 验证正确凭据返回 valid: true
- [x] **T1.2.3** 验证错误密码返回 valid: false
- [x] **T1.2.4** 验证不存在的邮箱返回错误
- [x] **T1.2.5** 验证返回用户的许可证信息

---

## 模块二：客户端 AuthService 测试 ✅ (12/12 通过)

### 2.1 在线凭据验证
- [x] **T2.1.1** 验证 `verifyOnlineCredentials` 方法存在
- [x] **T2.1.2** 验证能正确调用订阅服务器 API

### 2.2 登录速率限制
- [x] **T2.2.1** 验证 `isLocked` 方法存在
- [x] **T2.2.2** 验证 `recordFailedAttempt` 方法存在
- [x] **T2.2.3** 验证最大尝试次数为 5
- [x] **T2.2.4** 验证锁定时间为 15 分钟

### 2.3 功能测试
- [x] **T2.3.1** 验证 AuthService 可以实例化
- [x] **T2.3.2** 验证 loginAttempts Map 初始化
- [x] **T2.3.3** 验证 isLocked 返回 false（无记录时）
- [x] **T2.3.4** 验证 recordFailedAttempt 返回剩余次数
- [x] **T2.3.5** 验证 5 次失败后被锁定
- [x] **T2.3.6** 验证 clearAttempts 清除记录

---

## 模块三：服务端在线登录 API 测试 ✅ (9/9 通过)

### 3.1 在线登录端点
- [x] **T3.1.1** 验证 `/api/auth/online-login` 端点存在
- [x] **T3.1.2** 验证调用 verifyOnlineCredentials
- [x] **T3.1.3** 验证登录成功设置 session.authenticated
- [x] **T3.1.4** 验证登录成功设置 session.onlineAuth
- [x] **T3.1.5** 验证检查 IP 锁定状态
- [x] **T3.1.6** 验证失败时记录尝试次数
- [x] **T3.1.7** 验证成功时清除尝试记录
- [x] **T3.1.8** 验证返回 429 状态码（被锁定时）
- [x] **T3.1.9** 验证返回剩余尝试次数

---

## 模块四：前端登录界面测试 ✅ (7/7 通过)

### 4.1 登录表单
- [x] **T4.1.1** 验证 LoginPage 组件使用邮箱字段
- [x] **T4.1.2** 验证 useAuth Hook 包含 onlineLogin 方法
- [x] **T4.1.3** 验证登录表单调用 onlineLogin
- [x] **T4.1.4** 验证显示剩余尝试次数
- [x] **T4.1.5** 验证有注册链接
- [x] **T4.1.6** 验证有忘记密码链接
- [x] **T4.1.7** 验证 useAuth 返回 onlineLogin

---

## 测试结果汇总

| 模块 | 总数 | 通过 | 失败 | 通过率 |
|------|------|------|------|--------|
| 订阅服务器 API | 9 | 9 | 0 | 100% |
| 客户端 AuthService | 12 | 12 | 0 | 100% |
| 服务端在线登录 API | 9 | 9 | 0 | 100% |
| 前端登录界面 | 7 | 7 | 0 | 100% |
| **总计** | **37** | **37** | **0** | **100%** |

---

## Bug 记录

| Bug ID | 模块 | 描述 | 状态 | 修复方案 |
|--------|------|------|------|----------|
| - | - | 无 Bug 发现 | - | - |

---

## 测试脚本清单

| 脚本 | 路径 | 说明 |
|------|------|------|
| 订阅服务器 API 测试 | `tests/test-remote-auth-subscription.mjs` | 测试注册和凭据验证 API |
| 客户端 AuthService 测试 | `tests/test-remote-auth-client.mjs` | 测试在线验证和速率限制 |
| 服务端在线登录 API 测试 | `tests/test-remote-auth-server.mjs` | 测试在线登录端点 |
| 前端登录界面测试 | `tests/test-remote-auth-frontend.mjs` | 测试登录表单和 useAuth Hook |

---

## 运行测试

```bash
# 运行所有远程认证测试
node tests/test-remote-auth-subscription.mjs
node tests/test-remote-auth-client.mjs
node tests/test-remote-auth-server.mjs
node tests/test-remote-auth-frontend.mjs
```


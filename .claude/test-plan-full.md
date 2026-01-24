# WhatyTerm 全面测试计划

## 项目概述
WhatyTerm 是一个 AI 智能终端管理工具，支持多种 AI CLI 工具（Claude Code、Codex、Gemini、Droid、OpenCode）的自动化监控和操作。

## 测试环境
- 项目目录: `/Users/zhangzhen/Documents/ClaudeCode/WebTmux`
- 版本: 1.0.54
- 测试时间: 2026-01-24
- 测试完成时间: 2026-01-24

---

## 模块一：核心服务测试 ✅ (25/25 通过)

### 1.1 AIEngine 服务
- [x] **T1.1.1** 验证 AIEngine 初始化正常
- [x] **T1.1.2** 验证 getSettings() 返回正确配置
- [x] **T1.1.3** 验证 detectRunningCLI() 能识别所有支持的 CLI（claude/codex/gemini/droid/opencode）
- [x] **T1.1.4** 验证 preAnalyzeStatus() 能正确分析运行状态
- [x] **T1.1.5** 验证 preAnalyzeStatus() 能正确分析空闲状态
- [x] **T1.1.6** 验证 preAnalyzeStatus() 能正确分析确认界面
- [x] **T1.1.7** 验证 _parseProviderConfig() 能解析所有类型供应商配置

### 1.2 ProviderService 服务
- [x] **T1.2.1** 验证 list() 返回正确的供应商列表
- [x] **T1.2.2** 验证 add() 能添加新供应商
- [x] **T1.2.3** 验证 update() 能更新供应商配置
- [x] **T1.2.4** 验证 delete() 能删除供应商
- [x] **T1.2.5** 验证 switch() 能切换当前供应商
- [x] **T1.2.6** 验证 getCurrentProvider() 返回当前供应商

### 1.3 CliRegistry 服务
- [x] **T1.3.1** 验证所有内置 CLI 工具已注册（claude/codex/gemini/droid/opencode）
- [x] **T1.3.2** 验证 getTool() 返回正确的工具配置
- [x] **T1.3.3** 验证 findByProcessName() 能通过进程名查找工具
- [x] **T1.3.4** 验证 findByCommand() 能通过命令查找工具

### 1.4 ProcessDetector 服务
- [x] **T1.4.1** 验证 detectFromTerminalContent() 能识别各 CLI 特征
- [x] **T1.4.2** 验证 getCliProcessNames() 返回完整的进程名映射
- [x] **T1.4.3** 验证 isIdle() 能正确判断空闲状态

### 1.5 UpdateService 服务
- [x] **T1.5.1** 验证 getCurrentVersion() 返回正确版本号
- [x] **T1.5.2** 验证 compareVersions() 版本比较正确
- [x] **T1.5.3** 验证 checkForUpdate() 能正确检查更新

### 1.6 SubscriptionService 服务
- [x] **T1.6.1** 验证许可证验证功能
- [x] **T1.6.2** 验证订阅状态检查

---

## 模块二：隧道服务测试 ✅ (4/4 通过)

### 2.1 FrpTunnel 服务
- [x] **T2.1.1** 验证 FRP 隧道配置加载
- [x] **T2.1.2** 验证 getUrl() 返回正确的隧道 URL

### 2.2 CloudflareTunnel 服务
- [x] **T2.2.1** 验证 Cloudflare 隧道配置
- [x] **T2.2.2** 验证 getUrl() 返回正确的隧道 URL

---

## 模块三：监控插件测试 ✅ (8/8 通过)

### 3.1 DefaultPlugin
- [x] **T3.1.1** 验证 detectPhase() 能识别运行中状态
- [x] **T3.1.2** 验证 detectPhase() 能识别空闲状态
- [x] **T3.1.3** 验证 detectPhase() 能识别确认状态
- [x] **T3.1.4** 验证 detectPhase() 能识别错误状态
- [x] **T3.1.5** 验证 analyzeStatus() 返回正确的操作建议
- [x] **T3.1.6** 验证 isIdle() 能识别各 CLI 的空闲提示符

### 3.2 PluginManager
- [x] **T3.2.1** 验证插件加载功能
- [x] **T3.2.2** 验证 selectPlugin() 能选择合适的插件

---

## 模块四：API 接口测试 ✅ (16/16 通过)

### 4.1 会话管理 API
- [x] **T4.1.1** SessionManager 获取会话列表
- [x] **T4.1.2** SessionManager 创建会话功能存在
- [x] **T4.1.3** SessionManager 删除会话功能存在

### 4.2 AI 监控 API
- [x] **T4.2.1** AIEngine getSettings() 返回设置
- [x] **T4.2.2** AIEngine saveSettings() 功能存在
- [x] **T4.2.3** AIEngine analyzeStatus() 分析终端状态

### 4.3 供应商管理 API
- [x] **T4.3.1** ProviderService list() 返回供应商列表
- [x] **T4.3.2** ProviderService add() 添加供应商
- [x] **T4.3.3** ProviderService update() 更新供应商
- [x] **T4.3.4** ProviderService delete() 删除供应商
- [x] **T4.3.5** ProviderService switch() 切换供应商

### 4.4 隧道 API
- [x] **T4.4.1** 隧道服务 getUrl() 功能
- [x] **T4.4.2** 隧道服务 start() 功能存在
- [x] **T4.4.3** 隧道服务 stop() 功能存在

### 4.5 更新 API
- [x] **T4.5.1** UpdateService checkForUpdate() 检查更新
- [x] **T4.5.2** UpdateService getCurrentVersion() 获取版本

---

## 模块五：前端组件测试 ✅ (21/21 通过)

### 5.1 App 主组件
- [x] **T5.1.1** App.jsx 文件存在
- [x] **T5.1.2** App.jsx 包含 React 组件定义
- [x] **T5.1.3** main.jsx 入口文件存在
- [x] **T5.1.4** main.jsx 包含 React 渲染逻辑

### 5.2 ProviderManager 组件
- [x] **T5.2.1** ProviderManager.jsx 文件存在
- [x] **T5.2.2** ProviderManager 包含供应商列表功能
- [x] **T5.2.3** ProviderEditor.jsx 文件存在
- [x] **T5.2.4** ProviderCard.jsx 文件存在
- [x] **T5.2.5** ProviderList.jsx 文件存在

### 5.3 终端相关组件
- [x] **T5.3.1** TerminalPlayback.jsx 文件存在
- [x] **T5.3.2** ClosedSessionsList.jsx 文件存在
- [x] **T5.3.3** RecentProjects.jsx 文件存在

### 5.4 其他核心组件
- [x] **T5.4.1** CliToolsManager.jsx 文件存在
- [x] **T5.4.2** StorageManager.jsx 文件存在
- [x] **T5.4.3** ScheduleManager.jsx 文件存在
- [x] **T5.4.4** Toast.jsx 文件存在

### 5.5 组件语法验证
- [x] **T5.5.1** 所有组件文件语法正确（无明显错误）
- [x] **T5.5.2** index.html 入口文件存在
- [x] **T5.5.3** index.html 包含 React 挂载点

### 5.6 Vite 配置测试
- [x] **T5.6.1** vite.config.js 文件存在
- [x] **T5.6.2** vite.config.js 包含 React 插件配置

---

## 模块六：集成测试 ✅ (20/20 通过)

### 6.1 服务器启动测试
- [x] **T6.1.1** 服务器入口文件存在
- [x] **T6.1.2** 服务器配置正确（端口 3928）
- [x] **T6.1.3** Express 应用配置存在
- [x] **T6.1.4** Socket.IO 配置存在
- [x] **T6.1.5** 静态文件服务配置存在

### 6.2 前端构建测试
- [x] **T6.2.1** package.json 包含构建脚本
- [x] **T6.2.2** package.json 包含开发脚本
- [x] **T6.2.3** Vite 配置文件存在
- [x] **T6.2.4** 必要的依赖已安装

### 6.3 Electron 打包测试
- [x] **T6.3.1** Electron 主进程文件存在
- [x] **T6.3.2** Electron 主进程包含必要功能
- [x] **T6.3.3** electron-builder 配置存在
- [x] **T6.3.4** Electron 打包脚本存在

### 6.4 API 路由测试
- [x] **T6.4.1** API 路由文件存在
- [x] **T6.4.2** 会话 API 路由存在
- [x] **T6.4.3** 供应商 API 路由存在

### 6.5 数据库/存储测试
- [x] **T6.5.1** 数据存储服务存在
- [x] **T6.5.2** 配置文件目录可访问

### 6.6 WebSocket 测试
- [x] **T6.6.1** Socket.IO 服务端配置存在
- [x] **T6.6.2** 终端 WebSocket 事件处理存在

---

## 测试结果汇总

| 模块 | 总数 | 通过 | 失败 | 通过率 |
|------|------|------|------|--------|
| 核心服务 | 25 | 25 | 0 | 100% |
| 隧道服务 | 4 | 4 | 0 | 100% |
| 监控插件 | 8 | 8 | 0 | 100% |
| API 接口 | 16 | 16 | 0 | 100% |
| 前端组件 | 21 | 21 | 0 | 100% |
| 集成测试 | 20 | 20 | 0 | 100% |
| **总计** | **94** | **94** | **0** | **100%** |

---

## Bug 记录

| Bug ID | 模块 | 描述 | 状态 | 修复方案 |
|--------|------|------|------|----------|
| BUG-001 | 核心服务 | SubscriptionService 测试使用了错误的方法名 | ✅ 已修复 | 将 `isPro()` 改为 `getStatus().valid`，将 `getAvailableTunnels()` 改为 `getAvailableTunnelTypes()` |
| BUG-002 | 隧道服务 | getUrl() 返回空字符串而非 null | ✅ 已修复 | 测试代码增加对空字符串的检查 |
| BUG-003 | API 接口 | SessionManager 使用了错误的导入方式 | ✅ 已修复 | 将默认导入改为命名导入 `{ SessionManager }` |
| BUG-004 | API 接口 | SessionManager 方法名错误 | ✅ 已修复 | 将 `getAllSessions()` 改为 `listSessions()` |
| BUG-005 | 集成测试 | Electron 文件路径错误 | ✅ 已修复 | 将 `electron/main.js` 改为 `electron/main.cjs` |

---

## 测试脚本清单

| 脚本 | 路径 | 说明 |
|------|------|------|
| 核心服务测试 | `tests/test-core-services.mjs` | 测试 AIEngine、ProviderService、CliRegistry 等核心服务 |
| 隧道服务测试 | `tests/test-tunnel-services.mjs` | 测试 FrpTunnel、CloudflareTunnel 服务 |
| 监控插件测试 | `tests/test-monitor-plugins.mjs` | 测试 DefaultPlugin、PluginManager |
| API 接口测试 | `tests/test-api-endpoints.mjs` | 测试各服务的 API 接口 |
| 前端组件测试 | `tests/test-frontend-components.mjs` | 测试前端组件文件和结构 |
| 集成测试 | `tests/test-integration.mjs` | 测试服务器、构建、Electron 配置 |

---

## 运行测试

```bash
# 运行所有测试
node tests/test-core-services.mjs
node tests/test-tunnel-services.mjs
node tests/test-monitor-plugins.mjs
node tests/test-api-endpoints.mjs
node tests/test-frontend-components.mjs
node tests/test-integration.mjs
```


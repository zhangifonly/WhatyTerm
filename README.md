# WhatyTerm

AI 智能终端管理工具，让 AI 帮你操作终端。

开源免费，个人用户可使用全部功能。

## 功能

### 终端管理
- 基于 xterm.js 的现代化 Web 终端
- 多会话管理（创建、附加、分离、关闭）
- 完整的输入输出历史记录，支持回放和导出

### AI 智能监控
- 自动识别终端状态（空闲、运行中、等待输入、错误、确认等）
- 基于 Claude API 的智能决策引擎
- 16 个专业监控策略插件，自动匹配项目类型：

| 策略 | 说明 |
|------|------|
| Default | 通用策略 |
| FullStackDev | 全栈开发 |
| AppDev | App 开发 |
| FrontendDesign | 前端设计 |
| BugFix | Bug 修复 |
| CodeReview | 代码审查 |
| Refactoring | 重构优化 |
| TDDDevelopment | 测试驱动开发 |
| APIIntegration | API 集成 |
| DataAnalysis | 数据分析 |
| Deployment | 部署运维 |
| SecurityAudit | 安全审计 |
| PaperWriting | 论文写作 |
| ScientificResearch | 科学研究 |
| DocumentProcessing | 文档处理 |
| PlanExecution | 计划执行 |

### Team 模式
- 多个 AI Agent 协同工作
- 任务分解、分配和依赖管理
- Agent 间通信和协调

### 远程访问
- FRP 内网穿透（固定域名）
- Cloudflare Tunnel（免费用户可用）

## 平台支持

| 平台 | 架构 | 格式 |
|------|------|------|
| macOS | Intel | DMG |
| macOS | Apple Silicon (M1/M2/M3/M4) | DMG |
| Windows | x64 | EXE |

下载地址：https://term.whaty.org

## 技术栈

- 前端：React 18 + Vite + Tailwind CSS + xterm.js
- 后端：Express + Socket.IO + node-pty + better-sqlite3
- 桌面端：Electron
- AI：Anthropic Claude API

## 快速开始

### 环境要求

- Node.js 20+
- macOS / Windows / Linux

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
npm run dev
```

前端默认端口 5050，后端默认端口 3928。

### 构建

```bash
# 构建前端
npm run build

# 构建 macOS 安装包
npm run electron:build:mac

# 构建 Windows 安装包
npm run electron:build:win

# 构建全平台
npm run electron:build:all
```

## 项目结构

```
├── src/                    # 前端 (React)
│   ├── App.jsx
│   └── components/
├── server/                 # 后端
│   ├── index.js            # 服务入口
│   └── services/
│       ├── AIEngine.js     # AI 决策引擎
│       ├── SessionManager.js
│       ├── TeamManager.js  # Team 协作
│       ├── MonitorPlugins/ # 监控策略插件
│       ├── FrpTunnel.js    # FRP 隧道
│       └── CloudflareTunnel.js
├── electron/               # Electron 主进程
├── subscription-server/    # 订阅服务
└── scripts/                # 构建脚本
```

## 定价

| | 个人版 | 企业版 |
|---|---|---|
| 价格 | 免费 | ¥29/人/月 |
| 全部监控策略 | ✓ | ✓ |
| AI 智能分析 | ✓ | ✓ |
| 设备数 | 3 台 | 不限 |
| 专属中转服务器 | - | ✓ |
| 专属技术支持 | - | ✓ |
| 定制功能 | - | ✓ |

## License

[MIT](LICENSE)

## 联系

- 官网：https://term.whaty.org
- 邮箱：zhangzhen@gmail.com

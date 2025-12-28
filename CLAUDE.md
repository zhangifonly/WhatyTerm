# WebTmux 开发规则

## Claude Code 输入规则（重要！）

向 Claude Code 发送文本输入时，**必须分两次发送**：

1. 先发送文本内容（如 `"继续"`）
2. 延迟 50ms 后再发送回车 `"\r"`

**错误做法**：
```javascript
// 不工作！Claude Code 不会识别
session.write('继续\r');
session.write('继续\r\n');
```

**正确做法**：
```javascript
// 分开发送，模拟人工输入
session.write('继续');
setTimeout(() => {
  session.write('\r');
}, 50);
```

**原因**：Claude Code 使用 Ink 框架的 TextInput 组件，它期望文本和回车作为独立的输入事件。

## 单字符操作

对于单字符操作（如 `y`、`n`、`1`、`2` 等选择），可以直接发送，不需要回车：
```javascript
session.write('y');  // 直接发送，不加回车
session.write('2');  // 选择选项 2
```

## 特殊按键

特殊按键直接发送对应的控制字符：
- Enter: `\r`
- Tab: `\t`
- Escape: `\x1b`

## AI 状态分析注意事项

1. **编辑/命令确认界面**（显示选项 1/2/3）：自动选择 "2" 允许本次会话
2. **运行中状态**（显示 `esc to interrupt` 和运行时间）：不要自动操作
3. **开发阶段空闲**（显示 `> ` 且内容涉及代码编写）：发送 `继续`
4. **部署/脚本阶段**（涉及 npm run、启动服务、测试等）：不自动操作，提醒用户检查未完成项目
5. **Claude Code 致命错误**：发送 `/quit` 退出
6. **Shell 命令行**（Claude Code 退出后）：发送 `claude -c` 重新启动并继续开发

## Claude Code 工作目录

工作目录是启动 `claude` 命令时所在的路径，AI 应从终端内容中提取，不要猜测。

## Claude Code 错误恢复流程

1. 检测到致命错误 → 发送 `/quit` 退出
2. 回到 shell 命令行 → 发送 `claude -c` 继续开发

## 动态检测周期

为节约 AI 监测成本，检测周期会动态调整：

- **有操作时**：重置为最小间隔 15 秒
- **无操作时**：间隔翻倍，最大 30 分钟
- **检测日志**：记录每次检测的结果和下次间隔

周期变化示例：15秒 → 30秒 → 1分钟 → 2分钟 → 4分钟 → 8分钟 → 16分钟 → 30分钟（最大）

## Claude Relay Service 伪装要求（重要！）

当 WebTmux 的 AI 引擎调用 **CC Switch 中的 Claude 类型供应商**时，必须伪装成 Claude Code 请求，以绑过 Claude Relay Service 的客户端限制。

### 伪装要素

**请求头**：
```javascript
headers: {
  'User-Agent': 'claude-cli/2.0.69 (external, cli)',
  'x-app': 'cli',
  'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14',
  'anthropic-version': '2023-06-01',
  'Authorization': `Bearer ${token}`
}
```

**请求体必需字段**：
```javascript
body: {
  model: 'claude-sonnet-4-20250514',
  system: [{
    type: 'text',
    text: "You are Claude Code, Anthropic's official CLI for Claude."
  }],
  messages: [...],
  metadata: {
    user_id: `user_${64位十六进制哈希}_account__session_${UUID}`
  }
}
```

### 适用场景

- CC Switch 中 `app_type = 'claude'` 的供应商
- API URL 包含 `/api/v1/messages` 的 Claude Relay Service

### 参考实现

- 测试脚本：`test-claude-code-fake.js`
- 已实现位置：`server/services/AIEngine.js` 的 `_callClaudeApi` 方法

## 版本发布流程

每次发布新版本时，需要执行以下步骤：

### 1. 更新版本号并提交

```bash
# 修改 package.json 中的 version 字段
# 提交代码
git add -A && git commit -m "版本更新至 x.x.x"
git push
```

### 2. 构建安装包

```bash
# 构建 macOS 安装包（Intel + ARM64）
npm run electron:build:mac

# 构建 Windows 安装包
npm run electron:build:win

# 或一次性构建全部
npm run electron:build:all
```

构建产物位于 `release/` 目录：
- `WhatyTerm-x.x.x.dmg` - macOS Intel 版
- `WhatyTerm-x.x.x-arm64.dmg` - macOS ARM64 版
- `WhatyTerm Setup x.x.x.exe` - Windows 版

### 3. 上传安装包到服务器

```bash
# 创建版本目录
ssh us-lax02 "mkdir -p /var/www/downloads/whatyterm/vx.x.x"

# 上传文件
scp release/WhatyTerm-x.x.x.dmg us-lax02:/var/www/downloads/whatyterm/vx.x.x/
scp release/WhatyTerm-x.x.x-arm64.dmg us-lax02:/var/www/downloads/whatyterm/vx.x.x/
scp "release/WhatyTerm Setup x.x.x.exe" us-lax02:/var/www/downloads/whatyterm/vx.x.x/
```

### 4. 更新下载页面

```bash
# 更新 ai.whaty.org 下载页面的版本号
ssh us-lax02 "sed -i 's/v旧版本/v新版本/g; s/旧版本/新版本/g' /var/www/downloads/index.html"

# 验证更新
ssh us-lax02 "grep -E 'v[0-9]+\.[0-9]+\.[0-9]+' /var/www/downloads/index.html | head -5"
```

### 下载页面信息

- **网站地址**: https://ai.whaty.org/
- **服务器**: US-LAX02
- **HTML 文件**: `/var/www/downloads/index.html`
- **安装包目录**: `/var/www/downloads/whatyterm/v版本号/`

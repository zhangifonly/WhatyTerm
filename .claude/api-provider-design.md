# WebTmux API Provider 管理系统设计

> 基于 [cc-switch](https://github.com/farion1231/cc-switch) 架构设计
>
> 设计日期：2025-12-11

---

## 一、系统概述

### 1.1 设计目标

- 支持多个 AI API 供应商的配置管理
- 提供健康检查和测速功能
- 支持快速切换供应商
- 为未来 Codex/Gemini CLI 集成预留扩展性
- 替换现有简单的 AI 设置界面

### 1.2 核心功能

1. **供应商管理**：CRUD 操作、预设模板、分类管理
2. **健康检查**：流式 API 测试、延迟测量、状态判定
3. **配置切换**：一键切换当前供应商
4. **端点管理**：多端点配置、测速对比

---

## 二、CC-Switch 核心架构分析

### 2.1 数据层

**SQLite 表结构：**

```sql
-- 供应商表
CREATE TABLE providers (
    id TEXT NOT NULL,
    app_type TEXT NOT NULL,              -- 'claude' | 'codex' | 'gemini'
    name TEXT NOT NULL,
    settings_config TEXT NOT NULL,        -- JSON：环境变量/配置
    website_url TEXT,
    category TEXT,                        -- 'official' | 'cn_official' | 'aggregator' | 'third_party' | 'custom'
    created_at INTEGER,
    sort_index INTEGER,
    notes TEXT,
    icon TEXT,
    icon_color TEXT,
    meta TEXT NOT NULL DEFAULT '{}',      -- JSON：自定义端点、用量脚本等
    is_current BOOLEAN NOT NULL DEFAULT 0,
    is_proxy_target BOOLEAN NOT NULL DEFAULT 0,
    PRIMARY KEY (id, app_type)
);

-- 自定义端点表
CREATE TABLE provider_endpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id TEXT NOT NULL,
    app_type TEXT NOT NULL,
    url TEXT NOT NULL,
    added_at INTEGER,
    FOREIGN KEY (provider_id, app_type) REFERENCES providers(id, app_type) ON DELETE CASCADE
);

-- 健康检查日志表
CREATE TABLE stream_check_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id TEXT NOT NULL,
    provider_name TEXT NOT NULL,
    app_type TEXT NOT NULL,
    status TEXT NOT NULL,                 -- 'operational' | 'degraded' | 'failed'
    success BOOLEAN NOT NULL,
    message TEXT,
    response_time_ms INTEGER,
    http_status INTEGER,
    model_used TEXT,
    tested_at INTEGER NOT NULL,
    retry_count INTEGER NOT NULL DEFAULT 0
);
```

### 2.2 业务逻辑层

**供应商管理服务 (ProviderService)：**

```rust
// 核心方法
- list(app_type) -> 获取所有供应商
- current(app_type) -> 获取当前供应商 ID
- add(app_type, provider) -> 添加供应商
- update(app_type, provider) -> 更新供应商
- delete(app_type, id) -> 删除供应商
- switch(app_type, id) -> 切换供应商
  ├─ 检查代理接管模式
  ├─ Backfill：回填当前 live 配置到旧供应商
  ├─ 更新本地 settings (优先级高于数据库)
  ├─ 更新数据库 is_current
  └─ 写入 live 配置文件
```

**健康检查服务 (StreamCheckService)：**

```rust
// 配置
StreamCheckConfig {
    timeout_secs: 45,
    max_retries: 2,
    degraded_threshold_ms: 6000,
    claude_model: "claude-haiku-4-5-20251001",
    codex_model: "gpt-5.1-codex@low",
    gemini_model: "gemini-3-pro-preview"
}

// 核心逻辑
check_with_retry(app_type, provider, config):
    for attempt in 0..=max_retries:
        result = check_once()
        if success:
            return Ok(result)
        if should_retry(error) && attempt < max_retries:
            continue
        return Err(error)

check_once():
    ├─ 提取 base_url 和 api_key
    ├─ 构建流式请求 (messages: [{"role": "user", "content": "hi"}], max_tokens: 1)
    ├─ 发送请求并计时
    ├─ 读取首个 chunk 即判定成功
    └─ 根据延迟判定状态 (operational/degraded/failed)
```

**测速服务 (SpeedtestService)：**

```rust
test_endpoints(urls, timeout):
    for url in urls:
        ├─ 热身请求（忽略结果）
        ├─ 计时请求
        └─ 返回 { url, latency, status, error }
```

### 2.3 预设供应商配置

**claudeProviderPresets.ts (20+ 预设)：**

```typescript
export const providerPresets: ProviderPreset[] = [
  {
    name: "Claude Official",
    websiteUrl: "https://www.anthropic.com/claude-code",
    settingsConfig: { env: {} },
    category: "official",
    theme: { icon: "claude", backgroundColor: "#D97757" }
  },
  {
    name: "DeepSeek",
    websiteUrl: "https://platform.deepseek.com",
    settingsConfig: {
      env: {
        ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
        ANTHROPIC_AUTH_TOKEN: "",
        ANTHROPIC_MODEL: "DeepSeek-V3.2"
      }
    },
    category: "cn_official"
  },
  // ... 更多预设
];
```

---

## 三、WebTmux 适配方案

### 3.1 架构对比

| 功能层 | CC-Switch | WebTmux |
|--------|-----------|---------|
| **前端框架** | React (Tauri) | React (Web) |
| **后端技术** | Rust (Tauri) | Node.js (Express) |
| **数据持久化** | SQLite | JSON 文件 |
| **API 接口** | Tauri Commands | REST API |
| **实时通信** | Tauri Events | Socket.IO |
| **健康检查** | Rust reqwest | Node.js fetch/axios |

### 3.2 数据持久化设计

**文件结构：**

```
server/db/
├── providers.json              # 供应商配置
├── provider-endpoints.json     # 自定义端点
├── provider-check-logs.json    # 健康检查日志
└── provider-config.json        # 系统配置（健康检查参数等）
```

**providers.json 示例：**

```json
{
  "claude": {
    "current": "provider-claude-official",
    "providers": {
      "provider-claude-official": {
        "id": "provider-claude-official",
        "name": "Claude Official",
        "appType": "claude",
        "settingsConfig": {
          "apiType": "claude",
          "claude": {
            "apiUrl": "https://api.anthropic.com/v1/messages",
            "apiKey": "",
            "model": "claude-sonnet-4-5-20250929"
          }
        },
        "category": "official",
        "websiteUrl": "https://www.anthropic.com/claude-code",
        "createdAt": 1702800000000,
        "sortIndex": 0,
        "notes": "",
        "icon": "anthropic",
        "iconColor": "#D4915D",
        "meta": {
          "customEndpoints": {},
          "usageScript": null
        }
      },
      "provider-agent-ai": {
        "id": "provider-agent-ai",
        "name": "Agent AI",
        "appType": "claude",
        "settingsConfig": {
          "apiType": "openai",
          "openai": {
            "apiUrl": "https://agent-ai.webtrn.cn/v1/chat/completions",
            "apiKey": "",
            "model": "opus"
          }
        },
        "category": "aggregator",
        "websiteUrl": "https://agent-ai.webtrn.cn",
        "createdAt": 1702800100000,
        "sortIndex": 1,
        "notes": "按照 APInew.md 要求配置",
        "icon": "generic",
        "iconColor": "#6366F1",
        "meta": {
          "customEndpoints": {
            "https://agent-ai.webtrn.cn/v1/chat/completions": {
              "url": "https://agent-ai.webtrn.cn/v1/chat/completions",
              "addedAt": 1702800100000,
              "lastUsed": 1702800200000
            }
          }
        }
      }
    }
  },
  "codex": {
    "current": null,
    "providers": {}
  },
  "gemini": {
    "current": null,
    "providers": {}
  }
}
```

### 3.3 API 接口设计

**REST API 端点：**

```
Provider 管理
--------------
GET    /api/providers/:appType                  获取所有供应商
GET    /api/providers/:appType/current          获取当前供应商
POST   /api/providers/:appType                  添加供应商
PUT    /api/providers/:appType/:id              更新供应商
DELETE /api/providers/:appType/:id              删除供应商
POST   /api/providers/:appType/:id/switch       切换供应商
PUT    /api/providers/:appType/sort-order       批量更新排序

预设模板
--------------
GET    /api/providers/presets                   获取所有预设模板

健康检查
--------------
POST   /api/providers/:appType/:id/health-check 单个供应商健康检查
POST   /api/providers/:appType/health-check-all 批量健康检查
GET    /api/providers/:appType/:id/check-logs   获取检查日志

端点管理
--------------
GET    /api/providers/:appType/:id/endpoints    获取自定义端点
POST   /api/providers/:appType/:id/endpoints    添加端点
DELETE /api/providers/:appType/:id/endpoints    删除端点
POST   /api/providers/endpoints/speedtest       测速多个端点

配置管理
--------------
GET    /api/providers/config/health-check       获取健康检查配置
PUT    /api/providers/config/health-check       更新健康检查配置
```

**Socket.IO 事件：**

```
发送事件 (Server -> Client)
---------------------------
provider:switched                 供应商切换完成
provider:added                    供应商添加完成
provider:updated                  供应商更新完成
provider:deleted                  供应商删除完成
provider:health-check:progress    健康检查进度更新
provider:health-check:complete    健康检查完成

接收事件 (Client -> Server)
---------------------------
provider:subscribe                订阅供应商更新
provider:unsubscribe              取消订阅
```

### 3.4 健康检查实现

**Node.js 实现（基于 cc-switch 逻辑）：**

```javascript
// server/services/ProviderHealthCheck.js

class ProviderHealthCheck {
  constructor(config = {}) {
    this.config = {
      timeoutSecs: config.timeoutSecs || 45,
      maxRetries: config.maxRetries || 2,
      degradedThresholdMs: config.degradedThresholdMs || 6000,
      testModels: {
        claude: 'claude-haiku-4-5-20251001',
        codex: 'gpt-5.1-codex@low',
        gemini: 'gemini-3-pro-preview'
      }
    };
  }

  async checkWithRetry(appType, provider) {
    let lastError = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const result = await this.checkOnce(appType, provider);

        if (result.success) {
          return { ...result, retryCount: attempt };
        }

        if (this.shouldRetry(result.message) && attempt < this.config.maxRetries) {
          lastError = result;
          continue;
        }

        return { ...result, retryCount: attempt };
      } catch (error) {
        if (this.shouldRetry(error.message) && attempt < this.config.maxRetries) {
          lastError = error;
          continue;
        }

        throw error;
      }
    }

    throw lastError || new Error('检查失败');
  }

  async checkOnce(appType, provider) {
    const startTime = Date.now();
    const testModel = this.config.testModels[appType];

    try {
      let result;

      switch (appType) {
        case 'claude':
          result = await this.checkClaudeStream(provider, testModel);
          break;
        case 'codex':
          result = await this.checkCodexStream(provider, testModel);
          break;
        case 'gemini':
          result = await this.checkGeminiStream(provider, testModel);
          break;
        default:
          throw new Error(`不支持的应用类型: ${appType}`);
      }

      const responseTime = Date.now() - startTime;
      const status = this.determineStatus(responseTime);

      return {
        status,
        success: true,
        message: '检查成功',
        responseTimeMs: responseTime,
        httpStatus: result.statusCode,
        modelUsed: testModel,
        testedAt: Date.now(),
        retryCount: 0
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;

      return {
        status: 'failed',
        success: false,
        message: error.message,
        responseTimeMs: responseTime,
        httpStatus: null,
        modelUsed: testModel,
        testedAt: Date.now(),
        retryCount: 0
      };
    }
  }

  async checkClaudeStream(provider, model) {
    const config = provider.settingsConfig.claude;
    const baseUrl = config.apiUrl.replace(/\/messages$/, '');
    const url = `${baseUrl}/messages`;

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutSecs * 1000
    );

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
          stream: true
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      // 流式读取：只需首个 chunk
      const reader = response.body.getReader();
      const { value } = await reader.read();
      reader.releaseLock();

      if (!value) {
        throw new Error('未收到响应数据');
      }

      return { statusCode: response.status };
    } finally {
      clearTimeout(timeout);
    }
  }

  async checkCodexStream(provider, model) {
    const config = provider.settingsConfig.openai;
    const url = config.apiUrl;

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutSecs * 1000
    );

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: 'system', content: '' },
            { role: 'assistant', content: '' },
            { role: 'user', content: 'hi' }
          ],
          max_tokens: 1,
          temperature: 0,
          stream: true
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      // 流式读取：只需首个 chunk
      const reader = response.body.getReader();
      const { value } = await reader.read();
      reader.releaseLock();

      if (!value) {
        throw new Error('未收到响应数据');
      }

      return { statusCode: response.status };
    } finally {
      clearTimeout(timeout);
    }
  }

  async checkGeminiStream(provider, model) {
    // 与 checkCodexStream 类似
    // ...
  }

  determineStatus(latencyMs) {
    if (latencyMs <= this.config.degradedThresholdMs) {
      return 'operational';
    } else {
      return 'degraded';
    }
  }

  shouldRetry(message) {
    const lower = message.toLowerCase();
    return (
      lower.includes('timeout') ||
      lower.includes('abort') ||
      lower.includes('中断') ||
      lower.includes('超时')
    );
  }
}

module.exports = ProviderHealthCheck;
```

### 3.5 前端 UI 设计

**组件结构：**

```
src/components/ProviderManager/
├── ProviderList.jsx              # 供应商列表
├── ProviderCard.jsx              # 供应商卡片
├── ProviderEditor.jsx            # 供应商编辑器
├── ProviderPresets.jsx           # 预设模板选择器
├── HealthCheckButton.jsx         # 健康检查按钮
├── HealthCheckResult.jsx         # 健康检查结果显示
├── EndpointManager.jsx           # 端点管理
├── EndpointSpeedtest.jsx         # 端点测速
└── ProviderSwitcher.jsx          # 快速切换器
```

**主要交互流程：**

1. **查看供应商列表**
   - 加载所有供应商（按 sortIndex 排序）
   - 显示当前激活的供应商（高亮标识）
   - 显示分类标签（官方/国产/聚合/第三方/自定义）

2. **添加供应商**
   - 方式1：从预设模板选择 → 填写 API Key → 保存
   - 方式2：手动创建 → 填写完整配置 → 保存
   - 自动分配 ID (`provider-${timestamp}`)

3. **编辑供应商**
   - 修改名称、URL、API Key、模型配置
   - 管理自定义端点
   - 配置用量查询脚本（未来）

4. **切换供应商**
   - 点击"切换"按钮 → 确认对话框 → 调用切换 API
   - Socket.IO 实时通知切换完成
   - AIEngine 自动重载配置

5. **健康检查**
   - 单个供应商：点击"测试"按钮 → 显示进度 → 显示结果（延迟、状态）
   - 批量检查：点击"全部测试" → 并发检查 → 显示结果列表

6. **端点管理**
   - 添加自定义端点 → 输入 URL → 保存
   - 测速对比 → 选择多个端点 → 并发测速 → 显示延迟排序
   - 选择最快端点 → 自动更新配置

---

## 四、实施计划

### 4.1 Phase 1: 后端基础（优先）

- [ ] 创建 JSON 数据文件结构
- [ ] 实现 ProviderService（CRUD + 切换）
- [ ] 实现 ProviderHealthCheck 服务
- [ ] 实现 SpeedtestService 服务
- [ ] 创建 REST API 路由
- [ ] 实现 Socket.IO 事件推送

### 4.2 Phase 2: 预设配置

- [ ] 迁移 claudeProviderPresets.ts 到 WebTmux
- [ ] 调整配置格式适配现有 AIEngine
- [ ] 添加 APInew.md 中的供应商预设

### 4.3 Phase 3: 前端 UI

- [ ] 实现 ProviderList 和 ProviderCard
- [ ] 实现 ProviderEditor（添加/编辑）
- [ ] 实现 ProviderPresets 选择器
- [ ] 实现 HealthCheck 功能组件
- [ ] 实现 EndpointManager 和测速

### 4.4 Phase 4: 集成与测试

- [ ] 集成到现有 AI 设置页面
- [ ] AIEngine 适配多供应商配置
- [ ] Socket.IO 实时更新测试
- [ ] 端到端功能测试

### 4.5 Phase 5: 扩展功能（未来）

- [ ] 用量查询脚本支持
- [ ] Codex CLI 集成
- [ ] Gemini CLI 集成
- [ ] 供应商分组和标签
- [ ] 历史检查记录可视化

---

## 五、关键技术细节

### 5.1 配置迁移策略

**当前 AI 设置格式：**

```json
{
  "apiType": "openai",
  "openai": {
    "apiUrl": "https://agent-ai.webtrn.cn/v1/chat/completions",
    "apiKey": "",
    "model": "opus"
  },
  "claude": {
    "apiUrl": "https://api.anthropic.com/v1/messages",
    "apiKey": "",
    "model": "claude-sonnet-4-5-20250929"
  }
}
```

**新 Provider 格式：**

```json
{
  "id": "provider-xxx",
  "name": "Agent AI",
  "appType": "claude",
  "settingsConfig": {
    "apiType": "openai",
    "openai": {
      "apiUrl": "https://agent-ai.webtrn.cn/v1/chat/completions",
      "apiKey": "",
      "model": "opus"
    }
  }
}
```

**迁移逻辑：**

```javascript
function migrateFromOldSettings(oldSettings) {
  const providers = [];

  // 创建默认供应商
  if (oldSettings.apiType === 'openai' && oldSettings.openai.apiUrl) {
    providers.push({
      id: 'provider-migrated-openai',
      name: '迁移的 OpenAI 配置',
      appType: 'claude',
      settingsConfig: {
        apiType: 'openai',
        openai: oldSettings.openai
      },
      category: 'custom',
      createdAt: Date.now(),
      isCurrent: true
    });
  } else if (oldSettings.apiType === 'claude' && oldSettings.claude.apiUrl) {
    providers.push({
      id: 'provider-migrated-claude',
      name: '迁移的 Claude 配置',
      appType: 'claude',
      settingsConfig: {
        apiType: 'claude',
        claude: oldSettings.claude
      },
      category: 'official',
      createdAt: Date.now(),
      isCurrent: true
    });
  }

  return providers;
}
```

### 5.2 AIEngine 适配

**修改 AIEngine.js：**

```javascript
// 当前方式：读取 ai-settings.json
const settings = JSON.parse(fs.readFileSync('server/db/ai-settings.json'));

// 新方式：读取当前 Provider
const providers = JSON.parse(fs.readFileSync('server/db/providers.json'));
const currentProvider = providers.claude.providers[providers.claude.current];
const settings = currentProvider.settingsConfig;

// 其余逻辑保持不变
```

### 5.3 Socket.IO 推送机制

```javascript
// server/services/ProviderService.js

class ProviderService {
  constructor(io) {
    this.io = io;
  }

  async switch(appType, providerId) {
    // ... 切换逻辑 ...

    // 推送事件
    this.io.emit('provider:switched', {
      appType,
      providerId,
      provider: newProvider
    });
  }

  async runHealthCheck(appType, providerId) {
    // 推送进度
    this.io.emit('provider:health-check:progress', {
      appType,
      providerId,
      progress: 0.5
    });

    const result = await this.healthCheck.checkWithRetry(appType, provider);

    // 推送完成
    this.io.emit('provider:health-check:complete', {
      appType,
      providerId,
      result
    });

    return result;
  }
}
```

---

## 六、与现有代码的兼容性

### 6.1 保持向后兼容

- 保留 `ai-settings.json` 作为 fallback（首次运行时迁移）
- AIEngine 支持两种配置读取方式
- 旧的 AI 设置界面保持可用（标记为"传统模式"）

### 6.2 渐进式迁移

1. **阶段1**：新旧系统并存，用户可选
2. **阶段2**：默认使用新系统，旧系统仍可访问
3. **阶段3**：完全移除旧系统

---

## 七、未来扩展方向

### 7.1 Codex CLI 集成

```json
{
  "id": "provider-codex-official",
  "name": "Codex Official",
  "appType": "codex",
  "settingsConfig": {
    "auth": {
      "OPENAI_API_KEY": "sk-xxx"
    },
    "config": "base_url = \"https://api.openai.com/v1\"\nmodel = \"gpt-5.1-codex\""
  }
}
```

### 7.2 Gemini CLI 集成

```json
{
  "id": "provider-gemini-official",
  "name": "Gemini Official",
  "appType": "gemini",
  "settingsConfig": {
    "apiKey": "AIzaSy...",
    "baseUrl": "https://generativelanguage.googleapis.com",
    "model": "gemini-3-pro-preview"
  }
}
```

### 7.3 高级功能

- **自动故障转移**：当前供应商失败时自动切换到备用供应商
- **负载均衡**：在多个供应商间轮询请求
- **成本优化**：根据价格和配额智能选择供应商
- **用量统计**：实时监控每个供应商的调用次数和费用

---

## 八、参考文档

- [cc-switch GitHub](https://github.com/farion1231/cc-switch)
- [WebTmux API.md](/Users/zhangzhen/Documents/ClaudeCode/WebTmux/API.md)
- [WebTmux APInew.md](/Users/zhangzhen/Documents/ClaudeCode/WebTmux/APInew.md)
- [CLAUDE.md 开发准则](/Users/zhangzhen/Documents/ClaudeCode/CLAUDE.md)

# Phase 9: 高级设置（故障转移与定时检查）完成总结

## 完成时间
2025-12-11

## 实现内容

### 1. 高级设置组件（整合版）

**文件**: `src/components/ProviderManager/AdvancedSettings.jsx`

**功能**:
将三个核心配置整合到一个组件中：
- 健康检查配置
- 自动故障转移配置
- 定时健康检查配置

**UI 设计**:
- 三个标签页切换
- 每个功能独立配置
- 开关按钮控制启用/禁用
- 实时配置保存

### 2. 健康检查配置（迁移）

**功能**:
- 超时时间配置（5-120 秒）
- 最大重试次数（0-5 次）
- 降级阈值（1000-30000 毫秒）
- 测试模型配置（Claude、OpenAI）

**默认值**:
```javascript
{
  timeoutSecs: 45,
  maxRetries: 2,
  degradedThresholdMs: 6000,
  testModels: {
    claude: 'claude-haiku-4-5-20251001',
    codex: 'gpt-4o-mini',
    gemini: 'gemini-2.0-flash'
  }
}
```

### 3. 自动故障转移配置

**功能**:
- 启用/禁用开关
- 故障转移最大重试次数（1-10 次）
- 重试延迟（1000-60000 毫秒）
- 自动按 sortIndex 顺序尝试

**配置项**:
```javascript
{
  enabled: false,              // 是否启用
  maxRetries: 3,              // 最大重试次数
  retryDelayMs: 5000,         // 重试延迟
  fallbackOrder: [],          // 优先级顺序（预留）
  excludeFromFailover: []     // 排除列表（预留）
}
```

**故障转移规则**:
1. 按供应商的 sortIndex 顺序依次尝试
2. 跳过当前正在使用的供应商
3. 优先选择最近健康检查成功的供应商
4. 故障转移成功后发送通知

**使用场景**:
- API 配额耗尽时自动切换
- 网络故障时切换到备用供应商
- 服务降级时切换到稳定供应商

### 4. 定时健康检查配置

**功能**:
- 启用/禁用开关
- 检查间隔配置（5-1440 分钟）
- 启动时立即检查选项
- 失败通知选项

**配置项**:
```javascript
{
  enabled: false,             // 是否启用
  intervalMinutes: 30,        // 检查间隔（分钟）
  checkOnStartup: true,       // 启动时检查
  notifyOnFailure: false      // 失败时通知
}
```

**工作流程**:
1. 后台定时器按间隔执行
2. 批量检查所有供应商
3. 记录检查结果到日志
4. 失败时可选通知用户

**注意事项**:
- 会产生 API 调用费用
- 建议使用轻量级测试模型
- 检查间隔不宜过短（建议 15-60 分钟）

## UI 更新

### 高级设置对话框

```
┌─────────────────────────────────────┐
│         高级设置              ×     │
├─────────────────────────────────────┤
│ [健康检查] [故障转移] [定时检查]   │
├─────────────────────────────────────┤
│                                     │
│  [当前标签页的配置内容]             │
│                                     │
│  • 健康检查：超时/重试/阈值/模型    │
│  • 故障转移：开关/重试/延迟         │
│  • 定时检查：开关/间隔/选项         │
│                                     │
├─────────────────────────────────────┤
│                    [取消] [保存]    │
└─────────────────────────────────────┘
```

### 配置标签页布局

#### 健康检查标签页
```
超时时间（秒）      [45        ]
最大重试次数        [2         ]
降级阈值（毫秒）    [6000      ]

───────────测试模型───────────
Claude              [claude-haiku-4-5...]
OpenAI              [gpt-4o-mini      ]
```

#### 故障转移标签页
```
┌────────────────────────────────┐
│ 启用自动故障转移           [○] │
│ 当前供应商失败时自动切换        │
└────────────────────────────────┘

故障转移最大重试次数  [3      ]
重试延迟（毫秒）      [5000   ]

💡 故障转移规则
• 按供应商的 sortIndex 顺序依次尝试
• 跳过当前正在使用的供应商
• 优先选择最近健康检查成功的供应商
• 故障转移成功后会发送通知
```

#### 定时检查标签页
```
┌────────────────────────────────┐
│ 启用定时健康检查           [○] │
│ 后台自动定期检查所有供应商      │
└────────────────────────────────┘

检查间隔（分钟）      [30     ]

☑ 服务启动时立即检查
  启动后立即执行一次健康检查

☐ 失败时发送通知
  供应商健康检查失败时通知用户

⚠️ 注意事项
• 定时检查会产生 API 调用费用
• 建议使用轻量级测试模型
• 检查间隔不宜过短
```

## 文件变更清单

### 新增文件
- `src/components/ProviderManager/AdvancedSettings.jsx` - 高级设置组件（整合版）

### 修改文件
- `src/components/ProviderManager/ProviderManager.jsx`
  - 导入 AdvancedSettings 替换 HealthCheckConfig
  - 更新设置弹窗渲染

### 废弃文件
- `src/components/ProviderManager/HealthCheckConfig.jsx` - 功能已迁移到 AdvancedSettings

## API 需求

### 新增 API 端点
```
GET  /api/providers/config/failover
获取故障转移配置

PUT  /api/providers/config/failover
保存故障转移配置
请求体:
{
  "enabled": true,
  "maxRetries": 3,
  "retryDelayMs": 5000,
  "fallbackOrder": [],
  "excludeFromFailover": []
}

GET  /api/providers/config/scheduler
获取定时检查配置

PUT  /api/providers/config/scheduler
保存定时检查配置
请求体:
{
  "enabled": true,
  "intervalMinutes": 30,
  "checkOnStartup": true,
  "notifyOnFailure": false
}
```

### 现有 API（复用）
```
GET  /api/providers/config/health-check
PUT  /api/providers/config/health-check
```

## 后端实现需求

### 1. 故障转移逻辑（AIEngine）

需要在 AIEngine 中实现：
```javascript
class AIEngine {
  async callWithFailover(prompt, options) {
    let retries = 0;
    const maxRetries = this.failoverConfig.maxRetries;
    const delay = this.failoverConfig.retryDelayMs;

    while (retries < maxRetries) {
      try {
        return await this.call(prompt, options);
      } catch (error) {
        if (!this.failoverConfig.enabled) throw error;

        // 尝试切换到下一个可用供应商
        const switched = await this.switchToNextProvider();
        if (!switched) throw error;

        retries++;
        if (retries < maxRetries) {
          await sleep(delay);
        }
      }
    }

    throw new Error('All failover attempts failed');
  }

  async switchToNextProvider() {
    // 获取所有供应商，按 sortIndex 排序
    // 跳过当前供应商
    // 选择第一个可用的供应商
    // 调用 ProviderService.switch()
  }
}
```

### 2. 定时检查调度器（后端服务）

需要创建新服务：
```javascript
class HealthCheckScheduler {
  constructor(providerService, healthCheckService) {
    this.providerService = providerService;
    this.healthCheckService = healthCheckService;
    this.config = {};
    this.timer = null;
  }

  async loadConfig() {
    // 从数据库加载配置
  }

  start() {
    if (!this.config.enabled) return;

    if (this.config.checkOnStartup) {
      this.runCheck();
    }

    // 设置定时器
    this.timer = setInterval(
      () => this.runCheck(),
      this.config.intervalMinutes * 60 * 1000
    );
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runCheck() {
    // 批量检查所有供应商
    const results = await this.healthCheckService.checkAll();

    // 记录到日志

    // 失败时通知
    if (this.config.notifyOnFailure) {
      const failures = results.filter(r => !r.success);
      if (failures.length > 0) {
        this.notifyFailures(failures);
      }
    }
  }
}
```

### 3. 配置持久化

需要在数据库中存储：
```sql
CREATE TABLE provider_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER
);

-- 存储 JSON 格式的配置
INSERT INTO provider_config VALUES
  ('failover', '{"enabled":false,...}', ...),
  ('scheduler', '{"enabled":false,...}', ...);
```

## 使用说明

### 配置自动故障转移
1. 点击"设置"按钮
2. 切换到"故障转移"标签页
3. 启用自动故障转移开关
4. 配置重试次数和延迟
5. 点击"保存"

### 配置定时健康检查
1. 点击"设置"按钮
2. 切换到"定时检查"标签页
3. 启用定时健康检查开关
4. 设置检查间隔（建议 30 分钟）
5. 选择是否启动时检查和失败通知
6. 点击"保存"

## Phase 9 完成状态

- [x] 创建 AdvancedSettings 组件
- [x] 整合健康检查配置
- [x] 添加故障转移配置 UI
- [x] 添加定时检查配置 UI
- [x] 集成到 ProviderManager

## 待后端实现

- [ ] 故障转移逻辑（AIEngine）
- [ ] 定时检查调度器（后端服务）
- [ ] 配置 API 端点
- [ ] 配置持久化（数据库）
- [ ] 通知系统

## 累计完成功能（Phase 1-9）

### Phase 1-3: 基础架构
- ✅ 供应商 CRUD、预设系统、前端框架

### Phase 4: 集成功能
- ✅ AIEngine 集成、Backfill、端点测速、用量查询

### Phase 5: UI 组件
- ✅ EndpointManager、UsageScriptEditor

### Phase 6: 编辑与批量
- ✅ ProviderEditor、HealthCheckLogs、批量检查

### Phase 7: 配置管理
- ✅ HealthCheckConfig、ImportExport、拖拽排序

### Phase 8: 搜索与验证
- ✅ 克隆、搜索过滤、API Key 验证

### Phase 9: 高级功能
- ✅ 故障转移配置 UI
- ✅ 定时检查配置 UI
- ✅ 高级设置整合

## Provider 管理系统完成度

### 前端完成度: 100%
所有 UI 组件和交互已完成

### 后端完成度: 约 70%
需要实现：
- 故障转移逻辑
- 定时检查调度器
- 配置 API
- 通知系统

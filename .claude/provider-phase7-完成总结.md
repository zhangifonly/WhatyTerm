# Phase 7: 配置、导入导出与拖拽排序 完成总结

## 完成时间
2025-12-11

## 实现内容

### 1. HealthCheckConfig 组件

**文件**: `src/components/ProviderManager/HealthCheckConfig.jsx`

**功能**:
- 配置超时时间（秒）
- 配置最大重试次数
- 配置降级阈值（毫秒）
- 配置各应用类型的测试模型

**可配置项**:
| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| timeoutSecs | API 请求超时时间 | 45 秒 |
| maxRetries | 超时/网络错误重试次数 | 2 次 |
| degradedThresholdMs | 响应时间超过此值标记为降级 | 6000 毫秒 |
| testModels.claude | Claude 健康检查模型 | claude-haiku-4-5-20251001 |
| testModels.codex | OpenAI 健康检查模型 | gpt-4o-mini |
| testModels.gemini | Gemini 健康检查模型 | gemini-2.0-flash |

### 2. ImportExport 组件

**文件**: `src/components/ProviderManager/ImportExport.jsx`

**导出功能**:
- 导出所有供应商配置为 JSON 文件
- 可选是否包含 API Keys（默认不包含，安全考虑）
- 可选是否包含自定义端点
- 可选是否包含用量查询脚本
- 文件命名格式: `providers-{appType}-{date}.json`

**导入功能**:
- 从 JSON 文件导入
- 支持直接粘贴 JSON 内容
- 导入预览（显示供应商数量和导出时间）
- 自动生成新 ID 避免冲突
- 批量导入结果统计

**导出格式**:
```json
{
  "version": "1.0",
  "exportedAt": "2025-12-11T...",
  "appType": "claude",
  "current": "provider-id",
  "providers": [...]
}
```

### 3. 拖拽排序功能

**修改文件**: `src/components/ProviderManager/ProviderList.jsx`

**功能**:
- 原生 HTML5 拖拽 API
- 拖拽时视觉反馈（透明度变化）
- 拖拽目标高亮
- 拖拽完成后自动保存排序

**实现细节**:
- 使用 `draggable` 属性
- 处理 `dragstart`, `dragend`, `dragenter`, `dragleave`, `dragover`, `drop` 事件
- 使用 `dragCounter` 避免子元素触发 dragleave
- 调用 `/api/providers/:appType/sort-order` API 保存排序

### 4. ProviderManager 集成

**修改文件**: `src/components/ProviderManager/ProviderManager.jsx`

**新增状态**:
- `showConfig` - 配置弹窗显示状态
- `showImportExport` - 导入导出弹窗显示状态

**新增方法**:
- `handleReorder` - 处理拖拽排序更新

**新增按钮**:
- "导入/导出" - 打开导入导出弹窗
- "设置" - 打开健康检查配置弹窗

## 文件变更清单

### 新增文件
- `src/components/ProviderManager/HealthCheckConfig.jsx` - 健康检查配置
- `src/components/ProviderManager/ImportExport.jsx` - 导入导出

### 修改文件
- `src/components/ProviderManager/ProviderList.jsx`
  - 添加拖拽排序功能
  - 添加 `onReorder` prop
  - 拖拽状态管理和视觉反馈

- `src/components/ProviderManager/ProviderManager.jsx`
  - 导入新组件
  - 添加 showConfig、showImportExport 状态
  - 添加 handleReorder 方法
  - 添加"导入/导出"和"设置"按钮
  - 添加弹窗渲染

## API 调用

### HealthCheckConfig 使用的 API
```
GET  /api/providers/config/health-check   - 获取配置
PUT  /api/providers/config/health-check   - 保存配置
```

### ImportExport 使用的 API
```
POST /api/providers/:appType              - 导入供应商（单个）
```

### 拖拽排序使用的 API
```
PUT  /api/providers/:appType/sort-order   - 批量更新排序
```

## UI 布局更新

```
ProviderManager 标签栏
├── [供应商列表] [预设模板]
└── [全部检测] [导入/导出] [设置]   <- 新增按钮

ProviderList
├── 提示：拖拽卡片可调整顺序
└── [可拖拽的 ProviderCard]...
```

## 使用说明

### 健康检查配置
1. 点击"设置"按钮
2. 调整超时时间、重试次数、降级阈值
3. 配置各类型的测试模型（建议使用轻量模型）
4. 点击"保存"

### 导出配置
1. 点击"导入/导出"按钮
2. 在"导出配置"标签页
3. 选择是否包含 API Keys（谨慎选择）
4. 点击"导出为 JSON 文件"

### 导入配置
1. 点击"导入/导出"按钮
2. 切换到"导入配置"标签页
3. 选择 JSON 文件或粘贴 JSON 内容
4. 预览导入内容
5. 点击"导入配置"

### 拖拽排序
1. 在供应商列表中
2. 拖拽任意供应商卡片
3. 放置到目标位置
4. 排序自动保存

## Phase 7 完成状态

- [x] HealthCheckConfig 组件
- [x] ImportExport 组件
- [x] 拖拽排序功能
- [x] ProviderManager 集成

## 累计完成功能

### Phase 1-3: 基础架构
- 后端 REST API
- ProviderService、ProviderHealthCheck 服务
- 预设配置系统（22 个预设）
- 前端组件框架

### Phase 4: 高级功能
- AIEngine 集成
- Backfill 功能
- 端点测速
- 用量查询

### Phase 5: 端点与用量 UI
- EndpointManager 组件
- UsageScriptEditor 组件

### Phase 6: 编辑与批量检查
- ProviderEditor 组件
- HealthCheckLogs 组件
- 批量健康检查

### Phase 7: 配置与数据管理
- HealthCheckConfig 组件
- ImportExport 组件
- 拖拽排序功能

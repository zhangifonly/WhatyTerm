# AI 设置供应商下拉框功能开发总结

## 功能描述

在 AI 设置界面添加供应商下拉框，允许用户从 CC Switch 的服务器列表中选择供应商，而不需要手动配置 API 参数。

## 实现细节

### 1. 前端修改 (src/App.jsx)

#### 新增状态变量
```javascript
const [providers, setProviders] = useState([]);
const [selectedProviderId, setSelectedProviderId] = useState('');
```

#### 加载供应商列表
```javascript
useEffect(() => {
  fetch('/api/providers/list/claude')
    .then(res => res.json())
    .then(data => {
      const providerList = Object.values(data.providers || {});
      // 按 sortIndex 排序
      providerList.sort((a, b) => {
        const aIndex = a.sortIndex ?? 999999;
        const bIndex = b.sortIndex ?? 999999;
        if (aIndex !== bIndex) return aIndex - bIndex;
        return (a.createdAt || 0) - (b.createdAt || 0);
      });
      setProviders(providerList);
      // 如果当前设置中有供应商 ID，设置为选中
      if (settings._providerId) {
        setSelectedProviderId(settings._providerId);
      }
    })
    .catch(err => console.error('加载供应商列表失败:', err));
}, [settings._providerId]);
```

#### 供应商选择处理
```javascript
const handleProviderSelect = (providerId) => {
  setSelectedProviderId(providerId);

  if (!providerId) {
    // 清空选择，恢复手动配置模式
    return;
  }

  const provider = providers.find(p => p.id === providerId);
  if (!provider || !provider.settingsConfig) {
    return;
  }

  const config = provider.settingsConfig;

  // 更新设置，自动填充供应商配置
  onChange(prev => ({
    ...prev,
    apiType: config.apiType || 'claude',
    openai: config.openai || prev.openai,
    claude: config.claude || prev.claude,
    maxTokens: config.maxTokens || prev.maxTokens,
    temperature: config.temperature || prev.temperature,
    _providerId: providerId,
    _providerName: provider.name
  }));
};
```

#### UI 组件

**供应商选择下拉框**
```jsx
<div className="form-group" style={{
  marginBottom: '20px',
  padding: '12px',
  background: '#1a1a1a',
  borderRadius: '8px',
  border: '1px solid #333'
}}>
  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
    <span>选择供应商</span>
    {settings._providerName && (
      <span style={{
        fontSize: '11px',
        color: '#10b981',
        background: '#10b98120',
        padding: '2px 8px',
        borderRadius: '4px'
      }}>
        当前: {settings._providerName}
      </span>
    )}
  </label>
  <select
    value={selectedProviderId}
    onChange={(e) => handleProviderSelect(e.target.value)}
    style={{
      width: '100%',
      padding: '8px',
      background: '#2a2a2a',
      border: '1px solid #444',
      borderRadius: '4px',
      color: '#fff'
    }}
  >
    <option value="">-- 手动配置 --</option>
    {providers.map(provider => (
      <option key={provider.id} value={provider.id}>
        {provider.name} ({provider.settingsConfig?.apiType === 'claude' ? 'Claude' : 'OpenAI'})
      </option>
    ))}
  </select>
  <div style={{ marginTop: '8px', fontSize: '12px', color: '#888' }}>
    💡 从 CC Switch 供应商列表中选择，或选择"手动配置"自定义设置
  </div>
</div>
```

**API 类型选择（选择供应商后禁用）**
```jsx
<div className="form-group">
  <label>API 类型</label>
  <select
    value={settings.apiType || 'openai'}
    onChange={(e) => updateField('apiType', e.target.value)}
    disabled={selectedProviderId !== ''}
    style={{ opacity: selectedProviderId !== '' ? 0.6 : 1 }}
  >
    <option value="openai">OpenAI 兼容</option>
    <option value="claude">Claude 原生</option>
  </select>
  {selectedProviderId !== '' && (
    <div style={{ marginTop: '4px', fontSize: '11px', color: '#888' }}>
      已选择供应商，API 类型由供应商配置决定
    </div>
  )}
</div>
```

**OpenAI 配置输入框（选择供应商后禁用）**
```jsx
<input
  type="text"
  value={settings.openai?.apiUrl || ''}
  onChange={(e) => updateField('openai', { ...settings.openai, apiUrl: e.target.value })}
  placeholder="https://api.openai.com/v1/chat/completions"
  disabled={selectedProviderId !== ''}
  style={{ opacity: selectedProviderId !== '' ? 0.6 : 1 }}
/>
```

**Claude 配置输入框（选择供应商后禁用）**
```jsx
<input
  type="text"
  value={settings.claude?.apiUrl || ''}
  onChange={(e) => updateField('claude', { ...settings.claude, apiUrl: e.target.value })}
  placeholder="https://api.anthropic.com/v1/messages"
  disabled={selectedProviderId !== ''}
  style={{ opacity: selectedProviderId !== '' ? 0.6 : 1 }}
/>
```

**提示文字（选择供应商后显示）**
```jsx
{selectedProviderId !== '' && (
  <div style={{ marginTop: '8px', fontSize: '11px', color: '#888' }}>
    已选择供应商，配置由供应商决定
  </div>
)}
```

### 2. 后端支持

后端已有完整的 Provider 管理 API：

- `GET /api/providers/list/:appType` - 获取供应商列表
- `GET /api/current-provider?app=:appType` - 获取当前供应商
- `POST /api/providers/switch` - 切换供应商

供应商数据存储在 `server/db/providers.json`，结构如下：

```json
{
  "claude": {
    "current": "provider-migrated",
    "providers": {
      "provider-migrated": {
        "id": "provider-migrated",
        "name": "迁移的 AI 配置",
        "appType": "claude",
        "settingsConfig": {
          "apiType": "openai",
          "openai": {
            "apiUrl": "https://agent-ai.webtrn.cn/v1/chat/completions",
            "apiKey": "",
            "model": "opus"
          },
          "claude": {
            "apiUrl": "https://zjz-ai.webtrn.cn/v1/messages",
            "apiKey": "sk-...",
            "model": "claude-sonnet-4-5-20250929"
          },
          "maxTokens": 2000,
          "temperature": 0.7
        },
        "sortIndex": 0
      }
    }
  }
}
```

## 功能特性

1. **供应商列表加载**：从 CC Switch 数据库加载供应商列表，按 sortIndex 排序
2. **自动填充配置**：选择供应商后自动填充 API 配置（URL、Key、Model 等）
3. **手动配置模式**：选择"手动配置"可恢复手动输入模式
4. **输入框禁用**：选择供应商后，API 配置输入框自动禁用，防止误操作
5. **当前供应商显示**：在下拉框标签旁显示当前使用的供应商名称
6. **提示文字**：在禁用的输入框下方显示提示，说明配置由供应商决定

## 用户体验

### 选择供应商模式
1. 用户打开 AI 设置
2. 在"选择供应商"下拉框中选择一个供应商
3. API 类型、URL、Key、Model 等配置自动填充
4. 所有配置输入框变为禁用状态（灰色）
5. 显示提示文字："已选择供应商，配置由供应商决定"
6. 点击保存，配置生效

### 手动配置模式
1. 用户打开 AI 设置
2. 在"选择供应商"下拉框中选择"-- 手动配置 --"
3. 所有配置输入框恢复可编辑状态
4. 用户可以手动输入 API 配置
5. 点击保存，配置生效

## 技术要点

1. **状态管理**：使用 React useState 管理供应商列表和选中状态
2. **数据加载**：使用 useEffect 在组件挂载时加载供应商列表
3. **配置同步**：选择供应商时自动同步配置到 settings 对象
4. **UI 禁用**：使用 disabled 属性和 opacity 样式实现输入框禁用效果
5. **条件渲染**：使用条件表达式控制提示文字的显示

## 测试验证

1. **构建测试**：运行 `npm run build` 成功，无语法错误
2. **数据库验证**：确认 `server/db/providers.json` 中有供应商数据
3. **API 验证**：确认 `/api/providers/list/claude` 接口可用

## 后续优化建议

1. **错误处理**：添加供应商列表加载失败的错误提示
2. **加载状态**：添加供应商列表加载中的 loading 状态
3. **供应商详情**：在下拉框中显示更多供应商信息（如 URL、状态等）
4. **快速切换**：在 AI 监控面板添加快速切换供应商的按钮
5. **供应商管理**：在设置界面添加供应商管理入口（添加、编辑、删除）

## 相关文件

- `src/App.jsx` - 前端 UI 实现
- `server/services/ProviderService.js` - 供应商管理服务
- `server/db/providers.json` - 供应商数据存储
- `server/routes/configRoutes.js` - 供应商 API 路由

## 开发时间

2025-01-13

## 开发者

Claude Code (Sonnet 4.5)

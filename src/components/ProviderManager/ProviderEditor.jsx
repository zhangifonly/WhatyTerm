import React, { useState, useEffect } from 'react';
import { toast } from '../Toast';

/**
 * 供应商编辑器组件
 * 编辑供应商的名称、API 配置等
 */
export default function ProviderEditor({ appType, providerId, provider, onClose, onSave }) {
  const [formData, setFormData] = useState({
    name: '',
    apiType: 'openai',
    openai: {
      apiUrl: '',
      apiKey: '',
      model: ''
    },
    claude: {
      apiUrl: '',
      apiKey: '',
      model: ''
    },
    maxTokens: 2000,
    temperature: 0.7,
    notes: ''
  });
  const [saving, setSaving] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState(null);

  // 初始化表单数据
  useEffect(() => {
    if (provider) {
      setFormData({
        name: provider.name || '',
        apiType: provider.settingsConfig?.apiType || 'openai',
        openai: {
          apiUrl: provider.settingsConfig?.openai?.apiUrl || '',
          apiKey: provider.settingsConfig?.openai?.apiKey || '',
          model: provider.settingsConfig?.openai?.model || ''
        },
        claude: {
          apiUrl: provider.settingsConfig?.claude?.apiUrl || '',
          apiKey: provider.settingsConfig?.claude?.apiKey || '',
          model: provider.settingsConfig?.claude?.model || ''
        },
        maxTokens: provider.settingsConfig?.maxTokens || 2000,
        temperature: provider.settingsConfig?.temperature || 0.7,
        notes: provider.notes || ''
      });
    }
  }, [provider]);

  // 更新表单字段
  const updateField = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  // 更新嵌套字段
  const updateNestedField = (parent, field, value) => {
    setFormData(prev => ({
      ...prev,
      [parent]: { ...prev[parent], [field]: value }
    }));
  };

  // 保存
  const handleSave = async () => {
    if (!formData.name.trim()) {
      toast.error('请输入供应商名称');
      return;
    }

    setSaving(true);
    try {
      const updates = {
        name: formData.name.trim(),
        notes: formData.notes.trim(),
        settingsConfig: {
          apiType: formData.apiType,
          openai: formData.openai,
          claude: formData.claude,
          maxTokens: parseInt(formData.maxTokens) || 2000,
          temperature: parseFloat(formData.temperature) || 0.7
        }
      };

      const res = await fetch(`/api/providers/${appType}/${providerId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates })
      });

      const data = await res.json();

      if (data.success) {
        onSave && onSave(data.provider);
        onClose();
        toast.success('保存成功');
      } else {
        toast.error(data.error || '保存失败');
      }
    } catch (err) {
      toast.error('保存失败: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  // 验证 API Key
  const handleVerifyKey = async () => {
    const currentApiConfig = formData.apiType === 'openai' ? formData.openai : formData.claude;

    if (!currentApiConfig.apiKey.trim()) {
      toast.error('请先输入 API Key');
      return;
    }

    if (!currentApiConfig.apiUrl.trim()) {
      toast.error('请先输入 API URL');
      return;
    }

    setVerifying(true);
    setVerifyResult(null);

    try {
      // 创建临时供应商配置用于测试
      const testProvider = {
        settingsConfig: {
          apiType: formData.apiType,
          openai: formData.openai,
          claude: formData.claude,
          maxTokens: formData.maxTokens,
          temperature: formData.temperature
        }
      };

      const res = await fetch(`/api/providers/${appType}/verify-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(testProvider)
      });

      const data = await res.json();

      setVerifyResult(data);
    } catch (err) {
      setVerifyResult({
        success: false,
        error: err.message
      });
    } finally {
      setVerifying(false);
    }
  };

  // 获取当前 API 配置
  const currentApiConfig = formData.apiType === 'openai' ? formData.openai : formData.claude;
  const currentApiField = formData.apiType;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={(e) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    }}>
      <div
        className="bg-gray-900 rounded-lg w-full max-w-2xl max-h-[85vh] overflow-hidden"
      >
        {/* 头部 */}
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <div>
            <h2 className="text-lg font-medium text-white">编辑供应商</h2>
            <p className="text-sm text-gray-400">ID: {providerId}</p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white text-xl"
          >
            ×
          </button>
        </div>

        {/* 内容 */}
        <div className="p-4 overflow-y-auto max-h-[65vh] space-y-4">
          {/* 基本信息 */}
          <div>
            <label className="block text-sm text-gray-400 mb-2">供应商名称</label>
            <input
              type="text"
              value={formData.name}
              onChange={e => updateField('name', e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
              placeholder="输入供应商名称"
            />
          </div>

          {/* API 类型选择 */}
          <div>
            <label className="block text-sm text-gray-400 mb-2">API 类型</label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="apiType"
                  value="openai"
                  checked={formData.apiType === 'openai'}
                  onChange={e => updateField('apiType', e.target.value)}
                  className="text-blue-500"
                />
                <span className="text-gray-300">OpenAI 兼容</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="apiType"
                  value="claude"
                  checked={formData.apiType === 'claude'}
                  onChange={e => updateField('apiType', e.target.value)}
                  className="text-blue-500"
                />
                <span className="text-gray-300">Claude 原生</span>
              </label>
            </div>
          </div>

          {/* API URL */}
          <div>
            <label className="block text-sm text-gray-400 mb-2">API URL</label>
            <input
              type="text"
              value={currentApiConfig.apiUrl}
              onChange={e => updateNestedField(currentApiField, 'apiUrl', e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm font-mono focus:border-blue-500 focus:outline-none"
              placeholder={formData.apiType === 'openai'
                ? 'https://api.openai.com/v1/chat/completions'
                : 'https://api.anthropic.com/v1/messages'}
            />
          </div>

          {/* API Key */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm text-gray-400">API Key</label>
              <button
                type="button"
                onClick={handleVerifyKey}
                disabled={verifying}
                className="px-2 py-1 bg-green-500/20 hover:bg-green-500/30 disabled:bg-gray-800 text-green-400 disabled:text-gray-600 text-xs rounded transition-colors"
              >
                {verifying ? '验证中...' : '验证'}
              </button>
            </div>
            <div className="relative">
              <input
                type={showApiKey ? 'text' : 'password'}
                value={currentApiConfig.apiKey}
                onChange={e => {
                  updateNestedField(currentApiField, 'apiKey', e.target.value);
                  setVerifyResult(null); // 清除验证结果
                }}
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 pr-20 text-white text-sm font-mono focus:border-blue-500 focus:outline-none"
                placeholder="sk-..."
              />
              <button
                type="button"
                onClick={() => setShowApiKey(!showApiKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-1 text-xs text-gray-400 hover:text-white"
              >
                {showApiKey ? '隐藏' : '显示'}
              </button>
            </div>

            {/* 验证结果 */}
            {verifyResult && (
              <div className={`mt-2 p-2 rounded text-sm ${
                verifyResult.success ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'
              }`}>
                {verifyResult.success ? (
                  <div>
                    ✓ API Key 有效
                    {verifyResult.responseTimeMs && (
                      <span className="text-gray-400 ml-2">({verifyResult.responseTimeMs}ms)</span>
                    )}
                  </div>
                ) : (
                  <div>✗ 验证失败: {verifyResult.error}</div>
                )}
              </div>
            )}
          </div>

          {/* 模型 */}
          <div>
            <label className="block text-sm text-gray-400 mb-2">模型</label>
            <input
              type="text"
              value={currentApiConfig.model}
              onChange={e => updateNestedField(currentApiField, 'model', e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
              placeholder={formData.apiType === 'openai' ? 'gpt-4' : 'claude-3-sonnet-20240229'}
            />
          </div>

          {/* 高级设置 */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-2">Max Tokens</label>
              <input
                type="number"
                value={formData.maxTokens}
                onChange={e => updateField('maxTokens', e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
                min="1"
                max="100000"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-2">Temperature</label>
              <input
                type="number"
                value={formData.temperature}
                onChange={e => updateField('temperature', e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
                min="0"
                max="2"
                step="0.1"
              />
            </div>
          </div>

          {/* 备注 */}
          <div>
            <label className="block text-sm text-gray-400 mb-2">备注</label>
            <textarea
              value={formData.notes}
              onChange={e => updateField('notes', e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none resize-none"
              rows={3}
              placeholder="添加备注信息..."
            />
          </div>
        </div>

        {/* 底部 */}
        <div className="flex justify-end gap-2 p-4 border-t border-gray-700">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm rounded transition-colors"
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

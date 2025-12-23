import React, { useState, useEffect } from 'react';
import { toast } from '../Toast';

/**
 * 健康检查配置组件
 * 配置超时时间、重试次数、降级阈值、测试模型等
 */
export default function HealthCheckConfig({ onClose }) {
  const [config, setConfig] = useState({
    timeoutSecs: 45,
    maxRetries: 2,
    degradedThresholdMs: 6000,
    testModels: {
      claude: 'claude-haiku-4-5-20251001',
      codex: 'gpt-4o-mini',
      gemini: 'gemini-2.0-flash'
    }
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // 加载配置
  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    try {
      const res = await fetch('/api/providers/config/health-check');
      const data = await res.json();
      setConfig(prev => ({ ...prev, ...data }));
    } catch (err) {
      console.error('加载配置失败:', err);
    } finally {
      setLoading(false);
    }
  };

  // 保存配置
  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/providers/config/health-check', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      const data = await res.json();

      if (data.success) {
        toast.success('配置已保存');
        onClose();
      } else {
        toast.error(data.error || '保存失败');
      }
    } catch (err) {
      toast.error('保存失败: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  // 更新配置字段
  const updateField = (field, value) => {
    setConfig(prev => ({ ...prev, [field]: value }));
  };

  // 更新测试模型
  const updateTestModel = (appType, model) => {
    setConfig(prev => ({
      ...prev,
      testModels: { ...prev.testModels, [appType]: model }
    }));
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-gray-900 rounded-lg w-full max-w-lg max-h-[85vh] overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <h2 className="text-lg font-medium text-white">健康检查配置</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white text-xl"
          >
            ×
          </button>
        </div>

        {/* 内容 */}
        <div className="p-4 overflow-y-auto max-h-[65vh] space-y-4">
          {loading ? (
            <div className="text-gray-400 text-sm py-8 text-center">加载中...</div>
          ) : (
            <>
              {/* 超时时间 */}
              <div>
                <label className="block text-sm text-gray-400 mb-2">
                  超时时间（秒）
                </label>
                <input
                  type="number"
                  value={config.timeoutSecs}
                  onChange={e => updateField('timeoutSecs', parseInt(e.target.value) || 45)}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
                  min="5"
                  max="120"
                />
                <p className="text-xs text-gray-500 mt-1">
                  API 请求的最大等待时间，建议 30-60 秒
                </p>
              </div>

              {/* 重试次数 */}
              <div>
                <label className="block text-sm text-gray-400 mb-2">
                  最大重试次数
                </label>
                <input
                  type="number"
                  value={config.maxRetries}
                  onChange={e => updateField('maxRetries', parseInt(e.target.value) || 2)}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
                  min="0"
                  max="5"
                />
                <p className="text-xs text-gray-500 mt-1">
                  超时或网络错误时的重试次数，0 表示不重试
                </p>
              </div>

              {/* 降级阈值 */}
              <div>
                <label className="block text-sm text-gray-400 mb-2">
                  降级阈值（毫秒）
                </label>
                <input
                  type="number"
                  value={config.degradedThresholdMs}
                  onChange={e => updateField('degradedThresholdMs', parseInt(e.target.value) || 6000)}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
                  min="1000"
                  max="30000"
                  step="1000"
                />
                <p className="text-xs text-gray-500 mt-1">
                  响应时间超过此值将标记为"降级"状态
                </p>
              </div>

              {/* 测试模型 */}
              <div className="border-t border-gray-700 pt-4">
                <h3 className="text-sm text-gray-300 mb-3">测试模型</h3>
                <p className="text-xs text-gray-500 mb-3">
                  健康检查时使用的模型，建议使用轻量级模型以减少成本
                </p>

                <div className="space-y-3">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Claude</label>
                    <input
                      type="text"
                      value={config.testModels?.claude || ''}
                      onChange={e => updateTestModel('claude', e.target.value)}
                      className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
                      placeholder="claude-haiku-4-5-20251001"
                    />
                  </div>

                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Codex / OpenAI</label>
                    <input
                      type="text"
                      value={config.testModels?.codex || ''}
                      onChange={e => updateTestModel('codex', e.target.value)}
                      className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
                      placeholder="gpt-4o-mini"
                    />
                  </div>

                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Gemini</label>
                    <input
                      type="text"
                      value={config.testModels?.gemini || ''}
                      onChange={e => updateTestModel('gemini', e.target.value)}
                      className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
                      placeholder="gemini-2.0-flash"
                    />
                  </div>
                </div>
              </div>
            </>
          )}
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
            disabled={saving || loading}
            className="px-4 py-2 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm rounded transition-colors"
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

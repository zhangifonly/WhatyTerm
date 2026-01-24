import React, { useState } from 'react';
import { toast } from '../Toast';

/**
 * 预设选择器组件
 */
export default function PresetSelector({ presets, categories, onApply }) {
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [applyingPreset, setApplyingPreset] = useState(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [templateVars, setTemplateVars] = useState({});
  const [showApplyModal, setShowApplyModal] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState(null);

  // 过滤预设
  const filteredPresets = presets.filter(preset => {
    // 隐藏合作伙伴供应商（带星号的）
    if (preset.isPartner) {
      return false;
    }

    // 分类过滤
    if (selectedCategory !== 'all' && preset.category !== selectedCategory) {
      return false;
    }

    // 搜索过滤
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      return (
        preset.name.toLowerCase().includes(query) ||
        (preset.description && preset.description.toLowerCase().includes(query))
      );
    }

    return true;
  });

  // 打开应用对话框
  const handleOpenApplyModal = (preset) => {
    setSelectedPreset(preset);
    setApiKeyInput('');
    setTemplateVars({});
    setShowApplyModal(true);
  };

  // 应用预设
  const handleApply = async () => {
    if (!selectedPreset) return;

    setApplyingPreset(selectedPreset.id);

    const result = await onApply(selectedPreset.id, {
      apiKey: apiKeyInput,
      templateVariables: templateVars
    });

    setApplyingPreset(null);

    if (result.success) {
      setShowApplyModal(false);
      toast.success(`已添加: ${selectedPreset.name}`);
    } else {
      toast.error(`添加失败: ${result.error}`);
    }
  };

  // 获取分类图标
  const getCategoryIcon = (category) => {
    const icons = {
      official: '🏢',
      cn_official: '🇨🇳',
      aggregator: '🔗',
      third_party: '🌐',
      custom: '⚙️'
    };
    return icons[category] || '📦';
  };

  // 获取分类颜色
  const getCategoryColor = (category) => {
    const colors = {
      official: 'bg-blue-500/20 text-blue-400',
      cn_official: 'bg-red-500/20 text-red-400',
      aggregator: 'bg-purple-500/20 text-purple-400',
      third_party: 'bg-green-500/20 text-green-400',
      custom: 'bg-gray-500/20 text-gray-400'
    };
    return colors[category] || 'bg-gray-500/20 text-gray-400';
  };

  return (
    <div className="preset-selector">
      {/* 搜索和过滤 */}
      <div className="mb-6">
        {/* 搜索框 */}
        <div className="mb-4">
          <input
            type="text"
            placeholder="搜索供应商..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
          />
        </div>

        {/* 分类过滤 */}
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setSelectedCategory('all')}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              selectedCategory === 'all'
                ? 'bg-blue-500 text-white'
                : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
            }`}
          >
            全部 ({presets.length})
          </button>
          {categories.map(cat => (
            <button
              key={cat.id}
              onClick={() => setSelectedCategory(cat.id)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                selectedCategory === cat.id
                  ? 'bg-blue-500 text-white'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
              }`}
            >
              {getCategoryIcon(cat.id)} {cat.name} ({cat.count})
            </button>
          ))}
        </div>
      </div>

      {/* 预设列表 */}
      {filteredPresets.length === 0 ? (
        <div className="text-center text-gray-400 py-12">
          没有找到匹配的预设
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredPresets.map(preset => (
            <div
              key={preset.id}
              className="bg-gray-800 border border-gray-700 rounded-lg p-4 hover:border-gray-600 transition-colors"
            >
              {/* 头部 */}
              <div className="flex items-start justify-between mb-3">
                <div className="flex-1">
                  <h3 className="text-white font-medium mb-1">
                    {preset.name}
                    {preset.isPartner && (
                      <span className="ml-2 text-xs bg-yellow-500/20 text-yellow-400 px-2 py-0.5 rounded">
                        合作伙伴
                      </span>
                    )}
                    {preset.isOfficial && (
                      <span className="ml-2 text-xs bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded">
                        官方
                      </span>
                    )}
                  </h3>
                  <span className={`inline-block px-2 py-0.5 rounded text-xs ${getCategoryColor(preset.category)}`}>
                    {getCategoryIcon(preset.category)} {categories.find(c => c.id === preset.category)?.name}
                  </span>
                </div>
              </div>

              {/* 描述 */}
              {preset.description && (
                <p className="text-gray-400 text-sm mb-3 line-clamp-2">
                  {preset.description}
                </p>
              )}

              {/* 信息 */}
              <div className="space-y-1 mb-3 text-xs text-gray-500">
                {preset.settingsConfig?.openai && (
                  <div>类型: OpenAI 兼容</div>
                )}
                {preset.settingsConfig?.claude && (
                  <div>类型: Claude 原生</div>
                )}
                {preset.templateVariables && (
                  <div className="text-yellow-400">需要配置模板变量</div>
                )}
                {!preset.apiKeyUrl && (
                  <div className="text-green-400">无需 API Key</div>
                )}
              </div>

              {/* 操作按钮 */}
              <div className="flex gap-2">
                <button
                  onClick={() => handleOpenApplyModal(preset)}
                  disabled={applyingPreset === preset.id}
                  className="flex-1 px-3 py-2 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-700 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors"
                >
                  {applyingPreset === preset.id ? '添加中...' : '添加'}
                </button>
                {preset.websiteUrl && (
                  <a
                    href={preset.websiteUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded-lg text-sm font-medium transition-colors"
                  >
                    官网
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 应用预设对话框 */}
      {showApplyModal && selectedPreset && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-lg max-w-md w-full p-6">
            <h2 className="text-xl font-bold text-white mb-4">
              添加供应商: {selectedPreset.name}
            </h2>

            <div className="space-y-4">
              {/* API Key 输入 */}
              {selectedPreset.apiKeyUrl !== null && (
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    API Key
                    {selectedPreset.apiKeyUrl && (
                      <a
                        href={selectedPreset.apiKeyUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-2 text-blue-400 hover:underline text-xs"
                      >
                        获取 →
                      </a>
                    )}
                  </label>
                  <input
                    type="password"
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    placeholder="输入 API Key（可选）"
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  />
                </div>
              )}

              {/* 模板变量输入 */}
              {selectedPreset.templateVariables && (
                <>
                  {Object.entries(selectedPreset.templateVariables).map(([key, config]) => (
                    <div key={key}>
                      <label className="block text-sm font-medium text-gray-300 mb-2">
                        {config.label}
                        {config.description && (
                          <span className="ml-2 text-xs text-gray-500">
                            {config.description}
                          </span>
                        )}
                      </label>
                      <input
                        type="text"
                        value={templateVars[key] || ''}
                        onChange={(e) => setTemplateVars({ ...templateVars, [key]: e.target.value })}
                        placeholder={config.placeholder}
                        className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                      />
                    </div>
                  ))}
                </>
              )}

              {/* 提示信息 */}
              {selectedPreset.notes && (
                <div className="text-sm text-gray-400 bg-gray-800 rounded-lg p-3">
                  💡 {selectedPreset.notes}
                </div>
              )}
            </div>

            {/* 按钮 */}
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setShowApplyModal(false)}
                className="flex-1 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg font-medium transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleApply}
                disabled={applyingPreset === selectedPreset.id}
                className="flex-1 px-4 py-2 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-700 disabled:cursor-not-allowed text-white rounded-lg font-medium transition-colors"
              >
                {applyingPreset === selectedPreset.id ? '添加中...' : '确认添加'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

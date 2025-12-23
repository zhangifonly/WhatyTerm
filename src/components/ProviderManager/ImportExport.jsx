import React, { useState } from 'react';
import { toast } from '../Toast';

/**
 * 供应商导入导出组件
 * 支持备份和恢复供应商配置
 */
export default function ImportExport({ appType, providers, onImport, onClose }) {
  const [activeTab, setActiveTab] = useState('export'); // 'export' | 'import'
  const [importData, setImportData] = useState('');
  const [importing, setImporting] = useState(false);
  const [exportOptions, setExportOptions] = useState({
    includeApiKeys: false,
    includeEndpoints: true,
    includeUsageScripts: true
  });

  // 导出配置
  const handleExport = () => {
    const providerList = Object.values(providers.providers);

    const exportData = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      appType,
      current: providers.current,
      providers: providerList.map(p => {
        const exported = {
          id: p.id,
          name: p.name,
          category: p.category,
          settingsConfig: { ...p.settingsConfig },
          notes: p.notes,
          websiteUrl: p.websiteUrl,
          icon: p.icon,
          iconColor: p.iconColor
        };

        // 是否包含 API Keys
        if (!exportOptions.includeApiKeys) {
          if (exported.settingsConfig.openai) {
            exported.settingsConfig.openai.apiKey = '';
          }
          if (exported.settingsConfig.claude) {
            exported.settingsConfig.claude.apiKey = '';
          }
        }

        return exported;
      })
    };

    // 下载 JSON 文件
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `providers-${appType}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // 导入配置
  const handleImport = async () => {
    if (!importData.trim()) {
      toast.error('请粘贴或选择要导入的配置');
      return;
    }

    let data;
    try {
      data = JSON.parse(importData);
    } catch {
      toast.error('JSON 格式错误');
      return;
    }

    if (!data.providers || !Array.isArray(data.providers)) {
      toast.error('配置格式错误：缺少 providers 数组');
      return;
    }

    setImporting(true);

    try {
      let successCount = 0;
      let failCount = 0;

      for (const provider of data.providers) {
        // 生成新 ID 避免冲突
        const newProvider = {
          ...provider,
          id: `provider-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          name: provider.name + (data.providers.length > 1 ? '' : ' (导入)'),
          createdAt: Date.now()
        };

        const res = await fetch(`/api/providers/${appType}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: newProvider })
        });

        const result = await res.json();
        if (result.success) {
          successCount++;
        } else {
          failCount++;
        }
      }

      toast.success(`导入完成：成功 ${successCount} 个，失败 ${failCount} 个`);

      if (successCount > 0) {
        onImport && onImport();
        onClose();
      }
    } catch (err) {
      toast.error('导入失败: ' + err.message);
    } finally {
      setImporting(false);
    }
  };

  // 从文件导入
  const handleFileSelect = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      setImportData(event.target.result);
    };
    reader.readAsText(file);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-gray-900 rounded-lg w-full max-w-2xl max-h-[85vh] overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <h2 className="text-lg font-medium text-white">导入 / 导出</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white text-xl"
          >
            ×
          </button>
        </div>

        {/* 标签切换 */}
        <div className="flex border-b border-gray-700">
          <button
            onClick={() => setActiveTab('export')}
            className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
              activeTab === 'export'
                ? 'text-blue-400 border-b-2 border-blue-400 bg-gray-800/50'
                : 'text-gray-400 hover:text-gray-300'
            }`}
          >
            导出配置
          </button>
          <button
            onClick={() => setActiveTab('import')}
            className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
              activeTab === 'import'
                ? 'text-blue-400 border-b-2 border-blue-400 bg-gray-800/50'
                : 'text-gray-400 hover:text-gray-300'
            }`}
          >
            导入配置
          </button>
        </div>

        {/* 内容 */}
        <div className="p-4 overflow-y-auto max-h-[55vh]">
          {activeTab === 'export' ? (
            <div className="space-y-4">
              {/* 导出统计 */}
              <div className="bg-gray-800 rounded p-4">
                <div className="text-sm text-gray-400 mb-2">将导出以下内容：</div>
                <div className="text-2xl font-bold text-white">
                  {Object.keys(providers.providers).length} 个供应商
                </div>
              </div>

              {/* 导出选项 */}
              <div className="space-y-3">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={exportOptions.includeApiKeys}
                    onChange={e => setExportOptions(prev => ({ ...prev, includeApiKeys: e.target.checked }))}
                    className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-blue-500"
                  />
                  <div>
                    <div className="text-sm text-gray-300">包含 API Keys</div>
                    <div className="text-xs text-gray-500">警告：API Key 将以明文形式导出</div>
                  </div>
                </label>

                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={exportOptions.includeEndpoints}
                    onChange={e => setExportOptions(prev => ({ ...prev, includeEndpoints: e.target.checked }))}
                    className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-blue-500"
                  />
                  <div>
                    <div className="text-sm text-gray-300">包含自定义端点</div>
                    <div className="text-xs text-gray-500">导出备用端点配置</div>
                  </div>
                </label>

                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={exportOptions.includeUsageScripts}
                    onChange={e => setExportOptions(prev => ({ ...prev, includeUsageScripts: e.target.checked }))}
                    className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-blue-500"
                  />
                  <div>
                    <div className="text-sm text-gray-300">包含用量查询脚本</div>
                    <div className="text-xs text-gray-500">导出自定义用量查询脚本</div>
                  </div>
                </label>
              </div>

              {/* 导出按钮 */}
              <button
                onClick={handleExport}
                disabled={Object.keys(providers.providers).length === 0}
                className="w-full py-3 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-700 disabled:cursor-not-allowed text-white font-medium rounded transition-colors"
              >
                导出为 JSON 文件
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              {/* 文件选择 */}
              <div>
                <label className="block text-sm text-gray-400 mb-2">选择文件</label>
                <input
                  type="file"
                  accept=".json"
                  onChange={handleFileSelect}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm file:mr-4 file:py-1 file:px-3 file:rounded file:border-0 file:bg-gray-700 file:text-gray-300 hover:file:bg-gray-600"
                />
              </div>

              {/* 或者粘贴 JSON */}
              <div>
                <label className="block text-sm text-gray-400 mb-2">或粘贴 JSON 内容</label>
                <textarea
                  value={importData}
                  onChange={e => setImportData(e.target.value)}
                  className="w-full h-48 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm font-mono focus:border-blue-500 focus:outline-none resize-none"
                  placeholder='{"version": "1.0", "providers": [...]}'
                />
              </div>

              {/* 预览 */}
              {importData && (
                <div className="bg-gray-800 rounded p-3">
                  <div className="text-sm text-gray-400 mb-2">预览</div>
                  {(() => {
                    try {
                      const data = JSON.parse(importData);
                      return (
                        <div className="text-sm">
                          <div className="text-white">
                            {data.providers?.length || 0} 个供应商
                          </div>
                          {data.exportedAt && (
                            <div className="text-gray-500 text-xs mt-1">
                              导出时间: {new Date(data.exportedAt).toLocaleString('zh-CN')}
                            </div>
                          )}
                        </div>
                      );
                    } catch {
                      return <div className="text-red-400 text-sm">JSON 格式错误</div>;
                    }
                  })()}
                </div>
              )}

              {/* 导入按钮 */}
              <button
                onClick={handleImport}
                disabled={importing || !importData.trim()}
                className="w-full py-3 bg-green-500 hover:bg-green-600 disabled:bg-gray-700 disabled:cursor-not-allowed text-white font-medium rounded transition-colors"
              >
                {importing ? '导入中...' : '导入配置'}
              </button>

              {/* 提示 */}
              <div className="text-xs text-gray-500">
                注意：导入的供应商将生成新的 ID，不会覆盖现有配置
              </div>
            </div>
          )}
        </div>

        {/* 底部 */}
        <div className="flex justify-end p-4 border-t border-gray-700">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded transition-colors"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

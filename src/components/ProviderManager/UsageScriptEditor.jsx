import React, { useState, useEffect } from 'react';
import { toast } from '../Toast';

/**
 * 用量脚本编辑器组件
 * 编辑和执行供应商的用量查询脚本
 */
export default function UsageScriptEditor({ appType, providerId, provider, onClose }) {
  const [script, setScript] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [querying, setQuerying] = useState(false);
  const [queryResult, setQueryResult] = useState(null);
  const [hasChanges, setHasChanges] = useState(false);

  // 加载脚本
  useEffect(() => {
    loadScript();
  }, [appType, providerId]);

  const loadScript = async () => {
    try {
      const res = await fetch(`/api/providers/${appType}/${providerId}/usage-script`);
      const data = await res.json();
      setScript(data.script || '');
      setHasChanges(false);
    } catch (err) {
      console.error('加载脚本失败:', err);
    } finally {
      setLoading(false);
    }
  };

  // 保存脚本
  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/providers/${appType}/${providerId}/usage-script`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script })
      });
      const data = await res.json();

      if (data.success) {
        setHasChanges(false);
        toast.success('脚本已保存');
      } else {
        toast.error(data.error || '保存失败');
      }
    } catch (err) {
      toast.error('保存失败: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  // 执行查询
  const handleQuery = async () => {
    // 如果有未保存的更改，先保存
    if (hasChanges) {
      await handleSave();
    }

    setQuerying(true);
    setQueryResult(null);

    try {
      const res = await fetch(`/api/providers/${appType}/${providerId}/query-usage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await res.json();
      setQueryResult(data);
    } catch (err) {
      setQueryResult({
        success: false,
        error: err.message
      });
    } finally {
      setQuerying(false);
    }
  };

  // 脚本模板
  const templates = [
    {
      name: 'OpenAI 用量查询',
      script: `#!/bin/bash
# 查询 OpenAI API 用量
# 环境变量: API_KEY, API_URL, MODEL

curl -s "https://api.openai.com/v1/usage" \\
  -H "Authorization: Bearer $API_KEY" | jq '{
    total_tokens: .total_tokens,
    total_cost: .total_cost
  }'`
    },
    {
      name: 'Claude 用量查询',
      script: `#!/bin/bash
# 查询 Claude API 用量
# 环境变量: API_KEY, API_URL, MODEL

curl -s "https://api.anthropic.com/v1/usage" \\
  -H "x-api-key: $API_KEY" \\
  -H "anthropic-version: 2023-06-01" | jq '{
    input_tokens: .input_tokens,
    output_tokens: .output_tokens
  }'`
    },
    {
      name: '简单测试',
      script: `#!/bin/bash
# 简单测试脚本
echo '{"status": "ok", "provider": "'$PROVIDER_NAME'", "model": "'$MODEL'"}'`
    }
  ];

  const applyTemplate = (templateScript) => {
    setScript(templateScript);
    setHasChanges(true);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-gray-900 rounded-lg w-full max-w-3xl max-h-[85vh] overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <div>
            <h2 className="text-lg font-medium text-white">用量查询脚本</h2>
            <p className="text-sm text-gray-400">{provider?.name}</p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white text-xl"
          >
            ×
          </button>
        </div>

        {/* 内容 */}
        <div className="p-4 overflow-y-auto max-h-[65vh]">
          {/* 环境变量说明 */}
          <div className="mb-4 p-3 bg-gray-800 rounded text-sm">
            <div className="text-gray-400 mb-2">可用环境变量：</div>
            <div className="grid grid-cols-2 gap-2 text-xs font-mono">
              <div><span className="text-blue-400">$PROVIDER_ID</span> - 供应商 ID</div>
              <div><span className="text-blue-400">$PROVIDER_NAME</span> - 供应商名称</div>
              <div><span className="text-blue-400">$API_TYPE</span> - API 类型</div>
              <div><span className="text-blue-400">$API_URL</span> - API URL</div>
              <div><span className="text-blue-400">$API_KEY</span> - API Key</div>
              <div><span className="text-blue-400">$MODEL</span> - 模型名称</div>
            </div>
          </div>

          {/* 模板选择 */}
          <div className="mb-4">
            <div className="text-sm text-gray-400 mb-2">快速模板</div>
            <div className="flex gap-2 flex-wrap">
              {templates.map((tpl, index) => (
                <button
                  key={index}
                  onClick={() => applyTemplate(tpl.script)}
                  className="px-3 py-1 bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs rounded transition-colors"
                >
                  {tpl.name}
                </button>
              ))}
            </div>
          </div>

          {/* 脚本编辑器 */}
          <div className="mb-4">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm text-gray-400">
                脚本内容
                {hasChanges && <span className="text-yellow-400 ml-2">（未保存）</span>}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleSave}
                  disabled={saving || !hasChanges}
                  className="px-3 py-1 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-xs rounded transition-colors"
                >
                  {saving ? '保存中...' : '保存'}
                </button>
                <button
                  onClick={handleQuery}
                  disabled={querying || !script.trim()}
                  className="px-3 py-1 bg-green-500 hover:bg-green-600 disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-xs rounded transition-colors"
                >
                  {querying ? '执行中...' : '执行查询'}
                </button>
              </div>
            </div>

            {loading ? (
              <div className="text-gray-400 text-sm py-4 text-center">加载中...</div>
            ) : (
              <textarea
                value={script}
                onChange={e => {
                  setScript(e.target.value);
                  setHasChanges(true);
                }}
                placeholder="#!/bin/bash&#10;# 在此编写用量查询脚本..."
                className="w-full h-64 bg-gray-800 border border-gray-700 rounded p-3 text-gray-300 text-sm font-mono focus:border-blue-500 focus:outline-none resize-none"
                spellCheck={false}
              />
            )}
          </div>

          {/* 查询结果 */}
          {queryResult && (
            <div className="mt-4">
              <div className="text-sm text-gray-400 mb-2">查询结果</div>
              <div className={`rounded p-4 ${queryResult.success ? 'bg-green-500/10' : 'bg-red-500/10'}`}>
                {/* 状态 */}
                <div className="flex items-center gap-2 mb-3">
                  <span className={queryResult.success ? 'text-green-400' : 'text-red-400'}>
                    {queryResult.success ? '✓ 查询成功' : '✗ 查询失败'}
                  </span>
                  {queryResult.queriedAt && (
                    <span className="text-gray-500 text-xs">
                      {new Date(queryResult.queriedAt).toLocaleString('zh-CN')}
                    </span>
                  )}
                </div>

                {/* 结果内容 */}
                {queryResult.success ? (
                  <div className="bg-gray-800 rounded p-3 font-mono text-sm overflow-x-auto">
                    <pre className="text-gray-300 whitespace-pre-wrap">
                      {typeof queryResult.result === 'object'
                        ? JSON.stringify(queryResult.result, null, 2)
                        : queryResult.result}
                    </pre>
                  </div>
                ) : (
                  <div className="text-red-400 text-sm">
                    {queryResult.error}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 底部 */}
        <div className="flex justify-end gap-2 p-4 border-t border-gray-700">
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

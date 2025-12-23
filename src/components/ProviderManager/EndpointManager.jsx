import React, { useState, useEffect } from 'react';
import { toast } from '../Toast';

/**
 * 端点管理组件
 * 管理供应商的自定义端点，支持添加、删除、测速
 */
export default function EndpointManager({ appType, providerId, provider, onClose }) {
  const [endpoints, setEndpoints] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newUrl, setNewUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResults, setTestResults] = useState(null);

  // 加载端点列表
  useEffect(() => {
    loadEndpoints();
  }, [appType, providerId]);

  const loadEndpoints = async () => {
    try {
      const res = await fetch(`/api/providers/${appType}/${providerId}/endpoints`);
      const data = await res.json();
      setEndpoints(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('加载端点失败:', err);
    } finally {
      setLoading(false);
    }
  };

  // 添加端点
  const handleAdd = async () => {
    if (!newUrl.trim()) return;

    // 验证 URL 格式
    try {
      new URL(newUrl);
    } catch {
      toast.error('请输入有效的 URL');
      return;
    }

    setAdding(true);
    try {
      const res = await fetch(`/api/providers/${appType}/${providerId}/endpoints`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: newUrl.trim() })
      });
      const data = await res.json();

      if (data.success) {
        setNewUrl('');
        loadEndpoints();
        toast.success('端点添加成功');
      } else {
        toast.error(data.error || '添加失败');
      }
    } catch (err) {
      toast.error('添加失败: ' + err.message);
    } finally {
      setAdding(false);
    }
  };

  // 删除端点
  const handleDelete = async (url) => {
    try {
      const res = await fetch(`/api/providers/${appType}/${providerId}/endpoints`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      const data = await res.json();

      if (data.success) {
        loadEndpoints();
        toast.success('端点已删除');
      } else {
        toast.error(data.error || '删除失败');
      }
    } catch (err) {
      toast.error('删除失败: ' + err.message);
    }
  };

  // 测速所有端点
  const handleSpeedTest = async () => {
    setTesting(true);
    setTestResults(null);

    try {
      const res = await fetch(`/api/providers/${appType}/${providerId}/speedtest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const data = await res.json();

      if (data.success) {
        setTestResults(data);
      } else {
        toast.error(data.error || '测速失败');
      }
    } catch (err) {
      toast.error('测速失败: ' + err.message);
    } finally {
      setTesting(false);
    }
  };

  // 获取当前 API URL
  const getCurrentApiUrl = () => {
    const apiType = provider?.settingsConfig?.apiType || 'openai';
    return provider?.settingsConfig?.[apiType]?.apiUrl || '';
  };

  // 获取状态颜色
  const getStatusStyle = (result) => {
    if (!result.success) {
      return { bg: 'bg-red-500/10', text: 'text-red-400', icon: '✗' };
    }
    if (result.latencyMs < 3000) {
      return { bg: 'bg-green-500/10', text: 'text-green-400', icon: '✓' };
    }
    if (result.latencyMs < 6000) {
      return { bg: 'bg-yellow-500/10', text: 'text-yellow-400', icon: '⚠' };
    }
    return { bg: 'bg-orange-500/10', text: 'text-orange-400', icon: '!' };
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-gray-900 rounded-lg w-full max-w-2xl max-h-[80vh] overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <div>
            <h2 className="text-lg font-medium text-white">端点管理</h2>
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
        <div className="p-4 overflow-y-auto max-h-[60vh]">
          {/* 当前端点 */}
          <div className="mb-4">
            <div className="text-sm text-gray-400 mb-2">当前 API 端点</div>
            <div className="bg-gray-800 rounded p-3 font-mono text-sm text-blue-400 break-all">
              {getCurrentApiUrl() || '未配置'}
            </div>
          </div>

          {/* 添加端点 */}
          <div className="mb-4">
            <div className="text-sm text-gray-400 mb-2">添加备用端点</div>
            <div className="flex gap-2">
              <input
                type="text"
                value={newUrl}
                onChange={e => setNewUrl(e.target.value)}
                placeholder="https://api.example.com/v1/chat/completions"
                className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
                onKeyDown={e => e.key === 'Enter' && handleAdd()}
              />
              <button
                onClick={handleAdd}
                disabled={adding || !newUrl.trim()}
                className="px-4 py-2 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm rounded transition-colors"
              >
                {adding ? '添加中...' : '添加'}
              </button>
            </div>
          </div>

          {/* 端点列表 */}
          <div className="mb-4">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm text-gray-400">备用端点列表</div>
              <button
                onClick={handleSpeedTest}
                disabled={testing}
                className="px-3 py-1 bg-purple-500 hover:bg-purple-600 disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-xs rounded transition-colors"
              >
                {testing ? '测速中...' : '全部测速'}
              </button>
            </div>

            {loading ? (
              <div className="text-gray-400 text-sm py-4 text-center">加载中...</div>
            ) : endpoints.length === 0 ? (
              <div className="text-gray-500 text-sm py-4 text-center bg-gray-800 rounded">
                暂无备用端点，添加后可进行测速选择最快的
              </div>
            ) : (
              <div className="space-y-2">
                {endpoints.map((endpoint, index) => (
                  <div
                    key={endpoint.url || index}
                    className="flex items-center justify-between bg-gray-800 rounded p-3"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-sm text-gray-300 truncate">
                        {endpoint.url}
                      </div>
                      {endpoint.addedAt && (
                        <div className="text-xs text-gray-500 mt-1">
                          添加于 {new Date(endpoint.addedAt).toLocaleString('zh-CN')}
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => handleDelete(endpoint.url)}
                      className="ml-2 px-2 py-1 text-red-400 hover:bg-red-500/20 rounded text-sm"
                    >
                      删除
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 测速结果 */}
          {testResults && (
            <div className="mt-4">
              <div className="text-sm text-gray-400 mb-2">测速结果</div>
              <div className="space-y-2">
                {testResults.results.map((result, index) => {
                  const style = getStatusStyle(result);
                  const isFastest = testResults.fastest?.url === result.url;

                  return (
                    <div
                      key={result.url || index}
                      className={`${style.bg} rounded p-3 ${isFastest ? 'ring-2 ring-green-500' : ''}`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className={style.text}>{style.icon}</span>
                          <span className="font-mono text-sm text-gray-300 truncate max-w-md">
                            {result.url}
                          </span>
                          {isFastest && (
                            <span className="px-2 py-0.5 bg-green-500 text-white text-xs rounded">
                              最快
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 text-sm">
                          {result.success ? (
                            <>
                              <span className={style.text}>{result.latencyMs}ms</span>
                              <span className="text-gray-500">HTTP {result.httpStatus}</span>
                            </>
                          ) : (
                            <span className="text-red-400">{result.message}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {testResults.fastest && (
                <div className="mt-3 p-3 bg-green-500/10 rounded text-sm text-green-400">
                  推荐使用: {testResults.fastest.url} ({testResults.fastest.latencyMs}ms)
                </div>
              )}
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

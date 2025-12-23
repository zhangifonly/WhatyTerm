import React, { useState, useEffect } from 'react';

/**
 * 健康检查日志组件
 * 显示供应商的历史健康检查记录
 */
export default function HealthCheckLogs({ appType, providerId, provider, onClose }) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [limit, setLimit] = useState(20);

  // 加载日志
  useEffect(() => {
    loadLogs();
  }, [appType, providerId, limit]);

  const loadLogs = async () => {
    try {
      const res = await fetch(`/api/providers/${appType}/${providerId}/check-logs?limit=${limit}`);
      const data = await res.json();
      setLogs(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('加载日志失败:', err);
    } finally {
      setLoading(false);
    }
  };

  // 获取状态样式
  const getStatusStyle = (status) => {
    const styles = {
      operational: { bg: 'bg-green-500/10', text: 'text-green-400', label: '正常' },
      degraded: { bg: 'bg-yellow-500/10', text: 'text-yellow-400', label: '降级' },
      failed: { bg: 'bg-red-500/10', text: 'text-red-400', label: '失败' }
    };
    return styles[status] || { bg: 'bg-gray-500/10', text: 'text-gray-400', label: '未知' };
  };

  // 格式化时间
  const formatTime = (timestamp) => {
    if (!timestamp) return '-';
    return new Date(timestamp).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  };

  // 计算统计数据
  const stats = {
    total: logs.length,
    success: logs.filter(l => l.success).length,
    failed: logs.filter(l => !l.success).length,
    avgResponseTime: logs.filter(l => l.responseTimeMs).length > 0
      ? Math.round(logs.filter(l => l.responseTimeMs).reduce((sum, l) => sum + l.responseTimeMs, 0) / logs.filter(l => l.responseTimeMs).length)
      : 0
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
            <h2 className="text-lg font-medium text-white">健康检查日志</h2>
            <p className="text-sm text-gray-400">{provider?.name}</p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white text-xl"
          >
            ×
          </button>
        </div>

        {/* 统计信息 */}
        <div className="p-4 border-b border-gray-700">
          <div className="grid grid-cols-4 gap-4">
            <div className="bg-gray-800 rounded p-3 text-center">
              <div className="text-2xl font-bold text-white">{stats.total}</div>
              <div className="text-xs text-gray-400">总检查次数</div>
            </div>
            <div className="bg-green-500/10 rounded p-3 text-center">
              <div className="text-2xl font-bold text-green-400">{stats.success}</div>
              <div className="text-xs text-gray-400">成功</div>
            </div>
            <div className="bg-red-500/10 rounded p-3 text-center">
              <div className="text-2xl font-bold text-red-400">{stats.failed}</div>
              <div className="text-xs text-gray-400">失败</div>
            </div>
            <div className="bg-blue-500/10 rounded p-3 text-center">
              <div className="text-2xl font-bold text-blue-400">{stats.avgResponseTime}ms</div>
              <div className="text-xs text-gray-400">平均响应</div>
            </div>
          </div>
        </div>

        {/* 内容 */}
        <div className="p-4 overflow-y-auto max-h-[50vh]">
          {/* 数量选择 */}
          <div className="flex items-center justify-between mb-4">
            <div className="text-sm text-gray-400">
              显示最近 {logs.length} 条记录
            </div>
            <select
              value={limit}
              onChange={e => setLimit(parseInt(e.target.value))}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-white focus:outline-none"
            >
              <option value={10}>10 条</option>
              <option value={20}>20 条</option>
              <option value={50}>50 条</option>
              <option value={100}>100 条</option>
            </select>
          </div>

          {loading ? (
            <div className="text-gray-400 text-sm py-8 text-center">加载中...</div>
          ) : logs.length === 0 ? (
            <div className="text-gray-500 text-sm py-8 text-center bg-gray-800 rounded">
              暂无检查记录
            </div>
          ) : (
            <div className="space-y-2">
              {logs.map((log, index) => {
                const style = getStatusStyle(log.status);
                return (
                  <div
                    key={log.id || index}
                    className={`${style.bg} rounded p-3`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className={`font-medium ${style.text}`}>
                          {log.success ? '✓' : '✗'} {style.label}
                        </span>
                        {log.responseTimeMs && (
                          <span className="text-gray-400 text-sm">
                            {log.responseTimeMs}ms
                          </span>
                        )}
                        {log.httpStatus && (
                          <span className="text-gray-500 text-xs">
                            HTTP {log.httpStatus}
                          </span>
                        )}
                        {log.retryCount > 0 && (
                          <span className="text-yellow-400 text-xs">
                            重试 {log.retryCount} 次
                          </span>
                        )}
                      </div>
                      <div className="text-gray-500 text-xs">
                        {formatTime(log.testedAt)}
                      </div>
                    </div>
                    {log.message && log.message !== '检查成功' && (
                      <div className="text-sm text-gray-400 mt-2 truncate">
                        {log.message}
                      </div>
                    )}
                    {log.modelUsed && (
                      <div className="text-xs text-gray-500 mt-1">
                        测试模型: {log.modelUsed}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 底部 */}
        <div className="flex justify-between items-center p-4 border-t border-gray-700">
          <button
            onClick={loadLogs}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded transition-colors"
          >
            刷新
          </button>
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

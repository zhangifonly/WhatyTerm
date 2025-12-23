import React, { useState, useEffect } from 'react';
import ProviderEditor from './ProviderEditor';
import { toast } from '../Toast';

/**
 * 供应商卡片组件 - 简化版
 */
export default function ProviderCard({ provider, appType = 'claude', isCurrent, onSwitch, onDelete, onHealthCheck, socket }) {
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState(null);
  const [switching, setSwitching] = useState(false);
  const [showEditor, setShowEditor] = useState(false);

  // 监听健康检查事件
  useEffect(() => {
    if (!socket) return;

    const handleHealthCheckComplete = (data) => {
      if (data.providerId === provider.id) {
        setCheckResult(data.result);
        setChecking(false);
      }
    };

    socket.on('provider:health-check:complete', handleHealthCheckComplete);

    return () => {
      socket.off('provider:health-check:complete', handleHealthCheckComplete);
    };
  }, [socket, provider.id]);

  // 健康检查
  const handleCheck = async () => {
    setChecking(true);
    setCheckResult(null);

    const result = await onHealthCheck(provider.id);

    if (!result.success) {
      setCheckResult({
        success: false,
        status: 'failed',
        message: result.error
      });
      setChecking(false);
    }
  };

  // 切换供应商
  const handleSwitch = async () => {
    setSwitching(true);
    const result = await onSwitch(provider.id);
    setSwitching(false);

    if (!result.success) {
      toast.error(`切换失败: ${result.error}`);
    }
  };

  // 获取 API 类型
  const getApiType = () => {
    if (provider.settingsConfig?.apiType === 'openai') {
      return 'OpenAI';
    } else if (provider.settingsConfig?.apiType === 'claude') {
      return 'Claude';
    }
    return '未知';
  };

  // 获取 API URL
  const getApiUrl = () => {
    const config = provider.settingsConfig;
    if (config?.apiType === 'openai' && config?.openai?.apiUrl) {
      return config.openai.apiUrl;
    } else if (config?.apiType === 'claude' && config?.claude?.apiUrl) {
      return config.claude.apiUrl;
    }
    return '';
  };

  return (
    <div
      className={`bg-gray-800 border rounded-lg p-4 transition-all ${
        isCurrent ? 'border-blue-500 shadow-lg shadow-blue-500/20' : 'border-gray-700'
      }`}
    >
      {/* 头部 */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-lg font-medium text-white">
              {provider.name}
            </h3>
            {isCurrent && (
              <span className="px-2 py-0.5 bg-blue-500 text-white text-xs rounded">
                当前
              </span>
            )}
          </div>
          <div className="text-sm text-gray-400">
            {getApiType()}
          </div>
        </div>

        {/* 操作按钮 */}
        <div className="flex gap-2">
          <button
            onClick={() => setShowEditor(true)}
            className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded transition-colors"
          >
            编辑
          </button>
          {!isCurrent && (
            <button
              onClick={handleSwitch}
              disabled={switching}
              className="px-3 py-1.5 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm rounded transition-colors"
            >
              {switching ? '...' : '切换'}
            </button>
          )}
          <button
            onClick={handleCheck}
            disabled={checking}
            className="px-3 py-1.5 bg-green-600 hover:bg-green-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm rounded transition-colors"
          >
            {checking ? '...' : '检测'}
          </button>
          <button
            onClick={() => onDelete(provider.id)}
            disabled={isCurrent}
            title={isCurrent ? '无法删除当前供应商' : '删除'}
            className="px-3 py-1.5 bg-red-600 hover:bg-red-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm rounded transition-colors"
          >
            删除
          </button>
        </div>
      </div>

      {/* API URL */}
      <div className="text-sm text-gray-400 font-mono truncate">
        {getApiUrl()}
      </div>

      {/* 健康检查结果 */}
      {checkResult && (
        <div className={`mt-3 p-2 rounded text-sm ${
          checkResult.success ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'
        }`}>
          {checkResult.success ? '✓ 正常' : '✗ 失败'}
          {checkResult.responseTimeMs && ` (${checkResult.responseTimeMs}ms)`}
          {checkResult.message && checkResult.message !== '检查成功' && (
            <span className="ml-2 text-gray-400">{checkResult.message}</span>
          )}
        </div>
      )}

      {/* 编辑器弹窗 */}
      {showEditor && (
        <ProviderEditor
          appType={appType}
          providerId={provider.id}
          provider={provider}
          onClose={() => setShowEditor(false)}
        />
      )}
    </div>
  );
}

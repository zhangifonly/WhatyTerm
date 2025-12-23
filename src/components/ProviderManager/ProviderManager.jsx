import React, { useState, useEffect } from 'react';
import PresetSelector from './PresetSelector';
import ProviderList from './ProviderList';

/**
 * Provider 管理主组件 - 简化版
 */
export default function ProviderManager({ socket }) {
  const [providers, setProviders] = useState({ current: null, providers: {} });
  const [presets, setPresets] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('list'); // 'list' | 'presets'
  const [appType] = useState('claude'); // 当前仅支持 claude

  // 加载供应商列表
  const loadProviders = async () => {
    try {
      const res = await fetch(`/api/providers/${appType}`);
      const data = await res.json();
      setProviders(data);
    } catch (error) {
      console.error('加载供应商失败:', error);
    }
  };

  // 加载预设列表
  const loadPresets = async () => {
    try {
      const [presetsRes, categoriesRes] = await Promise.all([
        fetch('/api/providers/presets'),
        fetch('/api/providers/presets/categories')
      ]);

      const presetsData = await presetsRes.json();
      const categoriesData = await categoriesRes.json();

      setPresets(presetsData);
      setCategories(categoriesData);
    } catch (error) {
      console.error('加载预设失败:', error);
    }
  };

  // 初始化
  useEffect(() => {
    const init = async () => {
      setLoading(true);
      await Promise.all([loadProviders(), loadPresets()]);
      setLoading(false);
    };

    init();
  }, []);

  // 监听 Socket.IO 事件
  useEffect(() => {
    if (!socket) return;

    const handleProviderAdded = () => {
      loadProviders();
    };

    const handleProviderUpdated = () => {
      loadProviders();
    };

    const handleProviderDeleted = () => {
      loadProviders();
    };

    const handleProviderSwitched = () => {
      loadProviders();
    };

    socket.on('provider:added', handleProviderAdded);
    socket.on('provider:updated', handleProviderUpdated);
    socket.on('provider:deleted', handleProviderDeleted);
    socket.on('provider:switched', handleProviderSwitched);

    return () => {
      socket.off('provider:added', handleProviderAdded);
      socket.off('provider:updated', handleProviderUpdated);
      socket.off('provider:deleted', handleProviderDeleted);
      socket.off('provider:switched', handleProviderSwitched);
    };
  }, [socket]);

  // 应用预设
  const handleApplyPreset = async (presetId, customValues) => {
    try {
      const res = await fetch(`/api/providers/presets/${presetId}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appType,
          apiKey: customValues.apiKey,
          templateVariables: customValues.templateVariables
        })
      });

      const data = await res.json();

      if (data.success) {
        await loadProviders();
        setActiveTab('list'); // 切换到列表视图
        return { success: true, provider: data.provider };
      } else {
        return { success: false, error: data.error };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  };

  // 切换供应商
  const handleSwitch = async (providerId) => {
    try {
      const res = await fetch(`/api/providers/${appType}/${providerId}/switch`, {
        method: 'POST'
      });

      const data = await res.json();

      if (data.success) {
        await loadProviders();
        return { success: true };
      } else {
        return { success: false, error: data.error };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  };

  // 删除供应商
  const handleDelete = async (providerId) => {
    try {
      const res = await fetch(`/api/providers/${appType}/${providerId}`, {
        method: 'DELETE'
      });

      const data = await res.json();

      if (data.success) {
        await loadProviders();
        return { success: true };
      } else {
        return { success: false, error: data.error };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  };

  // 健康检查
  const handleHealthCheck = async (providerId) => {
    try {
      const res = await fetch(`/api/providers/${appType}/${providerId}/health-check`, {
        method: 'POST'
      });

      const data = await res.json();

      if (data.success) {
        return { success: true, result: data.result };
      } else {
        return { success: false, error: data.error };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">加载中...</div>
      </div>
    );
  }

  return (
    <div className="provider-manager">
      {/* 标签切换 */}
      <div className="flex items-center border-b border-gray-700 mb-4">
        <button
          onClick={() => setActiveTab('list')}
          className={`px-4 py-2 font-medium transition-colors ${
            activeTab === 'list'
              ? 'text-blue-400 border-b-2 border-blue-400'
              : 'text-gray-400 hover:text-gray-300'
          }`}
        >
          供应商列表
          <span className="ml-2 text-xs bg-gray-700 px-2 py-0.5 rounded">
            {Object.keys(providers.providers).length}
          </span>
        </button>
        <button
          onClick={() => setActiveTab('presets')}
          className={`px-4 py-2 font-medium transition-colors ${
            activeTab === 'presets'
              ? 'text-blue-400 border-b-2 border-blue-400'
              : 'text-gray-400 hover:text-gray-300'
          }`}
        >
          预设模板
          <span className="ml-2 text-xs bg-gray-700 px-2 py-0.5 rounded">
            {presets.length}
          </span>
        </button>
      </div>

      {/* 内容区域 */}
      <div className="providers-tab">
        {activeTab === 'list' ? (
          <ProviderList
            providers={providers}
            appType={appType}
            onSwitch={handleSwitch}
            onDelete={handleDelete}
            onHealthCheck={handleHealthCheck}
            socket={socket}
          />
        ) : (
          <PresetSelector
            presets={presets}
            categories={categories}
            onApply={handleApplyPreset}
          />
        )}
      </div>
    </div>
  );
}

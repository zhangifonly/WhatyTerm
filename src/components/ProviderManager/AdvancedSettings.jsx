import React, { useState, useEffect } from 'react';
import { toast } from '../Toast';

// Claude 模型降级列表（与后端保持一致）
const CLAUDE_MODEL_FALLBACK_LIST = [
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-5-20250929',
];

/**
 * 高级设置组件
 * 包含健康检查配置、自动故障转移、定时健康检查
 */
export default function AdvancedSettings({ onClose, embedded = false }) {
  const [activeTab, setActiveTab] = useState('health-check'); // 'health-check' | 'failover' | 'scheduler'
  const [healthCheckConfig, setHealthCheckConfig] = useState({
    timeoutSecs: 45,
    maxRetries: 2,
    degradedThresholdMs: 6000,
    testModels: {
      claude: 'claude-haiku-4-5-20251001',
      codex: 'gpt-4o-mini',
      gemini: 'gemini-2.0-flash'
    }
  });
  const [failoverConfig, setFailoverConfig] = useState({
    enabled: false,
    maxRetries: 3,
    retryDelayMs: 5000,
    fallbackOrder: [], // 按优先级排序的供应商 ID 列表
    excludeFromFailover: [] // 不参与故障转移的供应商 ID 列表
  });
  const [schedulerConfig, setSchedulerConfig] = useState({
    enabled: false,
    intervalMinutes: 30,
    checkOnStartup: true,
    notifyOnFailure: false
  });
  const [memoryLimitConfig, setMemoryLimitConfig] = useState({
    enabled: false,
    limitMB: 1024,
    warningMB: 512,
    autoKillOnLimit: false,
    pauseAutoActionOnLimit: true
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // 模型测试相关状态
  const [testingModels, setTestingModels] = useState(false);
  const [availableModels, setAvailableModels] = useState([]);
  const [testProgress, setTestProgress] = useState('');

  // 加载所有配置
  useEffect(() => {
    loadConfigs();
  }, []);

  const loadConfigs = async () => {
    try {
      const [healthRes, failoverRes, schedulerRes, memoryLimitRes] = await Promise.all([
        fetch('/api/config/health-check'),
        fetch('/api/config/failover'),
        fetch('/api/config/scheduler'),
        fetch('/api/config/memory-limit')
      ]);

      const [healthData, failoverData, schedulerData, memoryLimitData] = await Promise.all([
        healthRes.json(),
        failoverRes.json(),
        schedulerRes.json(),
        memoryLimitRes.json()
      ]);

      setHealthCheckConfig(prev => ({ ...prev, ...healthData }));
      setFailoverConfig(prev => ({ ...prev, ...failoverData }));
      setSchedulerConfig(prev => ({ ...prev, ...schedulerData }));
      setMemoryLimitConfig(prev => ({ ...prev, ...memoryLimitData }));
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
      const endpoints = {
        'health-check': {
          url: '/api/config/health-check',
          data: healthCheckConfig
        },
        'failover': {
          url: '/api/config/failover',
          data: failoverConfig
        },
        'scheduler': {
          url: '/api/config/scheduler',
          data: schedulerConfig
        },
        'memory-limit': {
          url: '/api/config/memory-limit',
          data: memoryLimitConfig
        }
      };

      const endpoint = endpoints[activeTab];
      const res = await fetch(endpoint.url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(endpoint.data)
      });

      const data = await res.json();

      if (data.success) {
        toast.success('配置已保存');
      } else {
        toast.error(data.error || '保存失败');
      }
    } catch (err) {
      toast.error('保存失败: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  // 测试 Claude 模型
  const handleTestClaudeModels = async () => {
    setTestingModels(true);
    setTestProgress('正在获取供应商配置...');
    setAvailableModels([]);

    try {
      // 先获取当前 Claude 供应商配置
      const providerRes = await fetch('/api/providers/claude');
      const providerData = await providerRes.json();

      if (!providerData.success || !providerData.providers) {
        toast.error('未找到 Claude 供应商配置');
        return;
      }

      // 获取第一个供应商（当前使用的）
      const providers = Object.values(providerData.providers);
      if (providers.length === 0) {
        toast.error('未配置 Claude 供应商');
        return;
      }

      const currentProvider = providers[0];
      setTestProgress(`正在测试 ${CLAUDE_MODEL_FALLBACK_LIST.length} 个模型...`);

      // 调用多模型测试接口
      const testRes = await fetch('/api/providers/claude/test-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          settingsConfig: currentProvider.settingsConfig,
          models: CLAUDE_MODEL_FALLBACK_LIST
        })
      });

      const testData = await testRes.json();

      if (testData.success) {
        setAvailableModels(testData.availableModels || []);

        if (testData.availableModels?.length > 0) {
          // 自动选择第一个可用模型
          const firstModel = testData.availableModels[0].model;
          setHealthCheckConfig(prev => ({
            ...prev,
            testModels: { ...prev.testModels, claude: firstModel }
          }));
          toast.success(`找到 ${testData.availableModels.length} 个可用模型`);
        } else {
          toast.error('没有可用的模型');
        }

        if (testData.failedModels?.length > 0) {
          console.log('不可用的模型:', testData.failedModels);
        }
      } else {
        toast.error(testData.error || '测试失败');
      }
    } catch (err) {
      toast.error('测试失败: ' + err.message);
    } finally {
      setTestingModels(false);
      setTestProgress('');
    }
  };

  // 渲染健康检查配置
  const renderHealthCheckTab = () => (
    <div className="space-y-4">
      <div>
        <label className="block text-sm text-gray-400 mb-2">超时时间（秒）</label>
        <input
          type="number"
          value={healthCheckConfig.timeoutSecs}
          onChange={e => setHealthCheckConfig(prev => ({ ...prev, timeoutSecs: parseInt(e.target.value) || 45 }))}
          className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
          min="5"
          max="120"
        />
        <p className="text-xs text-gray-500 mt-1">API 请求的最大等待时间，建议 30-60 秒</p>
      </div>

      <div>
        <label className="block text-sm text-gray-400 mb-2">最大重试次数</label>
        <input
          type="number"
          value={healthCheckConfig.maxRetries}
          onChange={e => setHealthCheckConfig(prev => ({ ...prev, maxRetries: parseInt(e.target.value) || 2 }))}
          className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
          min="0"
          max="5"
        />
        <p className="text-xs text-gray-500 mt-1">超时或网络错误时的重试次数</p>
      </div>

      <div>
        <label className="block text-sm text-gray-400 mb-2">降级阈值（毫秒）</label>
        <input
          type="number"
          value={healthCheckConfig.degradedThresholdMs}
          onChange={e => setHealthCheckConfig(prev => ({ ...prev, degradedThresholdMs: parseInt(e.target.value) || 6000 }))}
          className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
          min="1000"
          max="30000"
          step="1000"
        />
        <p className="text-xs text-gray-500 mt-1">响应时间超过此值将标记为"降级"状态</p>
      </div>

      <div className="border-t border-gray-700 pt-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm text-gray-300">Claude 监控模型</h3>
          <button
            onClick={handleTestClaudeModels}
            disabled={testingModels}
            className="px-3 py-1 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-xs rounded transition-colors"
          >
            {testingModels ? '测试中...' : '测试可用模型'}
          </button>
        </div>

        {/* 测试进度 */}
        {testProgress && (
          <div className="mb-3 p-2 bg-blue-500/10 border border-blue-500/30 rounded text-xs text-blue-400">
            {testProgress}
          </div>
        )}

        {/* 可用模型列表 */}
        {availableModels.length > 0 && (
          <div className="mb-3 p-2 bg-green-500/10 border border-green-500/30 rounded">
            <div className="text-xs text-green-400 mb-2">可用模型（点击选择）：</div>
            <div className="space-y-1">
              {availableModels.map(m => (
                <button
                  key={m.model}
                  onClick={() => setHealthCheckConfig(prev => ({
                    ...prev,
                    testModels: { ...prev.testModels, claude: m.model }
                  }))}
                  className={`w-full text-left px-2 py-1 rounded text-xs transition-colors ${
                    healthCheckConfig.testModels?.claude === m.model
                      ? 'bg-green-500/30 text-green-300'
                      : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                  }`}
                >
                  {m.model}
                  <span className="text-gray-500 ml-2">({m.responseTimeMs}ms)</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 当前选择的模型 */}
        <div>
          <label className="block text-xs text-gray-500 mb-1">当前监控模型</label>
          <select
            value={healthCheckConfig.testModels?.claude || ''}
            onChange={e => setHealthCheckConfig(prev => ({
              ...prev,
              testModels: { ...prev.testModels, claude: e.target.value }
            }))}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
          >
            {/* 如果有可用模型，显示可用模型列表 */}
            {availableModels.length > 0 ? (
              availableModels.map(m => (
                <option key={m.model} value={m.model}>{m.model}</option>
              ))
            ) : (
              /* 否则显示默认列表 */
              CLAUDE_MODEL_FALLBACK_LIST.map(model => (
                <option key={model} value={model}>{model}</option>
              ))
            )}
          </select>
          <p className="text-xs text-gray-500 mt-1">
            点击"测试可用模型"自动检测哪些模型可用
          </p>
        </div>

        {/* OpenAI 模型 */}
        <div className="mt-3">
          <label className="block text-xs text-gray-500 mb-1">OpenAI/Codex 模型</label>
          <input
            type="text"
            value={healthCheckConfig.testModels?.codex || ''}
            onChange={e => setHealthCheckConfig(prev => ({
              ...prev,
              testModels: { ...prev.testModels, codex: e.target.value }
            }))}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
            placeholder="gpt-4o-mini"
          />
        </div>
      </div>
    </div>
  );

  // 渲染故障转移配置
  const renderFailoverTab = () => (
    <div className="space-y-4">
      <div className="flex items-center justify-between p-3 bg-gray-800 rounded">
        <div>
          <div className="text-sm text-white mb-1">启用自动故障转移</div>
          <div className="text-xs text-gray-400">当前供应商失败时自动切换到备用供应商</div>
        </div>
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={failoverConfig.enabled}
            onChange={e => setFailoverConfig(prev => ({ ...prev, enabled: e.target.checked }))}
            className="sr-only peer"
          />
          <div className="w-11 h-6 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-500"></div>
        </label>
      </div>

      {failoverConfig.enabled && (
        <>
          <div>
            <label className="block text-sm text-gray-400 mb-2">故障转移最大重试次数</label>
            <input
              type="number"
              value={failoverConfig.maxRetries}
              onChange={e => setFailoverConfig(prev => ({ ...prev, maxRetries: parseInt(e.target.value) || 3 }))}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
              min="1"
              max="10"
            />
            <p className="text-xs text-gray-500 mt-1">尝试切换到其他供应商的最大次数</p>
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-2">重试延迟（毫秒）</label>
            <input
              type="number"
              value={failoverConfig.retryDelayMs}
              onChange={e => setFailoverConfig(prev => ({ ...prev, retryDelayMs: parseInt(e.target.value) || 5000 }))}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
              min="1000"
              max="60000"
              step="1000"
            />
            <p className="text-xs text-gray-500 mt-1">切换供应商前的等待时间</p>
          </div>

          <div className="bg-blue-500/10 border border-blue-500/30 rounded p-3">
            <div className="text-sm text-blue-400 mb-2">💡 故障转移规则</div>
            <ul className="text-xs text-gray-400 space-y-1">
              <li>• 按供应商的 sortIndex 顺序依次尝试</li>
              <li>• 跳过当前正在使用的供应商</li>
              <li>• 优先选择最近健康检查成功的供应商</li>
              <li>• 故障转移成功后会发送通知</li>
            </ul>
          </div>
        </>
      )}
    </div>
  );

  // 渲染定时检查配置
  const renderSchedulerTab = () => (
    <div className="space-y-4">
      <div className="flex items-center justify-between p-3 bg-gray-800 rounded">
        <div>
          <div className="text-sm text-white mb-1">启用定时健康检查</div>
          <div className="text-xs text-gray-400">后台自动定期检查所有供应商的健康状态</div>
        </div>
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={schedulerConfig.enabled}
            onChange={e => setSchedulerConfig(prev => ({ ...prev, enabled: e.target.checked }))}
            className="sr-only peer"
          />
          <div className="w-11 h-6 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-500"></div>
        </label>
      </div>

      {schedulerConfig.enabled && (
        <>
          <div>
            <label className="block text-sm text-gray-400 mb-2">检查间隔（分钟）</label>
            <input
              type="number"
              value={schedulerConfig.intervalMinutes}
              onChange={e => setSchedulerConfig(prev => ({ ...prev, intervalMinutes: parseInt(e.target.value) || 30 }))}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
              min="5"
              max="1440"
            />
            <p className="text-xs text-gray-500 mt-1">建议 15-60 分钟，避免过于频繁</p>
          </div>

          <div className="space-y-3">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={schedulerConfig.checkOnStartup}
                onChange={e => setSchedulerConfig(prev => ({ ...prev, checkOnStartup: e.target.checked }))}
                className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-blue-500"
              />
              <div>
                <div className="text-sm text-gray-300">服务启动时立即检查</div>
                <div className="text-xs text-gray-500">启动后立即执行一次健康检查</div>
              </div>
            </label>

            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={schedulerConfig.notifyOnFailure}
                onChange={e => setSchedulerConfig(prev => ({ ...prev, notifyOnFailure: e.target.checked }))}
                className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-blue-500"
              />
              <div>
                <div className="text-sm text-gray-300">失败时发送通知</div>
                <div className="text-xs text-gray-500">供应商健康检查失败时通知用户</div>
              </div>
            </label>
          </div>

          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded p-3">
            <div className="text-sm text-yellow-400 mb-2">⚠️ 注意事项</div>
            <ul className="text-xs text-gray-400 space-y-1">
              <li>• 定时检查会产生 API 调用费用</li>
              <li>• 建议使用轻量级测试模型</li>
              <li>• 检查间隔不宜过短</li>
            </ul>
          </div>
        </>
      )}
    </div>
  );

  // 渲染内存限制配置
  const renderMemoryLimitTab = () => (
    <div className="space-y-4">
      <div className="flex items-center justify-between p-3 bg-gray-800 rounded">
        <div>
          <div className="text-sm text-white mb-1">启用内存限制</div>
          <div className="text-xs text-gray-400">监控会话子进程的内存使用</div>
        </div>
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={memoryLimitConfig.enabled}
            onChange={e => setMemoryLimitConfig(prev => ({ ...prev, enabled: e.target.checked }))}
            className="sr-only peer"
          />
          <div className="w-11 h-6 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-500"></div>
        </label>
      </div>

      {memoryLimitConfig.enabled && (
        <>
          <div>
            <label className="block text-sm text-gray-400 mb-2">内存限制（MB）</label>
            <input
              type="number"
              value={memoryLimitConfig.limitMB}
              onChange={e => setMemoryLimitConfig(prev => ({ ...prev, limitMB: parseInt(e.target.value) || 1024 }))}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
              min="256"
              max="8192"
              step="256"
            />
            <p className="text-xs text-gray-500 mt-1">超过此值将触发限制操作</p>
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-2">警告阈值（MB）</label>
            <input
              type="number"
              value={memoryLimitConfig.warningMB}
              onChange={e => setMemoryLimitConfig(prev => ({ ...prev, warningMB: parseInt(e.target.value) || 512 }))}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
              min="128"
              max="4096"
              step="128"
            />
            <p className="text-xs text-gray-500 mt-1">超过此值将显示警告提示</p>
          </div>

          <div className="space-y-3">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={memoryLimitConfig.autoKillOnLimit}
                onChange={e => setMemoryLimitConfig(prev => ({ ...prev, autoKillOnLimit: e.target.checked }))}
                className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-blue-500"
              />
              <div>
                <div className="text-sm text-gray-300">超限时自动终止进程</div>
                <div className="text-xs text-gray-500">内存超限时自动杀死子进程</div>
              </div>
            </label>

            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={memoryLimitConfig.pauseAutoActionOnLimit}
                onChange={e => setMemoryLimitConfig(prev => ({ ...prev, pauseAutoActionOnLimit: e.target.checked }))}
                className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-blue-500"
              />
              <div>
                <div className="text-sm text-gray-300">超限时暂停自动操作</div>
                <div className="text-xs text-gray-500">内存超限时暂停 AI 自动操作</div>
              </div>
            </label>
          </div>

          <div className="bg-blue-500/10 border border-blue-500/30 rounded p-3">
            <div className="text-sm text-blue-400 mb-2">💡 内存监控说明</div>
            <ul className="text-xs text-gray-400 space-y-1">
              <li>• 监控每个会话的 tmux 子进程内存使用</li>
              <li>• 包括 Claude Code 及其启动的所有子进程</li>
              <li>• 建议限制值设为 1024-2048 MB</li>
              <li>• 警告阈值应小于限制值</li>
            </ul>
          </div>

          {memoryLimitConfig.autoKillOnLimit && (
            <div className="bg-red-500/10 border border-red-500/30 rounded p-3">
              <div className="text-sm text-red-400 mb-2">⚠️ 警告</div>
              <p className="text-xs text-gray-400">
                启用自动终止进程可能导致未保存的工作丢失。建议仅在测试环境或有自动保存机制时启用。
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );

  // 内容部分（嵌入模式和弹窗模式共用）
  const content = (
    <>
      {/* 标签切换 */}
      <div className="flex border-b border-gray-700">
        <button
          onClick={() => setActiveTab('health-check')}
          className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
            activeTab === 'health-check'
              ? 'text-blue-400 border-b-2 border-blue-400 bg-gray-800/50'
              : 'text-gray-400 hover:text-gray-300'
          }`}
        >
          健康检查
        </button>
        <button
          onClick={() => setActiveTab('failover')}
          className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
            activeTab === 'failover'
              ? 'text-blue-400 border-b-2 border-blue-400 bg-gray-800/50'
              : 'text-gray-400 hover:text-gray-300'
          }`}
        >
          故障转移
        </button>
        <button
          onClick={() => setActiveTab('scheduler')}
          className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
            activeTab === 'scheduler'
              ? 'text-blue-400 border-b-2 border-blue-400 bg-gray-800/50'
              : 'text-gray-400 hover:text-gray-300'
          }`}
        >
          定时检查
        </button>
        <button
          onClick={() => setActiveTab('memory-limit')}
          className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
            activeTab === 'memory-limit'
              ? 'text-blue-400 border-b-2 border-blue-400 bg-gray-800/50'
              : 'text-gray-400 hover:text-gray-300'
          }`}
        >
          内存限制
        </button>
      </div>

      {/* 内容 */}
      <div className={`p-4 overflow-y-auto ${embedded ? 'max-h-[400px]' : 'max-h-[55vh]'}`}>
        {loading ? (
          <div className="text-gray-400 text-sm py-8 text-center">加载中...</div>
        ) : (
          <>
            {activeTab === 'health-check' && renderHealthCheckTab()}
            {activeTab === 'failover' && renderFailoverTab()}
            {activeTab === 'scheduler' && renderSchedulerTab()}
            {activeTab === 'memory-limit' && renderMemoryLimitTab()}
          </>
        )}
      </div>

      {/* 底部 */}
      <div className="flex justify-end gap-2 p-4 border-t border-gray-700">
        {!embedded && (
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded transition-colors"
          >
            取消
          </button>
        )}
        <button
          onClick={handleSave}
          disabled={saving || loading}
          className="px-4 py-2 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm rounded transition-colors"
        >
          {saving ? '保存中...' : '保存'}
        </button>
      </div>
    </>
  );

  // 嵌入模式：直接返回内容
  if (embedded) {
    return (
      <div className="bg-gray-900 rounded-lg overflow-hidden">
        {content}
      </div>
    );
  }

  // 弹窗模式
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-gray-900 rounded-lg w-full max-w-2xl max-h-[85vh] overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <h2 className="text-lg font-medium text-white">高级设置</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white text-xl"
          >
            ×
          </button>
        </div>
        {content}
      </div>
    </div>
  );
}

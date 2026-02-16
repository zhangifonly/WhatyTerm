import { useState, useEffect } from 'react';

/**
 * 订阅管理组件
 * 显示订阅状态、激活许可证、管理订阅
 * 支持两种激活方式：
 * 1. 邮箱+密码登录激活（推荐）
 * 2. 激活码直接激活（兼容旧方式）
 */
export default function SubscriptionManager({ onClose }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activating, setActivating] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [message, setMessage] = useState(null);

  // 激活方式切换
  const [activationMode, setActivationMode] = useState('login'); // 'login' | 'code'

  // 邮箱+密码登录
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // 激活码
  const [activationCode, setActivationCode] = useState('');

  // 加载订阅状态
  useEffect(() => {
    loadStatus();
  }, []);

  const loadStatus = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/subscription/status');
      const data = await res.json();
      setStatus(data);
    } catch (err) {
      setMessage({ type: 'error', text: '加载订阅状态失败' });
    } finally {
      setLoading(false);
    }
  };

  // 激活许可证（激活码方式）
  const handleActivateByCode = async () => {
    if (!activationCode.trim()) {
      setMessage({ type: 'error', text: '请输入激活码' });
      return;
    }

    try {
      setActivating(true);
      setMessage(null);

      const res = await fetch('/api/subscription/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: activationCode.trim() })
      });

      const result = await res.json();

      if (result.success) {
        setMessage({ type: 'success', text: '激活成功！' });
        setActivationCode('');
        await loadStatus();
      } else {
        setMessage({ type: 'error', text: result.message || '激活失败' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: '网络错误，请稍后重试' });
    } finally {
      setActivating(false);
    }
  };

  // 激活许可证（邮箱+密码方式）
  const handleActivateByLogin = async () => {
    if (!email.trim() || !password.trim()) {
      setMessage({ type: 'error', text: '请输入邮箱和密码' });
      return;
    }

    try {
      setActivating(true);
      setMessage(null);

      const res = await fetch('/api/subscription/activate-by-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          password: password.trim()
        })
      });

      const result = await res.json();

      if (result.success) {
        setMessage({ type: 'success', text: '激活成功！' });
        setEmail('');
        setPassword('');
        await loadStatus();
      } else {
        setMessage({ type: 'error', text: result.message || '激活失败' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: '网络错误，请稍后重试' });
    } finally {
      setActivating(false);
    }
  };

  // 激活处理（根据当前模式）
  const handleActivate = () => {
    if (activationMode === 'login') {
      handleActivateByLogin();
    } else {
      handleActivateByCode();
    }
  };

  // 在线验证
  const handleVerify = async () => {
    try {
      setVerifying(true);
      setMessage(null);

      const res = await fetch('/api/subscription/verify', {
        method: 'POST'
      });

      const result = await res.json();

      if (result.success) {
        setMessage({ type: 'success', text: result.message || '验证成功' });
        await loadStatus();
      } else {
        setMessage({ type: 'error', text: result.message || '验证失败' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: '网络错误，请稍后重试' });
    } finally {
      setVerifying(false);
    }
  };

  // 停用许可证
  const handleDeactivate = async () => {
    if (!confirm('确定要停用许可证吗？停用后将无法使用高级功能。')) {
      return;
    }

    try {
      setMessage(null);

      const res = await fetch('/api/subscription/deactivate', {
        method: 'POST'
      });

      const result = await res.json();

      if (result.success) {
        setMessage({ type: 'success', text: '许可证已停用' });
        await loadStatus();
      } else {
        setMessage({ type: 'error', text: result.message || '停用失败' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: '网络错误，请稍后重试' });
    }
  };

  // 打开订阅页面
  const openSubscriptionPage = () => {
    if (status?.subscriptionUrl) {
      window.open(status.subscriptionUrl, '_blank');
    }
  };

  // 复制机器 ID
  const copyMachineId = () => {
    if (status?.machineId) {
      navigator.clipboard.writeText(status.machineId);
      setMessage({ type: 'success', text: '机器 ID 已复制' });
      setTimeout(() => setMessage(null), 2000);
    }
  };

  if (loading) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-gray-800 rounded-lg p-6 w-full max-w-md">
          <div className="text-center text-gray-400">加载中...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
        {/* 标题 */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold text-white">订阅管理</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 消息提示 */}
        {message && (
          <div className={`mb-4 p-3 rounded ${
            message.type === 'success' ? 'bg-green-900/50 text-green-400' : 'bg-red-900/50 text-red-400'
          }`}>
            {message.text}
          </div>
        )}

        {/* 订阅状态 */}
        <div className="mb-6 p-4 bg-gray-700/50 rounded-lg">
          <div className="flex items-center justify-between mb-3">
            <span className="text-gray-400">订阅状态</span>
            <span className={`px-2 py-1 rounded text-sm ${
              status?.valid ? 'bg-green-900/50 text-green-400' : 'bg-gray-600 text-gray-400'
            }`}>
              {status?.valid ? '已激活' : '未激活'}
            </span>
          </div>

          {status?.valid && status?.info && (
            <>
              <div className="flex items-center justify-between mb-2">
                <span className="text-gray-400">订阅类型</span>
                <span className="text-white">{status.info.plan}</span>
              </div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-gray-400">邮箱</span>
                <span className="text-white">{status.info.email}</span>
              </div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-gray-400">到期时间</span>
                <span className="text-white">
                  {new Date(status.info.expiresAt).toLocaleDateString()}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-gray-400">剩余天数</span>
                <span className={`${
                  status.remainingDays <= 7 ? 'text-yellow-400' : 'text-white'
                }`}>
                  {status.remainingDays} 天
                </span>
              </div>
            </>
          )}
        </div>

        {/* 机器 ID */}
        <div className="mb-6 p-4 bg-gray-700/50 rounded-lg">
          <div className="flex items-center justify-between mb-2">
            <span className="text-gray-400">机器 ID</span>
            <button
              onClick={copyMachineId}
              className="text-blue-400 hover:text-blue-300 text-sm"
            >
              复制
            </button>
          </div>
          <code className="text-xs text-gray-300 break-all">{status?.machineId}</code>
          <p className="text-xs text-gray-500 mt-2">
            购买订阅时需要提供此 ID
          </p>
        </div>

        {/* 可用插件 */}
        <div className="mb-6">
          <h3 className="text-sm font-medium text-gray-400 mb-3">可用监控策略</h3>
          <div className="grid grid-cols-2 gap-2">
            {status?.availablePlugins?.map(id => (
              <div key={id} className="px-3 py-2 bg-gray-700/50 rounded text-sm text-green-400">
                {id}
              </div>
            ))}
          </div>
        </div>

        {/* 激活区域 */}
        {!status?.valid && (
          <div className="mb-6 p-4 bg-gray-700/50 rounded-lg">
            <h3 className="text-sm font-medium text-white mb-3">激活许可证</h3>

            {/* 激活方式切换 */}
            <div className="flex mb-4 bg-gray-600 rounded-lg p-1">
              <button
                onClick={() => setActivationMode('login')}
                className={`flex-1 py-2 px-3 rounded text-sm transition-colors ${
                  activationMode === 'login'
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-400 hover:text-white'
                }`}
              >
                邮箱登录
              </button>
              <button
                onClick={() => setActivationMode('code')}
                className={`flex-1 py-2 px-3 rounded text-sm transition-colors ${
                  activationMode === 'code'
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-400 hover:text-white'
                }`}
              >
                激活码
              </button>
            </div>

            {/* 邮箱+密码登录表单 */}
            {activationMode === 'login' && (
              <div className="space-y-3 mb-3">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="邮箱"
                  className="w-full px-3 py-2 bg-gray-600 border border-gray-500 rounded text-white placeholder-gray-400 focus:outline-none focus:border-blue-500"
                />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="密码"
                  className="w-full px-3 py-2 bg-gray-600 border border-gray-500 rounded text-white placeholder-gray-400 focus:outline-none focus:border-blue-500"
                />
                <button
                  onClick={handleActivate}
                  disabled={activating}
                  className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 text-white rounded"
                >
                  {activating ? '激活中...' : '登录并激活'}
                </button>
                <div className="flex justify-between text-xs text-gray-500">
                  <a href={status?.subscriptionUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">
                    注册账户
                  </a>
                  <a href={`${status?.subscriptionUrl?.replace(/\?.*$/, '')}/reset-password.html`} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">
                    忘记密码？
                  </a>
                </div>
              </div>
            )}

            {/* 激活码表单 */}
            {activationMode === 'code' && (
              <div className="space-y-3 mb-3">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={activationCode}
                    onChange={(e) => setActivationCode(e.target.value)}
                    placeholder="输入激活码"
                    className="flex-1 px-3 py-2 bg-gray-600 border border-gray-500 rounded text-white placeholder-gray-400 focus:outline-none focus:border-blue-500"
                  />
                  <button
                    onClick={handleActivate}
                    disabled={activating}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 text-white rounded"
                  >
                    {activating ? '激活中...' : '激活'}
                  </button>
                </div>
              </div>
            )}

            <button
              onClick={openSubscriptionPage}
              className="w-full px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded"
            >
              购买订阅
            </button>
          </div>
        )}

        {/* 已激活的操作 */}
        {status?.valid && (
          <div className="flex gap-3">
            <button
              onClick={handleVerify}
              disabled={verifying}
              className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 text-white rounded"
            >
              {verifying ? '验证中...' : '在线验证'}
            </button>
            <button
              onClick={handleDeactivate}
              className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded"
            >
              停用
            </button>
          </div>
        )}

        {/* 缓存状态 */}
        {status?.lastVerifyTime && (
          <div className="mt-4 text-xs text-gray-500 text-center">
            上次验证: {new Date(status.lastVerifyTime).toLocaleString()}
            {status.cacheValid && ' (缓存有效)'}
          </div>
        )}
      </div>
    </div>
  );
}

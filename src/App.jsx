import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { io } from 'socket.io-client';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import Anser from 'anser';
import { ToastContainer, toast } from './components/Toast';
import { useTranslation } from './i18n';

const socket = io();

// 防止终端输入重复发送（解决 React StrictMode / HMR 导致的重复问题）
let lastInputTime = 0;
let lastInputData = '';
const INPUT_DEBOUNCE_MS = 50; // 50ms 内的相同输入视为重复

// 认证状态 Hook
function useAuth() {
  const [authStatus, setAuthStatus] = useState({ loading: true, authenticated: false, enabled: false });

  useEffect(() => {
    checkAuth();
  }, []);

  const checkAuth = async () => {
    try {
      const res = await fetch('/api/auth/status');
      const data = await res.json();
      setAuthStatus({ loading: false, ...data });
    } catch (err) {
      setAuthStatus({ loading: false, authenticated: false, enabled: false });
    }
  };

  const login = async (username, password) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (data.success) {
      await checkAuth();
      return { success: true };
    }
    return { success: false, error: data.error };
  };

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    await checkAuth();
  };

  const setupAuth = async (username, password, disable = false) => {
    const res = await fetch('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, disable })
    });
    const data = await res.json();
    if (data.success) {
      await checkAuth();
    }
    return data;
  };

  return { ...authStatus, login, logout, setupAuth, checkAuth };
}

const convertAnsiToHtml = (text) => {
  if (!text) return '';

  // 清理非颜色的 ANSI 控制序列（光标移动、清屏等）
  let cleaned = text
    // 移除光标控制序列
    .replace(/\x1b\[\??\d*[hlABCDEFGHJKSTfnsu]/g, '')
    // 移除光标位置设置
    .replace(/\x1b\[\d*;\d*[Hf]/g, '')
    // 移除清屏/清行
    .replace(/\x1b\[[012]?[JK]/g, '')
    // 移除滚动区域设置
    .replace(/\x1b\[\d*;\d*r/g, '')
    // 移除设备状态查询
    .replace(/\x1b\[\?[\d;]*[cnm]/g, '')
    // 移除 OSC 序列（标题设置等）
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // 移除其他 CSI 序列（保留颜色 m 序列）
    .replace(/\x1b\[[\d;]*[^m\d;]/g, '')
    // 移除回车符（保留换行）
    .replace(/\r(?!\n)/g, '')
    // 合并多个连续换行
    .replace(/\n{3,}/g, '\n\n');

  return Anser.ansiToHtml(Anser.escapeForHtml(cleaned), {
    use_classes: false
  });
};

export default function App() {
  const auth = useAuth();
  const [sessions, setSessions] = useState([]);
  const [currentSession, setCurrentSession] = useState(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [suggestion, setSuggestion] = useState(null);
  const [history, setHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [editingGoal, setEditingGoal] = useState(false);
  const [goalInput, setGoalInput] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [aiPanelCollapsed, setAiPanelCollapsed] = useState(false);
  const [aiSettings, setAiSettings] = useState({
    model: 'sonnet',
    apiUrl: 'https://agent-ai.webtrn.cn/v1/chat/completions',
    maxTokens: 500,
    temperature: 0.7
  });
  const [tunnelUrl, setTunnelUrl] = useState('');
  const [showQRCode, setShowQRCode] = useState(false);
  const [aiStatusMap, setAiStatusMap] = useState({});
  const [aiStatusLoading, setAiStatusLoading] = useState({});
  const [aiDebugLogs, setAiDebugLogs] = useState([]);
  const [showDebugPanel, setShowDebugPanel] = useState(false);
  const [pendingScreenContent, setPendingScreenContent] = useState(null);
  const [pendingCursorPosition, setPendingCursorPosition] = useState(null);
  const [aiStatusCountdown, setAiStatusCountdown] = useState(30);
  const [nextAnalysisTime, setNextAnalysisTime] = useState(Date.now() + 30000);
  const [aiHealthStatus, setAiHealthStatus] = useState({
    status: 'healthy',
    networkStatus: 'online',
    consecutiveErrors: 0,
    consecutiveNetworkErrors: 0,
    lastError: null,
    lastSuccessTime: Date.now(),
    nextRecoveryCheck: 0
  });
  // 供应商切换相关状态
  const [showProviderDropdown, setShowProviderDropdown] = useState(false);
  const [availableProviders, setAvailableProviders] = useState([]);
  const [switchingProvider, setSwitchingProvider] = useState(false);
  const [switchProgress, setSwitchProgress] = useState(0);
  const [switchMessage, setSwitchMessage] = useState('');
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0 });
  const providerButtonRef = useRef(null);
  // 注意：autoActionEnabled 现在存储在服务器端，通过 session.autoActionEnabled 获取

  const terminalRef = useRef(null);
  const terminalInstance = useRef(null);
  const fitAddon = useRef(null);
  const currentSessionRef = useRef(null);

  // 保持 currentSession 的 ref 同步
  useEffect(() => {
    currentSessionRef.current = currentSession;
  }, [currentSession]);

  // 设置暗色主题
  useEffect(() => {
    document.documentElement.classList.add('dark');
    return () => {
      document.documentElement.classList.remove('dark');
    };
  }, []);

  // 初始化 Socket 监听
  useEffect(() => {
    socket.on('sessions:list', setSessions);
    socket.on('sessions:updated', setSessions);

    socket.on('session:attached', (data) => {
      // 使用完整内容（包含滚动历史），如果没有则使用当前屏幕内容
      setPendingScreenContent(data.fullContent || data.screenContent || '');
      setPendingCursorPosition(data.cursorPosition);
      setCurrentSession(data.session);
    });

    // 历史记录异步加载，不阻塞终端显示
    socket.on('session:history', (data) => {
      if (data.sessionId === currentSessionRef.current?.id) {
        setHistory(data.history);
      }
    });

    socket.on('session:updated', (sessionUpdate) => {
      // 更新 currentSession
      setCurrentSession(prev => prev?.id === sessionUpdate.id ? { ...prev, ...sessionUpdate } : prev);
      // 更新 sessions 列表中的对应会话
      setSessions(prev => prev.map(s => s.id === sessionUpdate.id ? { ...s, ...sessionUpdate } : s));
    });

    socket.on('terminal:output', (data) => {
      if (terminalInstance.current && data.sessionId === currentSessionRef.current?.id) {
        terminalInstance.current.write(data.data);
      }
    });

    socket.on('ai:suggestion', (data) => {
      if (data.sessionId === currentSessionRef.current?.id) {
        setSuggestion(data);
      }
    });

    socket.on('ai:autoExecuted', (data) => {
      if (data.sessionId === currentSessionRef.current?.id) {
        setSuggestion(data);
      }
    });

    socket.on('ai:executed', () => {
      setSuggestion(null);
    });

    socket.on('ai:complete', (data) => {
      if (data.sessionId === currentSessionRef.current?.id) {
        setSuggestion({ type: 'complete', summary: data.summary });
      }
    });

    socket.on('ai:needInput', (data) => {
      if (data.sessionId === currentSessionRef.current?.id) {
        setSuggestion({ type: 'needInput', question: data.question });
      }
    });

    socket.emit('sessions:list');

    return () => {
      socket.off('sessions:list');
      socket.off('sessions:updated');
      socket.off('session:attached');
      socket.off('session:history');
      socket.off('session:updated');
      socket.off('terminal:output');
      socket.off('ai:suggestion');
      socket.off('ai:autoExecuted');
      socket.off('ai:executed');
      socket.off('ai:complete');
      socket.off('ai:needInput');
      socket.off('settings:loaded');
      socket.off('tunnel:connected');
      socket.off('tunnel:disconnected');
    };
  }, []);

  // 加载 AI 设置
  useEffect(() => {
    socket.on('settings:loaded', (settings) => {
      setAiSettings(prev => ({ ...prev, ...settings }));
      if (settings.tunnelUrl) {
        setTunnelUrl(settings.tunnelUrl);
        setShowQRCode(true);  // 自动显示二维码
      }
    });
    socket.emit('settings:load');

    // 加载 tunnel URL
    fetch('/api/tunnel/url')
      .then(res => res.json())
      .then(data => {
        if (data.tunnelUrl) {
          setTunnelUrl(data.tunnelUrl);
          setShowQRCode(true);  // 自动显示二维码
        }
      })
      .catch(err => console.error('加载 tunnel URL 失败:', err));

    // 监听 Cloudflare Tunnel 连接事件（自动获取免费域名）
    socket.on('tunnel:connected', (data) => {
      console.log('[Tunnel] 已连接:', data.url);
      setTunnelUrl(data.url);
      setShowQRCode(true);
    });

    socket.on('tunnel:disconnected', () => {
      console.log('[Tunnel] 已断开');
      setTunnelUrl('');
      setShowQRCode(false);
    });

    // 加载历史 AI 操作日志
    fetch('/api/ai-logs?limit=500')
      .then(res => res.json())
      .then(logs => {
        const formattedLogs = logs.map(log => ({
          id: log.id,
          time: new Date(log.createdAt).toLocaleTimeString(),
          type: 'autoAction',
          data: {
            sessionId: log.sessionId,
            action: log.content.replace('[自动操作] ', ''),
            reason: log.aiReasoning
          }
        }));
        setAiDebugLogs(formattedLogs);
      })
      .catch(err => console.error('加载 AI 日志失败:', err));

    return () => {
      socket.off('settings:loaded');
    };
  }, []);

  // 添加调试日志的辅助函数（保留所有日志）
  const addDebugLog = useCallback((type, data) => {
    setAiDebugLogs(prev => [...prev, {
      id: Date.now(),
      time: new Date().toLocaleTimeString(),
      type,
      data
    }]);
  }, []);

  // 切换后台自动操作开关
  const toggleAutoAction = useCallback((sessionId, enabled) => {
    socket.emit('ai:toggleAutoAction', { sessionId, enabled });
    addDebugLog('toggleAutoAction', { sessionId, enabled, message: enabled ? '开启后台自动操作' : '关闭后台自动操作' });
  }, [addDebugLog]);

  // 打开供应商下拉菜单
  const openProviderDropdown = useCallback(async () => {
    console.log('[Provider] 点击下拉箭头, currentSession:', currentSession);
    if (!currentSession) {
      console.log('[Provider] currentSession 为空，返回');
      return;
    }

    // 计算按钮位置（用于固定定位下拉菜单）
    if (providerButtonRef.current) {
      const rect = providerButtonRef.current.getBoundingClientRect();
      setDropdownPosition({
        top: rect.bottom + 4,
        left: rect.left
      });
    }

    // 根据当前 session 的 aiType 获取对应类型的供应商列表
    const appType = currentSession.aiType || 'claude';
    console.log('[Provider] 获取供应商列表, appType:', appType);

    try {
      const res = await fetch(`/api/cc-switch/providers?app=${appType}`);
      const data = await res.json();
      const providers = data.data?.providers || data.providers || [];
      console.log('[Provider] 获取到供应商列表:', providers);

      // 获取当前会话正在使用的供应商（不是全局激活的）
      const sessionProvider = appType === 'claude' ? currentSession.claudeProvider :
                              appType === 'codex' ? currentSession.codexProvider :
                              appType === 'gemini' ? currentSession.geminiProvider : null;
      const sessionProviderId = sessionProvider?.id || null;
      console.log('[Provider] 当前会话供应商ID:', sessionProviderId);

      // 标记当前会话正在使用的供应商
      const providersWithCurrent = providers.map(p => ({
        id: p.id,
        name: p.name,
        isCurrent: p.id === sessionProviderId
      }));

      setAvailableProviders(providersWithCurrent);
      setShowProviderDropdown(true);
    } catch (err) {
      console.error('[Provider] 获取供应商列表失败:', err);
    }
  }, [currentSession]);

  // 点击外部关闭下拉菜单
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (showProviderDropdown && !e.target.closest('.ai-status-section')) {
        setShowProviderDropdown(false);
      }
    };

    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [showProviderDropdown]);

  // 切换供应商
  const switchProvider = useCallback((providerId) => {
    console.log('[Provider] switchProvider 被调用, providerId:', providerId);
    if (!currentSession) {
      console.log('[Provider] currentSession 为空，返回');
      return;
    }

    console.log('[Provider] 开始切换, sessionId:', currentSession.id);
    setSwitchingProvider(true);
    setSwitchProgress(0);
    setSwitchMessage('准备切换...');

    const appType = currentSession.aiType || 'claude';
    console.log('[Provider] 发送 socket 事件, appType:', appType, 'providerId:', providerId);
    socket.emit('provider:switch', {
      sessionId: currentSession.id,
      appType,
      providerId
    });
  }, [currentSession]);

  // 监听 AI 状态更新
  useEffect(() => {
    socket.on('ai:status', (data) => {
      setAiStatusMap(prev => ({ ...prev, [data.sessionId]: data }));
      setAiStatusLoading(prev => ({ ...prev, [data.sessionId]: false }));
      addDebugLog('response', data);
    });

    socket.on('ai:statusLoading', (data) => {
      setAiStatusLoading(prev => ({ ...prev, [data.sessionId]: true }));
      addDebugLog('request', { sessionId: data.sessionId, message: '开始请求 AI 状态分析...' });
    });

    socket.on('ai:error', (data) => {
      addDebugLog('error', data);
    });

    // 监听 AI 健康状态变化
    socket.on('ai:healthStatus', (data) => {
      setAiHealthStatus(data);
      if (data.status === 'failed') {
        addDebugLog('healthError', {
          message: `AI 服务故障: ${data.lastError}`,
          nextRetry: new Date(data.nextRecoveryCheck).toLocaleTimeString()
        });
      } else if (data.status === 'healthy' && data.consecutiveErrors === 0) {
        addDebugLog('healthRecovered', { message: 'AI 服务已恢复正常' });
      }
    });

    // 监听下次 AI 分析时间
    socket.on('ai:nextAnalysisTime', (data) => {
      setNextAnalysisTime(data.nextTime);
    });

    // 监听后台自动操作执行事件
    socket.on('ai:autoActionExecuted', (data) => {
      addDebugLog('autoAction', {
        sessionId: data.sessionId,
        action: data.action,
        reason: data.reason,
        message: `后台自动执行: ${data.action}`
      });
    });

    // 监听 Claude Code 会话修复事件
    socket.on('claude:sessionFixed', (data) => {
      if (data.success) {
        toast.success('Claude Code 会话已修复，请重启');
      } else {
        toast.error('会话修复失败: ' + data.message);
      }
    });

    // 监听供应商切换状态
    socket.on('provider:switchStatus', (data) => {
      setSwitchMessage(data.message);
      setSwitchProgress(data.progress);
    });

    // 监听供应商切换完成
    socket.on('provider:switchComplete', (data) => {
      setSwitchingProvider(false);
      setSwitchProgress(100);
      setSwitchMessage('切换完成！');
      setShowProviderDropdown(false);
      setTimeout(() => {
        setSwitchMessage('');
        setSwitchProgress(0);
      }, 2000);
      addDebugLog('providerSwitch', { message: `切换到 ${data.providerName} 完成` });
    });

    // 监听供应商切换错误
    socket.on('provider:switchError', (data) => {
      setSwitchingProvider(false);
      setSwitchProgress(0);
      toast.error('切换服务器失败: ' + data.error);
      addDebugLog('error', { message: `切换服务器失败: ${data.error}` });
    });

    return () => {
      socket.off('ai:status');
      socket.off('ai:statusLoading');
      socket.off('ai:error');
      socket.off('ai:autoActionExecuted');
      socket.off('claude:sessionFixed');
      socket.off('ai:healthStatus');
      socket.off('ai:nextAnalysisTime');
      socket.off('provider:switchStatus');
      socket.off('provider:switchComplete');
      socket.off('provider:switchError');
    };
  }, [addDebugLog]);

  // 根据服务器的下次分析时间计算倒计时
  useEffect(() => {
    // 只在当前会话的自动操作开启时才更新倒计时
    if (!currentSession?.autoActionEnabled) {
      setAiStatusCountdown(0);
      return;
    }

    // 每秒更新倒计时
    const countdownInterval = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((nextAnalysisTime - Date.now()) / 1000));
      setAiStatusCountdown(remaining);
    }, 1000);

    return () => clearInterval(countdownInterval);
  }, [nextAnalysisTime, currentSession?.autoActionEnabled]);

  // 初始化终端（只初始化一次）
  useEffect(() => {
    if (!terminalRef.current) return;

    // 如果已有终端实例，先清理
    if (terminalInstance.current) {
      terminalInstance.current.dispose();
      terminalInstance.current = null;
    }

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Monaco, Menlo, monospace',
      scrollback: 5000,
      theme: {
        background: '#000000',
        foreground: '#eaeaea',
        cursor: '#e94560'
      }
    });

    fitAddon.current = new FitAddon();
    term.loadAddon(fitAddon.current);
    term.open(terminalRef.current);

    // 延迟调用 fit，确保 DOM 已完全渲染
    requestAnimationFrame(() => {
      if (fitAddon.current) {
        fitAddon.current.fit();
      }
    });

    // 注册输入监听器（dispose 时会自动清理）
    term.onData((data) => {
      const session = currentSessionRef.current;
      if (session) {
        // 防止重复发送（React StrictMode / HMR 可能导致重复注册监听器）
        const now = Date.now();
        if (data === lastInputData && now - lastInputTime < INPUT_DEBOUNCE_MS) {
          return; // 跳过重复输入
        }
        lastInputTime = now;
        lastInputData = data;

        socket.emit('terminal:input', {
          sessionId: session.id,
          input: data
        });
      }
    });

    terminalInstance.current = term;

    const handleResize = () => {
      if (fitAddon.current && terminalInstance.current) {
        fitAddon.current.fit();
        const session = currentSessionRef.current;
        if (session && terminalInstance.current) {
          socket.emit('terminal:resize', {
            sessionId: session.id,
            cols: terminalInstance.current.cols,
            rows: terminalInstance.current.rows
          });
        }
      }
    };

    window.addEventListener('resize', handleResize);

    // 使用 ResizeObserver 监听容器大小变化
    const resizeObserver = new ResizeObserver(() => {
      handleResize();
    });
    resizeObserver.observe(terminalRef.current);

    return () => {
      window.removeEventListener('resize', handleResize);
      resizeObserver.disconnect();
      // 清理终端实例（会自动清理 onData 监听器）
      if (terminalInstance.current) {
        terminalInstance.current.dispose();
        terminalInstance.current = null;
      }
    };
  }, [currentSession?.id]); // 需要依赖 currentSession，因为终端容器是条件渲染的

  // 处理缓存的屏幕内容
  useEffect(() => {
    if (pendingScreenContent !== null && terminalInstance.current) {
      const term = terminalInstance.current;
      // 重置终端
      term.reset();

      // 先调用 fit 确保尺寸正确
      if (fitAddon.current) {
        fitAddon.current.fit();
        // 同步尺寸到服务器
        const session = currentSessionRef.current;
        if (session) {
          socket.emit('terminal:resize', {
            sessionId: session.id,
            cols: term.cols,
            rows: term.rows
          });
        }
      }

      // 写入当前可见区域内容
      const content = pendingScreenContent.replace(/\r\n$/, '');
      term.write(content);

      // 设置光标位置
      if (pendingCursorPosition) {
        term.write(`\x1b[${pendingCursorPosition.y};${pendingCursorPosition.x}H`);
      }

      setPendingScreenContent(null);
      setPendingCursorPosition(null);
    }
  }, [pendingScreenContent, pendingCursorPosition]);

  // 附加到会话
  const attachSession = useCallback((sessionId) => {
    // 不在这里清空终端，由 pendingScreenContent 处理时统一清空和写入
    setSuggestion(null);
    socket.emit('session:attach', sessionId);
  }, []);

  // 创建会话
  const createSession = (data) => {
    socket.emit('session:create', data);
    setShowCreateModal(false);
  };

  // 执行 AI 建议
  const executeSuggestion = () => {
    if (suggestion && currentSession) {
      socket.emit('ai:execute', {
        sessionId: currentSession.id,
        command: suggestion.command,
        reasoning: suggestion.reasoning
      });
    }
  };

  // 开始编辑目标
  const startEditGoal = () => {
    setGoalInput(currentSession?.goal || '');
    setEditingGoal(true);
  };

  // 保存目标
  const saveGoal = () => {
    if (currentSession) {
      socket.emit('session:update', {
        sessionId: currentSession.id,
        goal: goalInput
      });
      setSuggestion(null);
    }
    setEditingGoal(false);
  };

  // 保存 AI 设置
  const saveSettings = () => {
    socket.emit('settings:save', aiSettings);
    setShowSettings(false);
  };

  // 保存 Tunnel URL
  const saveTunnelUrl = async (url) => {
    try {
      await fetch('/api/tunnel/url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tunnelUrl: url })
      });
      setTunnelUrl(url);
      if (url) {
        setShowQRCode(true);  // 有URL时自动显示二维码
      }
    } catch (err) {
      console.error('保存 tunnel URL 失败:', err);
    }
  };

  // 如果需要认证但未登录，显示登录页面
  // 注意：本机访问时 authenticated 会自动为 true
  if (auth.loading) {
    return <div className="loading-screen">加载中...</div>;
  }

  if (auth.enabled && !auth.authenticated) {
    return <LoginPage auth={auth} />;
  }

  return (
    <ToastContainer>
    <div className="app">
      {/* 侧边栏 */}
      <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <button
          className="panel-toggle sidebar-toggle"
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          title={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
        >
          {sidebarCollapsed ? '›' : '‹'}
        </button>
        <div className="sidebar-header">
          <h1>网梯终端 <span style={{ fontSize: '14px', opacity: 0.7, fontWeight: 'normal' }}>WhatyTerm</span></h1>
          <button className="btn btn-primary btn-small" onClick={() => setShowCreateModal(true)}>
            + 新建
          </button>
        </div>

        <div className="session-list">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`session-item ${currentSession?.id === session.id ? 'active' : ''}`}
              onClick={() => attachSession(session.id)}
            >
              <div className="session-header">
                <div className="session-name">
                  <span className={`session-status ${session.autoActionEnabled ? 'auto' : 'paused'}`} />
                  {session.projectName || session.name}
                </div>
                <button
                  className="btn-delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    {
                      socket.emit('session:delete', session.id);
                      if (currentSession?.id === session.id) {
                        setCurrentSession(null);
                      }
                    }
                  }}
                  title="删除会话"
                >
                  ×
                </button>
              </div>
              {session.projectDesc && (
                <div className="session-goal">{session.projectDesc.slice(0, 50)}{session.projectDesc.length > 50 ? '...' : ''}</div>
              )}
              {!session.projectDesc && session.goal && (
                <div className="session-goal">目标: {session.goal.split('\n')[0].slice(0, 40)}{session.goal.length > 40 ? '...' : ''}</div>
              )}
              {/* 会话悬停提示 */}
              {(session.projectDesc || session.goal) && (
                <div className="session-tooltip">{session.projectDesc || session.goal}</div>
              )}
              <div className="session-ai-status">
                {session.autoActionEnabled ? '🤖 自动' : '💡 建议'}
              </div>
            </div>
          ))}

          {sessions.length === 0 && (
            <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-secondary)' }}>
              暂无会话
            </div>
          )}
        </div>

        <div className="sidebar-footer">
          {/* 二维码 */}
          {tunnelUrl && (
            <div style={{
              padding: '12px',
              backgroundColor: 'var(--bg-tertiary)',
              borderRadius: '8px',
              marginBottom: '12px',
              textAlign: 'center'
            }}>
              <QRCodeDisplay url={tunnelUrl} />
            </div>
          )}
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="btn btn-secondary settings-btn" onClick={() => setShowSettings(true)}>
              ⚙️ 设置
            </button>
          </div>
        </div>
      </aside>

      {/* 主内容区 */}
      <main className="main-content">
        {currentSession ? (
          <div className="terminal-container">
            <div className="terminal-wrapper" ref={terminalRef} />

            {/* AI 建议卡片 - 仅在非自动模式下显示 */}
            {suggestion && !currentSession.autoActionEnabled && (
              <div className="ai-suggestion">
                <div className="ai-suggestion-header">
                  <span className="ai-suggestion-title">
                    {suggestion.type === 'complete' ? (
                      <><span>✅</span> 目标已完成</>
                    ) : suggestion.type === 'needInput' ? (
                      <><span>❓</span> 需要输入</>
                    ) : (
                      <><span>💡</span> AI 建议</>
                    )}
                  </span>
                </div>

                {suggestion.type === 'complete' ? (
                  <>
                    <div className="ai-reasoning">{suggestion.summary}</div>
                    <div className="ai-actions">
                      <button className="btn btn-secondary" onClick={() => setSuggestion(null)}>
                        关闭
                      </button>
                    </div>
                  </>
                ) : suggestion.type === 'needInput' ? (
                  <>
                    <div className="ai-reasoning">{suggestion.question}</div>
                    <div className="ai-actions">
                      <button className="btn btn-secondary" onClick={() => setSuggestion(null)}>
                        关闭
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    {suggestion.isDangerous && (
                      <div className="danger-warning">
                        ⚠️ 此命令可能有风险，请确认后再执行
                      </div>
                    )}

                    <div className="ai-command">$ {suggestion.command}</div>
                    <div className="ai-reasoning">{suggestion.reasoning}</div>

                    <div className="ai-actions">
                      <button className="btn btn-primary" onClick={executeSuggestion}>
                        执行 ▶
                      </button>
                      <button className="btn btn-secondary" onClick={() => setSuggestion(null)}>
                        忽略
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* 自动模式运行状态提示 */}
            {currentSession.autoActionEnabled && (
              <div className="ai-suggestion auto-mode-active">
                <div className="ai-suggestion-header">
                  <span className="ai-suggestion-title">
                    <span>🤖</span> 自动模式运行中
                  </span>
                  <button
                    className="btn btn-secondary btn-small"
                    onClick={() => toggleAutoAction(currentSession.id, false)}
                  >
                    暂停 ⏸
                  </button>
                </div>
                <div className="ai-reasoning">
                  AI 正在后台监控终端状态，检测到需要操作时会自动执行。
                </div>
              </div>
            )}

            {/* 设置面板 */}
            <div className="settings-panel">
              <div className="settings-row">
                {editingGoal ? (
                  <div className="goal-edit">
                    <textarea
                      value={goalInput}
                      onChange={(e) => setGoalInput(e.target.value)}
                      placeholder="输入目标，例如：&#10;1. 列出当前目录文件&#10;2. 查找包含特定内容的文件&#10;3. 执行部署脚本"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') setEditingGoal(false);
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveGoal();
                      }}
                    />
                    <div className="goal-edit-actions">
                      <span className="goal-edit-hint">Ctrl/Cmd+Enter 保存</span>
                      <button className="btn btn-primary btn-small" onClick={saveGoal}>
                        保存
                      </button>
                      <button className="btn btn-secondary btn-small" onClick={() => setEditingGoal(false)}>
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <span className="settings-label goal-display" onClick={startEditGoal}>
                      目标: {currentSession.goal || '点击设置目标'}
                    </span>
                    <div className="settings-actions">
                      <button className="btn btn-secondary btn-small" onClick={startEditGoal}>
                        修改
                      </button>
                      <button className="btn btn-secondary btn-small" onClick={() => setShowHistory(true)}>
                        历史
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="empty-state welcome-page">
            <h2>欢迎使用网梯终端</h2>
            <p className="welcome-subtitle">AI 驱动的智能终端管理工具</p>

            <div className="welcome-features">
              <div className="feature-section">
                <h3>核心功能</h3>
                <ul>
                  <li><strong>AI 智能监控</strong> - 自动分析终端状态，识别等待输入、错误提示等场景</li>
                  <li><strong>自动化操作</strong> - 根据 AI 分析结果自动执行确认、继续等操作</li>
                  <li><strong>多会话管理</strong> - 同时管理多个终端会话，支持 Claude/Codex/Gemini</li>
                  <li><strong>远程访问</strong> - 通过 FRP 隧道安全访问，支持手机扫码连接</li>
                </ul>
              </div>

              <div className="feature-section">
                <h3>使用技巧</h3>
                <ul>
                  <li><strong>创建会话</strong> - 点击左侧「+」按钮，选择 AI 类型并设置项目目标</li>
                  <li><strong>AI 开关</strong> - 每个会话可独立开启/关闭 AI 监控</li>
                  <li><strong>自动模式</strong> - 开启后 AI 会自动执行建议的操作</li>
                  <li><strong>手动确认</strong> - 关闭自动模式时，操作需要手动确认</li>
                </ul>
              </div>

              <div className="feature-section">
                <h3>快捷操作</h3>
                <ul>
                  <li><strong>设置</strong> - 点击右上角齿轮图标配置 AI 和 API</li>
                  <li><strong>终端输入</strong> - 直接在终端区域输入命令</li>
                  <li><strong>会话切换</strong> - 点击左侧会话列表快速切换</li>
                  <li><strong>状态面板</strong> - 右侧面板显示 AI 分析结果和操作历史</li>
                </ul>
              </div>
            </div>

            <p className="welcome-hint">选择一个会话或点击「+」创建新会话开始</p>
          </div>
        )}
      </main>

      {/* 右侧 AI 状态面板 */}
      {currentSession && (
        <aside className={`ai-panel ${aiPanelCollapsed ? 'collapsed' : ''}`}>
          <button
            className="panel-toggle ai-panel-toggle"
            onClick={() => setAiPanelCollapsed(!aiPanelCollapsed)}
            title={aiPanelCollapsed ? '展开 AI 面板' : '收起 AI 面板'}
          >
            {aiPanelCollapsed ? '‹' : '›'}
          </button>
          <div className="ai-panel-header">
            <h3>AI 状态监控</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {/* 健康状态指示器 */}
              <span
                className={`ai-health-dot ${aiHealthStatus.status} ${aiHealthStatus.networkStatus === 'offline' ? 'offline' : ''}`}
                title={
                  aiHealthStatus.networkStatus === 'offline'
                    ? `网络离线\n连续网络错误 ${aiHealthStatus.consecutiveNetworkErrors} 次\n下次检查: ${new Date(aiHealthStatus.nextRecoveryCheck).toLocaleTimeString()}`
                    : aiHealthStatus.status === 'failed'
                    ? `服务故障: ${aiHealthStatus.lastError}\n下次重试: ${new Date(aiHealthStatus.nextRecoveryCheck).toLocaleTimeString()}`
                    : aiHealthStatus.status === 'degraded'
                    ? `服务降级: 连续错误 ${aiHealthStatus.consecutiveErrors} 次`
                    : '服务正常'
                }
              />
              <span className={`ai-status-indicator ${aiStatusLoading[currentSession.id] ? 'loading' : ''}`}>
                {!currentSession.aiEnabled ? '已关闭' : (aiStatusLoading[currentSession.id] ? '分析中...' : `${aiStatusCountdown}s`)}
              </span>
              {/* 操作统计 */}
              <span className="ai-stats-wrapper">
                <span className="ai-stats">
                  {(currentSession?.stats?.total || 0)}次 ✓{(currentSession?.stats?.success || 0)} ✗{(currentSession?.stats?.failed || 0)}
                </span>
                <div className="ai-stats-tooltip">
                  <div className="tooltip-title">AI 操作统计（本会话）</div>
                  <div className="tooltip-item">
                    <span className="tooltip-label">总操作次数:</span>
                    <span className="tooltip-value">{currentSession?.stats?.total || 0}</span>
                  </div>
                  <div className="tooltip-item">
                    <span className="tooltip-label">成功:</span>
                    <span className="tooltip-value success">
                      {currentSession?.stats?.success || 0} ({(currentSession?.stats?.total || 0) > 0 ? Math.round((currentSession?.stats?.success || 0) / currentSession.stats.total * 100) : 0}%)
                    </span>
                  </div>
                  <div className="tooltip-item">
                    <span className="tooltip-label">失败:</span>
                    <span className="tooltip-value failed">
                      {currentSession?.stats?.failed || 0} ({(currentSession?.stats?.total || 0) > 0 ? Math.round((currentSession?.stats?.failed || 0) / currentSession.stats.total * 100) : 0}%)
                    </span>
                  </div>
                  <div className="tooltip-divider"></div>
                  <div className="tooltip-item">
                    <span className="tooltip-label">AI 判断:</span>
                    <span className="tooltip-value">
                      {currentSession?.stats?.aiAnalyzed || 0} ({(currentSession?.stats?.total || 0) > 0 ? Math.round((currentSession?.stats?.aiAnalyzed || 0) / currentSession.stats.total * 100) : 0}%)
                    </span>
                  </div>
                  <div className="tooltip-item">
                    <span className="tooltip-label">程序判断:</span>
                    <span className="tooltip-value">
                      {currentSession?.stats?.preAnalyzed || 0} ({(currentSession?.stats?.total || 0) > 0 ? Math.round((currentSession?.stats?.preAnalyzed || 0) / currentSession.stats.total * 100) : 0}%)
                    </span>
                  </div>
                  <div className="tooltip-divider"></div>
                  <div className="tooltip-item">
                    <span className="tooltip-label">会话时长:</span>
                    <span className="tooltip-value">
                      {currentSession?.createdAt ? (() => {
                        const minutes = Math.floor((Date.now() - new Date(currentSession.createdAt).getTime()) / 60000);
                        if (minutes < 60) return `${minutes}分钟`;
                        const hours = Math.floor(minutes / 60);
                        const remainMinutes = minutes % 60;
                        if (hours < 24) return `${hours}小时${remainMinutes}分钟`;
                        const days = Math.floor(hours / 24);
                        const remainHours = hours % 24;
                        return `${days}天${remainHours}小时`;
                      })() : '未知'}
                    </span>
                  </div>
                </div>
              </span>
            </div>
          </div>
          <div className="ai-panel-content">
            {/* 当前 AI 供应商信息 */}
            <div className="ai-status-section" style={{ position: 'relative' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                <h4 style={{ margin: 0 }}>
                  {currentSession.aiType === 'claude' ? 'Claude API' :
                   currentSession.aiType === 'codex' ? 'Codex API' :
                   currentSession.aiType === 'gemini' ? 'Gemini API' : 'AI API'}
                </h4>
                <button
                  ref={providerButtonRef}
                  onClick={openProviderDropdown}
                  disabled={switchingProvider}
                  style={{
                    background: 'transparent',
                    border: '1px solid #444',
                    borderRadius: '4px',
                    color: '#aaa',
                    cursor: switchingProvider ? 'not-allowed' : 'pointer',
                    padding: '2px 6px',
                    fontSize: '10px'
                  }}
                  title="切换 API 供应商"
                >
                  ▼
                </button>
              </div>

              {(() => {
                const provider = currentSession.aiType === 'claude' ? currentSession.claudeProvider :
                                currentSession.aiType === 'codex' ? currentSession.codexProvider :
                                currentSession.aiType === 'gemini' ? currentSession.geminiProvider : null;

                const color = currentSession.aiType === 'claude' ? 'hsl(var(--primary))' :
                             currentSession.aiType === 'codex' ? 'hsl(142 70% 45%)' :
                             currentSession.aiType === 'gemini' ? 'hsl(45 93% 47%)' : 'hsl(var(--muted-foreground))';

                const isLocalConfig = provider?.configSource === 'local';
                const globalConfig = provider?.globalConfig;

                return (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <p style={{ fontWeight: 500, color: provider?.exists ? color : 'hsl(var(--muted-foreground))', margin: 0 }}>
                        {provider?.name || '未配置'}
                      </p>
                      {provider?.configSource && (
                        <span style={{
                          fontSize: '9px',
                          padding: '1px 4px',
                          borderRadius: '3px',
                          background: isLocalConfig ? 'hsl(142 70% 45% / 0.2)' : 'hsl(220 14% 40% / 0.3)',
                          color: isLocalConfig ? 'hsl(142 70% 55%)' : 'hsl(220 14% 70%)'
                        }}>
                          {isLocalConfig ? '本地' : '全局'}
                        </span>
                      )}
                      {/* 本地配置时显示红色删除按钮 */}
                      {isLocalConfig && currentSession?.workingDir && (
                        <button
                          onClick={async (e) => {
                            e.stopPropagation();
                            try {
                              const res = await fetch('/api/claude-code/config/local', {
                                method: 'DELETE',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ projectPath: currentSession.workingDir })
                              });
                              const data = await res.json();
                              if (!data.success) {
                                console.error('删除本地配置失败:', data.error || '未知错误');
                              }
                            } catch (err) {
                              console.error('删除本地配置请求失败:', err.message);
                            }
                          }}
                          style={{
                            width: '14px',
                            height: '14px',
                            padding: 0,
                            background: 'transparent',
                            border: 'none',
                            color: '#ef4444',
                            cursor: 'pointer',
                            fontSize: '12px',
                            lineHeight: '14px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center'
                          }}
                          title="删除本地配置，恢复使用全局配置"
                        >
                          ×
                        </button>
                      )}
                    </div>
                    {provider?.url && (
                      <p className="mono" style={{ fontSize: '11px', wordBreak: 'break-all', marginTop: '4px' }}>
                        {provider.url}
                      </p>
                    )}
                    {/* 当使用本地配置时，显示全局配置供参考和恢复按钮 */}
                    {isLocalConfig && globalConfig && (
                      <div style={{
                        marginTop: '8px',
                        padding: '6px 8px',
                        background: 'hsl(220 14% 15% / 0.5)',
                        borderRadius: '4px',
                        borderLeft: '2px solid hsl(220 14% 40%)'
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                          <p style={{ fontSize: '10px', color: 'hsl(220 14% 60%)', margin: 0 }}>
                            全局配置 (参考)
                          </p>
                          <button
                            onClick={async () => {
                              if (!currentSession?.workingDir) return;
                              try {
                                const res = await fetch('/api/claude-code/config/local', {
                                  method: 'DELETE',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ projectPath: currentSession.workingDir })
                                });
                                const data = await res.json();
                                if (!data.success) {
                                  console.error('恢复全局配置失败:', data.error || '未知错误');
                                }
                              } catch (err) {
                                console.error('恢复全局配置请求失败:', err.message);
                              }
                            }}
                            style={{
                              fontSize: '9px',
                              padding: '2px 6px',
                              background: 'hsl(220 14% 25%)',
                              border: '1px solid hsl(220 14% 35%)',
                              borderRadius: '3px',
                              color: 'hsl(220 14% 70%)',
                              cursor: 'pointer'
                            }}
                            title="删除本地 .claude/settings.local.json，恢复使用全局配置"
                          >
                            恢复全局
                          </button>
                        </div>
                        <p style={{ fontSize: '11px', color: 'hsl(220 14% 70%)', margin: 0 }}>
                          {globalConfig.name}
                        </p>
                        {globalConfig.url && (
                          <p className="mono" style={{ fontSize: '10px', color: 'hsl(220 14% 50%)', margin: '2px 0 0 0', wordBreak: 'break-all' }}>
                            {globalConfig.url}
                          </p>
                        )}
                      </div>
                    )}
                    {/* 当使用全局配置时，显示同步到本地的按钮 */}
                    {!isLocalConfig && provider?.exists && currentSession?.workingDir && (
                      <button
                        onClick={async () => {
                          if (!currentSession?.workingDir) return;
                          try {
                            const res = await fetch('/api/claude-code/config', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ projectPath: currentSession.workingDir })
                            });
                            const data = await res.json();
                            if (!data.success) {
                              console.error('同步配置失败:', data.error || '未知错误');
                            }
                          } catch (err) {
                            console.error('同步配置请求失败:', err.message);
                          }
                        }}
                        style={{
                          marginTop: '8px',
                          fontSize: '10px',
                          padding: '4px 8px',
                          background: 'hsl(142 70% 45% / 0.15)',
                          border: '1px solid hsl(142 70% 45% / 0.3)',
                          borderRadius: '4px',
                          color: 'hsl(142 70% 55%)',
                          cursor: 'pointer',
                          width: '100%'
                        }}
                        title="将全局 ~/.claude/settings.json 同步到项目 .claude/settings.local.json"
                      >
                        同步到项目本地配置
                      </button>
                    )}
                  </>
                );
              })()}

              {/* 供应商下拉菜单 */}
              {showProviderDropdown && !switchingProvider && (
                <div style={{
                  position: 'fixed',
                  top: dropdownPosition.top + 'px',
                  left: dropdownPosition.left + 'px',
                  background: '#1e1e2e',
                  border: '1px solid #444',
                  borderRadius: '6px',
                  minWidth: '250px',
                  maxHeight: '300px',
                  overflowY: 'auto',
                  zIndex: 10000,
                  boxShadow: '0 4px 12px rgba(0,0,0,0.5)'
                }}>
                  {availableProviders.length > 0 ? (
                    availableProviders.map(prov => (
                      <div
                        key={prov.id}
                        onClick={() => {
                          switchProvider(prov.id);
                          setShowProviderDropdown(false);
                        }}
                        style={{
                          padding: '8px 12px',
                          cursor: 'pointer',
                          borderBottom: '1px solid #333',
                          background: prov.isCurrent ? '#2a2a3e' : 'transparent',
                          color: prov.isCurrent ? '#10b981' : '#aaa'
                        }}
                        onMouseEnter={(e) => {
                          if (!prov.isCurrent) {
                            e.currentTarget.style.background = '#252535';
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (!prov.isCurrent) {
                            e.currentTarget.style.background = 'transparent';
                          }
                        }}
                      >
                        {prov.name} {prov.isCurrent && '✓'}
                      </div>
                    ))
                  ) : (
                    <div style={{ padding: '8px 12px', color: '#666' }}>
                      无可用服务器
                    </div>
                  )}
                </div>
              )}

              {/* 切换进度提示 */}
              {switchingProvider && (
                <div style={{
                  marginTop: '8px',
                  padding: '8px',
                  background: '#252535',
                  borderRadius: '4px'
                }}>
                  <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    marginBottom: '4px',
                    fontSize: '10px',
                    color: '#aaa'
                  }}>
                    <span>{switchMessage}</span>
                    <span>{switchProgress}%</span>
                  </div>
                  <div style={{
                    height: '4px',
                    background: '#333',
                    borderRadius: '2px',
                    overflow: 'hidden'
                  }}>
                    <div style={{
                      width: `${switchProgress}%`,
                      height: '100%',
                      background: '#10b981',
                      transition: 'width 0.3s ease'
                    }} />
                  </div>
                </div>
              )}
            </div>

            {aiStatusMap[currentSession.id] ? (
              <>
                <div className="ai-status-section">
                  <h4>当前状态</h4>
                  <p>{aiStatusMap[currentSession.id].currentState || '等待分析...'}</p>
                </div>
                <div className="ai-status-section">
                  <h4>工作目录</h4>
                  <p className="mono">{currentSession.workingDir || aiStatusMap[currentSession.id].workingDir || '未知'}</p>
                </div>
                <div className="ai-status-section">
                  <h4>最近操作</h4>
                  <p>{aiStatusMap[currentSession.id].recentAction || '无'}</p>
                </div>
                {/* 需要操作提示 */}
                {aiStatusMap[currentSession.id].needsAction && (
                  <div className="ai-status-section action-needed">
                    <h4>需要操作</h4>
                    <p className="action-type">类型: {aiStatusMap[currentSession.id].actionType}</p>
                    <p className="suggested-action">
                      建议操作: <code>{aiStatusMap[currentSession.id].suggestedAction}</code>
                    </p>
                    {aiStatusMap[currentSession.id].actionReason && (
                      <p className="action-reason">{aiStatusMap[currentSession.id].actionReason}</p>
                    )}
                    {/* 自动操作状态提示 */}
                    {currentSession.autoActionEnabled && (
                      <div className="auto-action-hint">
                        后台自动操作已开启，将自动执行
                      </div>
                    )}
                  </div>
                )}
                {aiStatusMap[currentSession.id].suggestion && (
                  <div className="ai-status-section suggestion">
                    <h4>建议</h4>
                    <p>{aiStatusMap[currentSession.id].suggestion}</p>
                  </div>
                )}
                {aiStatusMap[currentSession.id].updatedAt && (
                  <div className="ai-status-time">
                    更新于: {new Date(aiStatusMap[currentSession.id].updatedAt).toLocaleTimeString()}
                  </div>
                )}
              </>
            ) : (
              <div className="ai-status-empty">
                {aiStatusLoading[currentSession.id] ? '正在分析终端状态...' : '等待 AI 分析...'}
              </div>
            )}
            {/* 智能监控 API 供应商信息 - 始终在底部 */}
            {aiStatusMap[currentSession.id]?.providerName && (
              <div className="ai-provider-info" style={{
                padding: '8px',
                background: '#1a1a2e',
                borderRadius: '6px',
                fontSize: '11px',
                color: '#888'
              }}>
                <div style={{ marginBottom: '4px' }}>
                  <span style={{ color: '#aaa' }}>智能监控 API 供应商: </span>
                  <span style={{ color: '#10b981', fontWeight: 'bold' }}>
                    {aiStatusMap[currentSession.id].providerName}
                  </span>
                </div>
                <div style={{ wordBreak: 'break-all', marginBottom: '4px' }}>
                  <span style={{ color: '#aaa' }}>API URL: </span>
                  <span style={{ color: '#6b7280', fontFamily: 'monospace', fontSize: '10px' }}>
                    {aiStatusMap[currentSession.id].providerUrl}
                  </span>
                </div>
                <div>
                  <span style={{ color: '#aaa' }}>模型: </span>
                  <span style={{ color: '#f59e0b', fontFamily: 'monospace', fontSize: '10px' }}>
                    {aiStatusMap[currentSession.id].providerModel || defaultModel}
                  </span>
                </div>
              </div>
            )}
          </div>
          <div className="ai-panel-footer">
            <button
              className={`btn btn-small ${currentSession.autoActionEnabled ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => toggleAutoAction(currentSession.id, !currentSession.autoActionEnabled)}
            >
              {currentSession.autoActionEnabled ? '自动:开' : '自动:关'}
            </button>
            <button
              className="btn btn-secondary btn-small"
              onClick={() => socket.emit('ai:requestStatus', { sessionId: currentSession.id })}
              disabled={aiStatusLoading[currentSession.id]}
            >
              AI决策
            </button>
            <button
              className="btn btn-secondary btn-small"
              onClick={() => setShowDebugPanel(!showDebugPanel)}
            >
              {showDebugPanel ? '隐藏' : '日志'}
            </button>
            <button
              className="btn btn-primary btn-small"
              onClick={() => {
                // 关键：分两次发送，模拟人工输入
                socket.emit('terminal:input', { sessionId: currentSession.id, input: '继续' });
                setTimeout(() => {
                  socket.emit('terminal:input', { sessionId: currentSession.id, input: '\r' });
                }, 50);
                addDebugLog('test', { message: '测试: 分开发送 继续 + CR' });
              }}
            >
              继续
            </button>
          </div>

          {/* AI 调试日志面板 */}
          {showDebugPanel && (
            <div className="ai-debug-panel">
              <div className="ai-debug-header">
                <span>AI 自动操作记录</span>
                <button className="btn btn-small" onClick={() => setAiDebugLogs([])}>清空</button>
              </div>
              <div className="ai-debug-logs">
                {aiDebugLogs.filter(log => log.type === 'autoAction').length === 0 ? (
                  <div className="ai-debug-empty">暂无自动操作记录</div>
                ) : (
                  aiDebugLogs
                    .filter(log => log.type === 'autoAction')
                    .map(log => (
                      <div key={log.id} className="ai-debug-entry autoAction" style={{ marginBottom: '12px' }}>
                        <div style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          marginBottom: '6px'
                        }}>
                          <div style={{ color: '#10b981', fontWeight: 'bold', fontSize: '13px' }}>
                            ✓ {log.data.action}
                          </div>
                          <div style={{ fontSize: '11px', color: '#888' }}>
                            {log.time}
                          </div>
                        </div>
                        {log.data.reason && (
                          <div style={{
                            fontSize: '12px',
                            color: '#666',
                            lineHeight: '1.5',
                            paddingLeft: '16px',
                            borderLeft: '2px solid #10b981'
                          }}>
                            {log.data.reason}
                          </div>
                        )}
                      </div>
                    ))
                )}
              </div>
            </div>
          )}
        </aside>
      )}

      {/* 创建会话对话框 */}
      {showCreateModal && (
        <CreateSessionModal
          onClose={() => setShowCreateModal(false)}
          onCreate={createSession}
        />
      )}

      {/* 历史记录面板 */}
      {showHistory && currentSession && (
        <HistoryPanel
          sessionId={currentSession.id}
          history={history}
          onClose={() => setShowHistory(false)}
        />
      )}
      {/* AI 设置对话框 */}
      {showSettings && (
        <SettingsModal
          settings={aiSettings}
          onChange={setAiSettings}
          onSave={saveSettings}
          onClose={() => setShowSettings(false)}
          auth={auth}
          tunnelUrl={tunnelUrl}
          onTunnelUrlChange={saveTunnelUrl}
          socket={socket}
        />
      )}
    </div>
    </ToastContainer>
  );
}

// QR Code Display 组件（嵌入式）
function QRCodeDisplay({ url }) {
  const canvasRef = useRef(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (url && canvasRef.current) {
      import('qrcode').then(QRCode => {
        QRCode.default.toCanvas(canvasRef.current, url, {
          width: 100,
          margin: 2,
          color: {
            dark: '#000000',
            light: '#FFFFFF'
          }
        });
      });
    }
  }, [url]);

  const handleCopyUrl = () => {
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div style={{ display: 'inline-block' }}>
      <canvas ref={canvasRef} style={{ display: 'block', margin: '0 auto' }} />
      <div
        onClick={handleCopyUrl}
        style={{
          marginTop: '8px',
          fontSize: '11px',
          color: copied ? '#10b981' : '#0066cc',
          textAlign: 'center',
          cursor: 'pointer',
          wordBreak: 'break-all',
          lineHeight: '1.4',
          width: '100px',
          padding: '4px 0'
        }}
      >
        {copied ? '已复制!' : new URL(url).hostname}
      </div>
    </div>
  );
}

function SettingsModal({ settings, onChange, onSave, onClose, auth, tunnelUrl, onTunnelUrlChange, socket }) {
  const { t, language, setLanguage: changeLanguage } = useTranslation();
  const [activeTab, setActiveTab] = useState('ai');
  const [authUsername, setAuthUsername] = useState(auth.username || 'admin');
  const [authPassword, setAuthPassword] = useState('');
  const [authConfirm, setAuthConfirm] = useState('');
  const [authMessage, setAuthMessage] = useState('');
  const [localTunnelUrl, setLocalTunnelUrl] = useState(tunnelUrl || '');
  const [testStatus, setTestStatus] = useState({ openai: null, claude: null }); // null | 'testing' | 'success' | 'error'
  const [testMessage, setTestMessage] = useState({ openai: '', claude: '' });
  const [ccSwitchLoaded, setCcSwitchLoaded] = useState(false);
  const [providers, setProviders] = useState([]);
  const [defaultModel, setDefaultModel] = useState('claude-haiku-4-5-20251001');
  // 初始化时从 settings 中获取已选择的供应商 ID
  const [selectedProviderId, setSelectedProviderId] = useState(settings?._providerId || '');
  // 供应商测试状态
  const [providerTestStatus, setProviderTestStatus] = useState(null); // null | 'testing' | 'success' | 'error'
  const [providerTestMessage, setProviderTestMessage] = useState('');

  // 当 settings._providerId 变化时，同步更新下拉框选择（用于页面加载后恢复选择）
  useEffect(() => {
    console.log('[SettingsModal] settings._providerId 变化:', settings?._providerId, '当前 selectedProviderId:', selectedProviderId);
    if (settings?._providerId) {
      setSelectedProviderId(settings._providerId);
    }
  }, [settings?._providerId]);

  // 当 providers 加载完成后，确保 selectedProviderId 正确同步
  useEffect(() => {
    console.log('[SettingsModal] providers/settings 变化:', {
      providersCount: providers.length,
      settingsProviderId: settings?._providerId,
      selectedProviderId
    });
    // 只要 providers 加载完成且 settings 有 _providerId，就同步
    if (providers.length > 0 && settings?._providerId) {
      setSelectedProviderId(settings._providerId);
    }
  }, [providers.length, settings?._providerId]);

  // 加载 CC Switch 供应商列表（只在组件挂载时加载一次）
  useEffect(() => {
    // 请求所有三种类型的供应商
    Promise.all([
      fetch('/api/cc-switch/providers?app=claude').then(res => res.json()),
      fetch('/api/cc-switch/providers?app=codex').then(res => res.json()),
      fetch('/api/cc-switch/providers?app=gemini').then(res => res.json())
    ])
      .then(([claudeData, codexData, geminiData]) => {
        const claudeProviders = claudeData.data?.providers || claudeData.providers || [];
        const codexProviders = codexData.data?.providers || codexData.providers || [];
        const geminiProviders = geminiData.data?.providers || geminiData.providers || [];
        // 获取默认模型名称
        if (claudeData.data?.defaultModel) {
          setDefaultModel(claudeData.data.defaultModel);
        }
        const providerList = [...claudeProviders, ...codexProviders, ...geminiProviders];
        // 按 appType 和 sortIndex 排序
        providerList.sort((a, b) => {
          // 先按 appType 排序：claude > codex > gemini
          const typeOrder = { claude: 0, codex: 1, gemini: 2 };
          const aType = typeOrder[a.appType] ?? 99;
          const bType = typeOrder[b.appType] ?? 99;
          if (aType !== bType) return aType - bType;
          // 再按 sortIndex 排序
          const aIndex = a.sortIndex ?? 999999;
          const bIndex = b.sortIndex ?? 999999;
          if (aIndex !== bIndex) return aIndex - bIndex;
          return (a.createdAt || 0) - (b.createdAt || 0);
        });
        setProviders(providerList);
      })
      .catch(err => console.error('加载供应商列表失败:', err));
  }, []); // 空依赖数组，只在挂载时执行一次

  // 监听供应商测试结果
  useEffect(() => {
    const handleTestResult = (result) => {
      setProviderTestStatus(result.success ? 'success' : 'error');
      setProviderTestMessage(result.message);
    };
    socket.on('settings:testResult', handleTestResult);
    return () => socket.off('settings:testResult', handleTestResult);
  }, []);

  // 测试选中的供应商
  const testSelectedProvider = () => {
    if (!selectedProviderId) return;
    const [appType, providerId] = selectedProviderId.split(':');
    setProviderTestStatus('testing');
    setProviderTestMessage('正在测试连接...');
    socket.emit('settings:testProvider', { providerId, appType });
  };

  // 选择供应商时自动填充配置
  const handleProviderSelect = async (value) => {
    setSelectedProviderId(value);
    // 重置测试状态
    setProviderTestStatus(null);
    setProviderTestMessage('');

    if (!value) {
      // 清空选择
      return;
    }

    // 解析 value 格式：appType:id
    const [appType, providerId] = value.split(':');
    const provider = providers.find(p => p.appType === appType && p.id === providerId);
    if (!provider) {
      return;
    }

    // 使用 API 返回的扁平字段（已从 CC Switch 格式转换）
    // apiType: claude -> 'claude', codex -> 'openai', gemini -> 'gemini'
    const apiType = provider.apiType || (appType === 'codex' ? 'openai' : appType);
    const apiUrl = provider.url || '';
    const apiKey = provider.apiKey || '';
    const model = provider.model || '';

    // 根据 apiType 设置对应的配置
    const updates = {
      apiType,
      _providerId: value,
      _providerName: `${provider.name} (${appType})`
    };

    if (apiType === 'openai') {
      // Codex 使用 OpenAI 协议
      updates.openai = {
        apiUrl: apiUrl ? `${apiUrl}/v1/chat/completions` : '',
        apiKey,
        model: model || 'gpt-4o'
      };
    } else if (apiType === 'claude') {
      // Claude 使用 Anthropic 协议
      updates.claude = {
        apiUrl: apiUrl ? `${apiUrl}/v1/messages` : '',
        apiKey,
        model: model || defaultModel
      };
    }

    onChange(prev => ({ ...prev, ...updates }));
  };

  // 测试 API 连接
  const testApi = async (type) => {
    setTestStatus(prev => ({ ...prev, [type]: 'testing' }));
    setTestMessage(prev => ({ ...prev, [type]: '测试中...' }));

    try {
      const config = type === 'openai' ? settings.openai : settings.claude;
      const res = await fetch('/api/ai/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, config })
      });
      const data = await res.json();

      if (data.success) {
        setTestStatus(prev => ({ ...prev, [type]: 'success' }));
        setTestMessage(prev => ({ ...prev, [type]: `✓ 连接成功 (${data.latency}ms)` }));
      } else {
        setTestStatus(prev => ({ ...prev, [type]: 'error' }));
        setTestMessage(prev => ({ ...prev, [type]: `✗ ${data.error}` }));
      }
    } catch (err) {
      setTestStatus(prev => ({ ...prev, [type]: 'error' }));
      setTestMessage(prev => ({ ...prev, [type]: `✗ 请求失败: ${err.message}` }));
    }
  };

  // 切换当前使用的 API
  const switchToApi = (type) => {
    onChange(prev => ({ ...prev, apiType: type }));
  };

  const updateField = (field, value) => {
    onChange(prev => ({ ...prev, [field]: value }));
  };

  const handleAuthSetup = async () => {
    if (authPassword !== authConfirm) {
      setAuthMessage('两次密码不一致');
      return;
    }
    if (authPassword && authPassword.length < 4) {
      setAuthMessage('密码至少 4 位');
      return;
    }

    const result = await auth.setupAuth(authUsername, authPassword);
    if (result.success) {
      setAuthMessage(result.message || '设置成功');
      setAuthPassword('');
      setAuthConfirm('');
    } else {
      setAuthMessage(result.error || '设置失败');
    }
  };

  const handleDisableAuth = async () => {
    const result = await auth.setupAuth(null, null, true);
    if (result.success) {
      setAuthMessage('已禁用密码保护');
    }
  };

  const handleLogout = async () => {
    await auth.logout();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className={`modal settings-modal ${activeTab === 'api' ? 'api-tab' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="settings-tabs">
          <button
            className={`tab-btn ${activeTab === 'ai' ? 'active' : ''}`}
            onClick={() => setActiveTab('ai')}
          >
            {t('settings.ai')}
          </button>
          <button
            className={`tab-btn ${activeTab === 'api' ? 'active' : ''}`}
            onClick={() => setActiveTab('api')}
          >
            {t('settings.api')}
          </button>
          <button
            className={`tab-btn ${activeTab === 'auth' ? 'active' : ''}`}
            onClick={() => setActiveTab('auth')}
          >
            {t('settings.auth')}
          </button>
          <button
            className={`tab-btn ${activeTab === 'interface' ? 'active' : ''}`}
            onClick={() => setActiveTab('interface')}
          >
            {t('settings.interface')}
          </button>
        </div>

        {activeTab === 'ai' && (
          <form onSubmit={(e) => {
            e.preventDefault();
            onSave();
            if (onTunnelUrlChange) {
              onTunnelUrlChange(localTunnelUrl);
            }
          }}>
            {/* 供应商选择 */}
            <div className="form-group" style={{ marginBottom: '20px' }}>
              <label>AI 供应商</label>
              <select
                value={selectedProviderId}
                onChange={(e) => handleProviderSelect(e.target.value)}
                size={Math.min(12, 1 + providers.length)}
                style={{
                  width: '100%',
                  padding: '8px',
                  background: '#2a2a2a',
                  border: '1px solid #444',
                  borderRadius: '4px',
                  color: '#fff',
                  minHeight: '120px',
                  maxHeight: '240px',
                  overflowY: 'auto'
                }}
              >
                <option value="">-- 手动配置 --</option>
                {providers.filter(p => p.appType === 'claude').length > 0 && (
                  <optgroup label="Claude">
                    {providers.filter(p => p.appType === 'claude').map(provider => (
                      <option key={`${provider.appType}-${provider.id}`} value={`${provider.appType}:${provider.id}`}>
                        {provider.name}{selectedProviderId === `${provider.appType}:${provider.id}` ? ' ✓' : ''}
                      </option>
                    ))}
                  </optgroup>
                )}
                {providers.filter(p => p.appType === 'codex').length > 0 && (
                  <optgroup label="Codex">
                    {providers.filter(p => p.appType === 'codex').map(provider => (
                      <option key={`${provider.appType}-${provider.id}`} value={`${provider.appType}:${provider.id}`}>
                        {provider.name}{selectedProviderId === `${provider.appType}:${provider.id}` ? ' ✓' : ''}
                      </option>
                    ))}
                  </optgroup>
                )}
                {providers.filter(p => p.appType === 'gemini').length > 0 && (
                  <optgroup label="Gemini">
                    {providers.filter(p => p.appType === 'gemini').map(provider => (
                      <option key={`${provider.appType}-${provider.id}`} value={`${provider.appType}:${provider.id}`}>
                        {provider.name}{selectedProviderId === `${provider.appType}:${provider.id}` ? ' ✓' : ''}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>

            {/* 供应商配置信息卡片 */}
            {selectedProviderId && selectedProviderId !== '' && (() => {
              const [appType, providerId] = selectedProviderId.split(':');
              const provider = providers.find(p => p.appType === appType && p.id === providerId);

              if (!provider) {
                console.log('[SettingsModal] 找不到供应商:', { selectedProviderId, appType, providerId, providersCount: providers.length });
                return null;
              }

              // 使用 API 返回的扁平字段（已从 CC Switch 格式转换）
              const apiUrl = provider.url || '未配置';
              const apiKey = provider.apiKey || '';
              const apiType = provider.apiType || (appType === 'codex' ? 'openai' : 'claude');
              // 根据 apiType 设置默认模型
              const model = provider.model || (apiType === 'openai' ? 'gpt-4o' : defaultModel);

              return (
                <div style={{
                  padding: '16px',
                  background: '#1a1a1a',
                  borderRadius: '8px',
                  border: '2px solid #10b981',
                  marginBottom: '16px'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                    <span style={{ fontSize: '14px', fontWeight: 'bold', color: '#10b981' }}>
                      {provider.name}
                    </span>
                    <span style={{ fontSize: '11px', background: '#10b98120', color: '#10b981', padding: '2px 8px', borderRadius: '4px' }}>
                      {appType.toUpperCase()}
                    </span>
                    <span style={{ fontSize: '11px', background: '#3b82f620', color: '#3b82f6', padding: '2px 8px', borderRadius: '4px' }}>
                      {apiType === 'claude' ? 'Claude API' : 'OpenAI API'}
                    </span>
                  </div>
                  <div style={{ fontSize: '12px', color: '#888', lineHeight: '1.6' }}>
                    <div style={{ marginBottom: '6px' }}>
                      <span style={{ color: '#aaa' }}>API URL: </span>
                      <span style={{ color: '#fff', fontFamily: 'monospace', fontSize: '11px' }}>
                        {apiUrl}
                      </span>
                    </div>
                    <div style={{ marginBottom: '6px' }}>
                      <span style={{ color: '#aaa' }}>API Key: </span>
                      <span style={{ color: '#fff', fontFamily: 'monospace', fontSize: '11px' }}>
                        {apiKey ? `${apiKey.substring(0, 8)}...` : '未配置'}
                      </span>
                    </div>
                    <div>
                      <span style={{ color: '#aaa' }}>模型: </span>
                      <span style={{ color: '#fff', fontFamily: 'monospace', fontSize: '11px' }}>
                        {model}
                      </span>
                    </div>
                  </div>
                  {/* 测试按钮和结果 */}
                  <div style={{ marginTop: '12px', display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <button
                      onClick={testSelectedProvider}
                      disabled={providerTestStatus === 'testing'}
                      style={{
                        padding: '6px 16px',
                        background: providerTestStatus === 'testing' ? '#4b5563' : '#3b82f6',
                        color: '#fff',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: providerTestStatus === 'testing' ? 'not-allowed' : 'pointer',
                        fontSize: '12px'
                      }}
                    >
                      {providerTestStatus === 'testing' ? '测试中...' : '测试连接'}
                    </button>
                    {providerTestStatus && providerTestStatus !== 'testing' && (
                      <span style={{
                        fontSize: '12px',
                        color: providerTestStatus === 'success' ? '#10b981' : '#ef4444'
                      }}>
                        {providerTestMessage}
                      </span>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* 手动配置表单 */}
            {selectedProviderId === '' && (
              <>
                <div className="form-group">
                  <label>API 类型</label>
                  <select
                    value={settings.apiType || 'openai'}
                    onChange={(e) => updateField('apiType', e.target.value)}
                  >
                    <option value="openai">OpenAI 兼容</option>
                    <option value="claude">Claude 原生</option>
                  </select>
                </div>

                {settings.apiType === 'openai' && (
                  <fieldset style={{
                    border: '2px solid #10b981',
                    borderRadius: '8px',
                    padding: '12px',
                    marginBottom: '16px'
                  }}>
                    <legend style={{ color: '#10b981', fontSize: '13px', padding: '0 8px' }}>
                      OpenAI 配置
                    </legend>
                    <div className="form-group">
                      <label>API URL</label>
                      <input
                        type="text"
                        value={settings.openai?.apiUrl || ''}
                        onChange={(e) => updateField('openai', { ...settings.openai, apiUrl: e.target.value })}
                        placeholder="https://api.openai.com/v1/chat/completions"
                      />
                    </div>
                    <div className="form-group">
                      <label>API Key（可选）</label>
                      <input
                        type="password"
                        value={settings.openai?.apiKey || ''}
                        onChange={(e) => updateField('openai', { ...settings.openai, apiKey: e.target.value })}
                        placeholder="sk-... 或留空"
                      />
                    </div>
                    <div className="form-group">
                      <label>模型</label>
                      <input
                        type="text"
                        value={settings.openai?.model || ''}
                        onChange={(e) => updateField('openai', { ...settings.openai, model: e.target.value })}
                        placeholder="opus / sonnet / gpt-4o 等"
                      />
                    </div>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '12px' }}>
                      <button
                        type="button"
                        onClick={() => testApi('openai')}
                        disabled={testStatus.openai === 'testing'}
                        style={{
                          padding: '6px 12px',
                          background: testStatus.openai === 'success' ? '#10b981' : testStatus.openai === 'error' ? '#ef4444' : '#3b82f6',
                          color: '#fff',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: testStatus.openai === 'testing' ? 'wait' : 'pointer',
                          fontSize: '12px'
                        }}
                      >
                        {testStatus.openai === 'testing' ? '测试中...' : '测试连接'}
                      </button>
                      {testMessage.openai && (
                        <span style={{
                          fontSize: '12px',
                          color: testStatus.openai === 'success' ? '#10b981' : testStatus.openai === 'error' ? '#ef4444' : '#888'
                        }}>
                          {testMessage.openai}
                        </span>
                      )}
                    </div>
                  </fieldset>
                )}

                {settings.apiType === 'claude' && (
                  <fieldset style={{
                    border: '2px solid #8b5cf6',
                    borderRadius: '8px',
                    padding: '12px',
                    marginBottom: '16px'
                  }}>
                    <legend style={{ color: '#8b5cf6', fontSize: '13px', padding: '0 8px' }}>
                      Claude 配置{settings._providerName ? ` - ${settings._providerName}` : ''}
                    </legend>
                    <div className="form-group">
                      <label>API URL</label>
                      <input
                        type="text"
                        value={settings.claude?.apiUrl || ''}
                        onChange={(e) => updateField('claude', { ...settings.claude, apiUrl: e.target.value })}
                        placeholder="https://api.anthropic.com/v1/messages"
                      />
                    </div>
                    <div className="form-group">
                      <label>API Key</label>
                      <input
                        type="password"
                        value={settings.claude?.apiKey || ''}
                        onChange={(e) => updateField('claude', { ...settings.claude, apiKey: e.target.value })}
                        placeholder="sk-..."
                      />
                    </div>
                    <div className="form-group">
                      <label>模型</label>
                      <input
                        type="text"
                        value={settings.claude?.model || ''}
                        onChange={(e) => updateField('claude', { ...settings.claude, model: e.target.value })}
                        placeholder="claude-sonnet-4-5-20250929 等"
                      />
                    </div>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '12px' }}>
                      <button
                        type="button"
                        onClick={() => testApi('claude')}
                        disabled={testStatus.claude === 'testing'}
                        style={{
                          padding: '6px 12px',
                          background: testStatus.claude === 'success' ? '#10b981' : testStatus.claude === 'error' ? '#ef4444' : '#3b82f6',
                          color: '#fff',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: testStatus.claude === 'testing' ? 'wait' : 'pointer',
                          fontSize: '12px'
                        }}
                      >
                        {testStatus.claude === 'testing' ? '测试中...' : '测试连接'}
                      </button>
                      {testMessage.claude && (
                        <span style={{
                          fontSize: '12px',
                          color: testStatus.claude === 'success' ? '#10b981' : testStatus.claude === 'error' ? '#ef4444' : '#888'
                        }}>
                          {testMessage.claude}
                        </span>
                      )}
                    </div>
                  </fieldset>
                )}
              </>
            )}

            {/* 通用设置 */}
            <div className="form-row">
              <div className="form-group half">
                <label>Max Tokens</label>
                <input
                  type="number"
                  value={settings.maxTokens || 500}
                  onChange={(e) => updateField('maxTokens', parseInt(e.target.value) || 500)}
                  min="100"
                  max="4096"
                />
              </div>
              <div className="form-group half">
                <label>Temperature</label>
                <input
                  type="number"
                  value={settings.temperature || 0.7}
                  onChange={(e) => updateField('temperature', parseFloat(e.target.value) || 0.7)}
                  min="0"
                  max="1"
                  step="0.1"
                />
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                取消
              </button>
              <button type="submit" className="btn btn-primary">
                保存
              </button>
            </div>
          </form>
        )}

        {activeTab === 'api' && (
          <div style={{
            height: '600px',
            margin: '-20px',
            marginTop: '0',
            borderRadius: '0 0 8px 8px',
            overflow: 'hidden'
          }}>
            <iframe
              src="/cc-switch/index.html"
              style={{
                width: '100%',
                height: '100%',
                border: 'none',
                display: 'block'
              }}
              title="CC Switch API Configuration"
              onLoad={() => setCcSwitchLoaded(true)}
            />
          </div>
        )}

        {activeTab === 'auth' && (
          <div className="auth-settings">
            {/* 外部访问 URL */}
            <div className="form-group">
              <label>外部访问 URL（Cloudflare Tunnel）</label>
              <input
                type="text"
                value={localTunnelUrl}
                onChange={(e) => setLocalTunnelUrl(e.target.value)}
                placeholder="https://xxx.trycloudflare.com"
              />
              <small style={{ color: '#888', fontSize: '12px', marginTop: '4px', display: 'block' }}>
                配置后将在左下角显示二维码，方便手机扫码访问
              </small>
            </div>

            <div style={{ borderTop: '1px solid #333', margin: '20px 0' }}></div>

            <div className="auth-status">
              <div>
                <span>密码保护: </span>
                <span className={auth.enabled ? 'status-enabled' : 'status-disabled'}>
                  {auth.enabled ? '已启用' : '未启用'}
                </span>
              </div>
              {auth.isLocal && (
                <div className="local-hint">
                  本机访问自动放行，无需密码
                </div>
              )}
            </div>

            <div className="form-group">
              <label>用户名</label>
              <input
                type="text"
                value={authUsername}
                onChange={(e) => setAuthUsername(e.target.value)}
                placeholder="admin"
              />
            </div>
            <div className="form-group">
              <label>{auth.enabled ? '新密码' : '设置密码'}</label>
              <input
                type="password"
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
                placeholder={auth.enabled ? '留空则不修改' : '设置访问密码'}
              />
            </div>
            <div className="form-group">
              <label>确认密码</label>
              <input
                type="password"
                value={authConfirm}
                onChange={(e) => setAuthConfirm(e.target.value)}
                placeholder="再次输入密码"
              />
            </div>

            {authMessage && <div className="auth-message">{authMessage}</div>}

            <div className="modal-actions" style={{ marginBottom: '16px' }}>
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                取消
              </button>
              <button type="button" className="btn btn-primary" onClick={() => {
                if (onTunnelUrlChange) {
                  onTunnelUrlChange(localTunnelUrl);
                }
                setAuthMessage('外部访问 URL 已保存');
                setTimeout(() => setAuthMessage(''), 2000);
              }}>
                保存 URL
              </button>
            </div>

            <div style={{ borderTop: '1px solid #333', margin: '20px 0' }}></div>

            <div className="modal-actions">
              {auth.enabled && (
                <>
                  <button type="button" className="btn btn-danger" onClick={handleDisableAuth}>
                    禁用密码
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={handleLogout}>
                    退出登录
                  </button>
                </>
              )}
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                取消
              </button>
              <button type="button" className="btn btn-primary" onClick={handleAuthSetup}>
                {auth.enabled ? '更新密码' : '启用密码'}
              </button>
            </div>
          </div>
        )}

        {activeTab === 'interface' && (
          <div className="interface-settings">
            <div className="form-group">
              <h3 style={{ margin: '0 0 12px 0', fontSize: '16px', color: '#fff' }}>
                {t('interface.language')}
              </h3>
              <small style={{ color: '#888', fontSize: '12px', display: 'block', marginBottom: '16px' }}>
                {t('interface.languageHint')}
              </small>
              <div style={{ display: 'flex', gap: '12px' }}>
                <button
                  type="button"
                  className={`language-btn ${language === 'zh-CN' ? 'active' : ''}`}
                  onClick={() => {
                    changeLanguage('zh-CN');
                    toast.success(t('toast.languageSwitched'));
                  }}
                  style={{
                    flex: 1,
                    padding: '12px 24px',
                    background: language === 'zh-CN' ? '#4a9eff' : '#2a2a2a',
                    border: `2px solid ${language === 'zh-CN' ? '#4a9eff' : '#444'}`,
                    borderRadius: '8px',
                    color: '#fff',
                    fontSize: '14px',
                    fontWeight: language === 'zh-CN' ? '600' : '400',
                    cursor: 'pointer',
                    transition: 'all 0.2s'
                  }}
                >
                  {t('interface.chinese')}
                </button>
                <button
                  type="button"
                  className={`language-btn ${language === 'en' ? 'active' : ''}`}
                  onClick={() => {
                    changeLanguage('en');
                    toast.success(t('toast.languageSwitched'));
                  }}
                  style={{
                    flex: 1,
                    padding: '12px 24px',
                    background: language === 'en' ? '#4a9eff' : '#2a2a2a',
                    border: `2px solid ${language === 'en' ? '#4a9eff' : '#444'}`,
                    borderRadius: '8px',
                    color: '#fff',
                    fontSize: '14px',
                    fontWeight: language === 'en' ? '600' : '400',
                    cursor: 'pointer',
                    transition: 'all 0.2s'
                  }}
                >
                  {t('interface.english')}
                </button>
                <button
                  type="button"
                  className={`language-btn ${language === 'ja' ? 'active' : ''}`}
                  onClick={() => {
                    changeLanguage('ja');
                    toast.success(t('toast.languageSwitched'));
                  }}
                  style={{
                    flex: 1,
                    padding: '12px 24px',
                    background: language === 'ja' ? '#4a9eff' : '#2a2a2a',
                    border: `2px solid ${language === 'ja' ? '#4a9eff' : '#444'}`,
                    borderRadius: '8px',
                    color: '#fff',
                    fontSize: '14px',
                    fontWeight: language === 'ja' ? '600' : '400',
                    cursor: 'pointer',
                    transition: 'all 0.2s'
                  }}
                >
                  {t('interface.japanese')}
                </button>
              </div>
            </div>

            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                {t('common.close')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CreateSessionModal({ onClose, onCreate }) {
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [aiType, setAiType] = useState('claude'); // 默认使用 Claude

  const handleSubmit = (e) => {
    e.preventDefault();
    onCreate({
      name: name || `session-${Date.now()}`,
      goal,
      systemPrompt,
      aiType // 添加 AI 类型
    });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>创建新会话</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>AI 类型</label>
            <select
              value={aiType}
              onChange={(e) => setAiType(e.target.value)}
              style={{ width: '100%', padding: '8px', background: '#2a2a2a', border: '1px solid #444', borderRadius: '4px', color: '#fff' }}
            >
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
              <option value="gemini">Gemini</option>
            </select>
          </div>
          <div className="form-group">
            <label>会话名称</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-session"
            />
          </div>
          <div className="form-group">
            <label>目标 (AI 将根据此目标提供建议)</label>
            <input
              type="text"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="例如: 部署 Node.js 应用到服务器"
            />
          </div>
          <div className="form-group">
            <label>系统提示词 (可选)</label>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="自定义 AI 的行为..."
            />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              取消
            </button>
            <button type="submit" className="btn btn-primary">
              创建
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function HistoryPanel({ sessionId, history, onClose }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal history-modal" onClick={(e) => e.stopPropagation()}>
        <h2>会话历史</h2>
        <div className="history-panel">
          {history.map((entry) => (
            <div key={entry.id} className={`history-entry ${entry.type}`}>
              <div className="history-time">
                {new Date(entry.createdAt).toLocaleTimeString()}
                {' - '}
                {entry.type === 'input' ? '输入' :
                 entry.type === 'output' ? '输出' :
                 entry.type === 'ai_decision' ? 'AI决策' : '系统'}
              </div>
              <div
                className="history-content"
                dangerouslySetInnerHTML={{
                  __html: (entry.type === 'input' ? '$ ' : '') + convertAnsiToHtml(entry.content || '')
                }}
              />
              {entry.aiReasoning && (
                <div
                  className="history-reasoning"
                  dangerouslySetInnerHTML={{
                    __html: '理由: ' + convertAnsiToHtml(entry.aiReasoning)
                  }}
                />
              )}
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

// QR Code Widget 组件
function QRCodeWidget({ url, onClose }) {
  const canvasRef = useRef(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [showAccessLog, setShowAccessLog] = useState(false);

  useEffect(() => {
    if (url && canvasRef.current) {
      import('qrcode').then(QRCode => {
        QRCode.default.toCanvas(canvasRef.current, url, {
          width: isExpanded ? 256 : 100,
          margin: 2,
          color: {
            dark: '#000000',
            light: '#FFFFFF'
          }
        });
      });
    }
  }, [url, isExpanded]);

  if (!url) return null;

  return (
    <>
      <div className="qrcode-widget" style={{
        position: 'fixed',
        bottom: isExpanded ? '50%' : '80px',
        left: isExpanded ? '50%' : '20px',
        transform: isExpanded ? 'translate(-50%, 50%)' : 'none',
        zIndex: isExpanded ? 2000 : 1000,
        transition: 'all 0.3s ease'
      }}>
        {isExpanded && (
          <div
            className="qrcode-overlay"
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: 'rgba(0, 0, 0, 0.7)',
              zIndex: -1
            }}
            onClick={() => setIsExpanded(false)}
          />
        )}
        <div style={{
          backgroundColor: 'white',
          padding: isExpanded ? '24px' : '10px',
          borderRadius: '8px',
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
          cursor: isExpanded ? 'default' : 'pointer',
          transition: 'all 0.3s ease',
          minWidth: isExpanded ? 'auto' : '120px'
        }} onClick={() => !isExpanded && setIsExpanded(true)}>
          <canvas ref={canvasRef} style={{ display: 'block' }} />
          {!isExpanded && (
            <div
              style={{
                marginTop: '8px',
                fontSize: '11px',
                color: '#0066cc',
                textAlign: 'center',
                cursor: 'pointer',
                textDecoration: 'underline',
                wordBreak: 'break-all',
                lineHeight: '1.3'
              }}
              onClick={(e) => {
                e.stopPropagation();
                setShowAccessLog(true);
              }}
            >
              {new URL(url).hostname}
            </div>
          )}
          {isExpanded && (
            <div style={{
              marginTop: '16px',
              textAlign: 'center',
              fontSize: '14px',
              color: '#333',
              wordBreak: 'break-all',
              maxWidth: '256px'
            }}>
              {url}
            </div>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (isExpanded) {
                setIsExpanded(false);
              } else {
                onClose();
              }
            }}
            style={{
              position: 'absolute',
              top: '8px',
              right: '8px',
              width: '24px',
              height: '24px',
              borderRadius: '50%',
              border: 'none',
              backgroundColor: 'rgba(0, 0, 0, 0.1)',
              color: '#666',
              fontSize: '16px',
              lineHeight: '24px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            {isExpanded ? '−' : '×'}
          </button>
        </div>
      </div>

      {/* 访问日志面板 */}
      {showAccessLog && (
        <div className="modal-overlay" onClick={() => setShowAccessLog(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px' }}>
            <h2>外部访问记录</h2>
            <div style={{ padding: '16px', backgroundColor: '#f5f5f5', borderRadius: '4px', marginBottom: '16px' }}>
              <div style={{ fontSize: '12px', color: '#666', marginBottom: '8px' }}>当前 Tunnel URL:</div>
              <div style={{ fontSize: '14px', color: '#333', wordBreak: 'break-all' }}>{url}</div>
            </div>
            <div style={{
              maxHeight: '400px',
              overflowY: 'auto',
              padding: '16px',
              backgroundColor: '#fafafa',
              borderRadius: '4px',
              color: '#666',
              textAlign: 'center'
            }}>
              功能开发中...
              <br />
              <small>后续版本将显示访问 IP、时间、User-Agent 等信息</small>
            </div>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setShowAccessLog(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// 登录页面组件
function LoginPage({ auth }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    const result = await auth.login(username, password);
    if (!result.success) {
      setError(result.error || '登录失败');
    }
    setLoading(false);
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>WebTmux</h1>
        <p className="login-subtitle">AI 自动化终端管理工具</p>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>用户名</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin"
              autoFocus
            />
          </div>
          <div className="form-group">
            <label>密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="请输入密码"
            />
          </div>
          {error && <div className="login-error">{error}</div>}
          <button type="submit" className="btn btn-primary btn-block" disabled={loading}>
            {loading ? '登录中...' : '登录'}
          </button>
        </form>
      </div>
    </div>
  );
}

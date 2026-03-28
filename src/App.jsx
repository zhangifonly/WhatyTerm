import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { io } from 'socket.io-client';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import Anser from 'anser';
import { ToastContainer, toast } from './components/Toast';
import { useTranslation } from './i18n';
import ScheduleManager from './components/ScheduleManager';
import ClosedSessionsList from './components/ClosedSessionsList';
import RecentProjects from './components/RecentProjects';
import CliToolsManager from './components/CliToolsManager';
import MonitorPluginsManager from './components/MonitorPluginsManager';
import ProviderPriority from './components/ProviderPriority';
import TerminalPlayback from './components/TerminalPlayback';
import StorageManager from './components/StorageManager';
import AdvancedSettings from './components/ProviderManager/AdvancedSettings';
import TeamView from './components/TeamView';
import TeamPanel from './components/TeamPanel';
import VoiceInput from './components/VoiceInput';

const socket = io();

// 防止终端输入重复发送（解决 React StrictMode / HMR 导致的重复问题）
let lastInputTime = 0;
let lastInputData = '';
const INPUT_DEBOUNCE_MS = 50; // 50ms 内的相同输入视为重复

// IME 输入法状态跟踪
let isComposing = false;

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

  // 本地登录（用户名+密码）
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

  // 在线登录（邮箱+密码，使用订阅系统账户）
  const onlineLogin = async (email, password) => {
    const res = await fetch('/api/auth/online-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (data.success) {
      await checkAuth();
      return { success: true, user: data.user };
    }
    return { success: false, error: data.error, remainingAttempts: data.remainingAttempts };
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

  return { ...authStatus, login, onlineLogin, logout, setupAuth, checkAuth };
}

// 光标同步防抖和位置缓存（模块级变量）
// 仅在 Windows 平台启用光标同步（用于 IME 输入法定位）
// macOS/Linux 不需要此功能，禁用以避免输入时底部闪烁
const isWindowsPlatform = typeof navigator !== 'undefined' &&
  (navigator.platform?.includes('Win') || navigator.userAgent?.includes('Windows'));
let lastCursorX = -1;
let lastCursorY = -1;
let cursorSyncTimeout = null;

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
  const { t } = useTranslation();
  const auth = useAuth();
  // 从 localStorage 读取缓存的会话列表，加速首页加载
  const [sessions, setSessions] = useState(() => {
    try {
      const cached = localStorage.getItem('webtmux_sessions_cache');
      return cached ? JSON.parse(cached) : [];
    } catch { return []; }
  });
  const [currentSession, setCurrentSession] = useState(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [suggestion, setSuggestion] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [playbackSessionId, setPlaybackSessionId] = useState(null); // 用于存储管理的回放
  const [playbackProjectPath, setPlaybackProjectPath] = useState(null); // 用于项目级别的回放
  const [editingGoal, setEditingGoal] = useState(false);
  const [goalInput, setGoalInput] = useState('');
  const [generatingGoal, setGeneratingGoal] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsDefaultTab, setSettingsDefaultTab] = useState('ai'); // 设置页面默认标签页
  const [showScheduleManager, setShowScheduleManager] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [creatingProjectPaths, setCreatingProjectPaths] = useState(new Set()); // 正在创建会话的项目路径
  const [aiPanelCollapsed, setAiPanelCollapsed] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [aiSettings, setAiSettings] = useState({
    model: 'sonnet',
    apiUrl: 'https://agent-ai.webtrn.cn/v1/chat/completions',
    maxTokens: 500,
    temperature: 0.7,
    showSuggestions: false,  // 默认关闭 AI 建议弹窗
    confirmCloseSession: true,  // 默认开启关闭会话确认
    voiceInputEnabled: false,  // 默认关闭语音输入
    voiceMode: 'confirm'  // confirm=确认后发送, auto=直接发送
  });
  // 关闭会话确认对话框状态
  const [closeSessionConfirm, setCloseSessionConfirm] = useState({ show: false, session: null });
  const [tunnelUrl, setTunnelUrl] = useState('');
  // 二维码折叠状态（从 localStorage 读取）
  const [qrCodeExpanded, setQrCodeExpanded] = useState(() => {
    const saved = localStorage.getItem('webtmux_qr_expanded');
    return saved === 'true';
  });
  const [aiStatusMap, setAiStatusMap] = useState({});
  const [monitorPlugins, setMonitorPlugins] = useState([]); // 监控策略插件列表
  const [sessionMemory, setSessionMemory] = useState({}); // 会话内存占用 {sessionId: {memory, processCount}}
  const [processDetails, setProcessDetails] = useState(null); // 进程详情弹窗 {sessionId, details, position}
  const [aiStatusLoading, setAiStatusLoading] = useState({});
  const [aiDebugLogs, setAiDebugLogs] = useState([]);
  const [showDebugPanel, setShowDebugPanel] = useState(false);
  const [pendingScreenContent, setPendingScreenContent] = useState(null);
  const [pendingCursorPosition, setPendingCursorPosition] = useState(null);
  const [terminalReady, setTerminalReady] = useState(false); // 跟踪终端是否已初始化
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
  // 会话悬停提示状态
  const [hoveredSession, setHoveredSession] = useState(null);
  const [tooltipPosition, setTooltipPosition] = useState({ top: 0 });
  // 订阅状态
  const [subscriptionStatus, setSubscriptionStatus] = useState(null);
  // Team 相关状态
  const [teams, setTeams] = useState([]);
  const [currentTeam, setCurrentTeam] = useState(null);
  const [showCreateTeamDialog, setShowCreateTeamDialog] = useState(false);
  const [showStartTeamDialog, setShowStartTeamDialog] = useState(false);
  const [sessionContextMenu, setSessionContextMenu] = useState(null); // { session, x, y }
  // 注意：autoActionEnabled 现在存储在服务器端，通过 session.autoActionEnabled 获取

  const terminalRef = useRef(null);
  const terminalInstance = useRef(null);
  const fitAddon = useRef(null);
  const currentSessionRef = useRef(null);

  // 保持 currentSession 的 ref 同步
  useEffect(() => {
    currentSessionRef.current = currentSession;
  }, [currentSession]);

  // 保存二维码折叠偏好到 localStorage
  useEffect(() => {
    localStorage.setItem('webtmux_qr_expanded', qrCodeExpanded.toString());
  }, [qrCodeExpanded]);

  // 设置暗色主题
  useEffect(() => {
    document.documentElement.classList.add('dark');
    return () => {
      document.documentElement.classList.remove('dark');
    };
  }, []);

  // 初始化 Socket 监听
  useEffect(() => {
    // 规范化路径（去除末尾斜杠）
    const normalizePath = (p) => p ? p.replace(/\/+$/, '') : '';

    // 更新会话列表并缓存到 localStorage
    const handleSessionsList = (data) => {
      setSessions(data);
      // 清除已创建会话的"正在创建"标记
      setCreatingProjectPaths(prev => {
        const newSet = new Set(prev);
        for (const session of data) {
          if (session.workingDir) {
            const normalizedWorkingDir = normalizePath(session.workingDir);
            // 检查规范化后的路径是否在集合中
            for (const path of newSet) {
              if (normalizePath(path) === normalizedWorkingDir) {
                newSet.delete(path);
              }
            }
          }
        }
        return newSet.size !== prev.size ? newSet : prev;
      });
      // 同时更新 currentSession（如果当前会话在列表中）
      setCurrentSession(prev => {
        if (!prev) return prev;
        const updated = data.find(s => s.id === prev.id);
        return updated ? { ...prev, ...updated } : prev;
      });
      try {
        localStorage.setItem('webtmux_sessions_cache', JSON.stringify(data));
      } catch { /* 忽略存储错误 */ }
    };

    socket.on('sessions:list', handleSessionsList);
    socket.on('sessions:updated', handleSessionsList);

    // 处理 socket 重连：重新 attach 到当前会话
    socket.on('connect', () => {
      console.log('[Socket] 已连接');
      // 重连后重新获取会话列表
      socket.emit('sessions:list');
      // 如果有当前会话，重新 attach
      const currentSession = currentSessionRef.current;
      if (currentSession) {
        console.log('[Socket] 重连后重新 attach 到会话:', currentSession.id);
        socket.emit('session:attach', currentSession.id);
      }
    });

    socket.on('disconnect', (reason) => {
      console.log('[Socket] 断开连接:', reason);
    });

    socket.on('session:attached', (data) => {
      const attachedTime = performance.now();
      // 使用 fullContent（包含滚动历史）以支持向上翻页
      // screenContent 只有当前屏幕内容，会丢失历史
      const fullLen = data.fullContent?.length || 0;
      const screenLen = data.screenContent?.length || 0;
      const fullLines = data.fullContent?.split('\n').length || 0;
      console.log('[session:attached] 收到内容:', {
        fullContentLength: fullLen,
        fullContentKB: (fullLen / 1024).toFixed(1) + 'KB',
        screenContentLength: screenLen,
        fullContentLines: fullLines
      });
      setPendingScreenContent(data.fullContent || data.screenContent || '');
      setPendingCursorPosition(data.cursorPosition);
      setCurrentSession(data.session);
    });

    socket.on('session:updated', (sessionUpdate) => {
      // 更新 currentSession
      setCurrentSession(prev => prev?.id === sessionUpdate.id ? { ...prev, ...sessionUpdate } : prev);
      // 更新 sessions 列表中的对应会话
      setSessions(prev => prev.map(s => s.id === sessionUpdate.id ? { ...s, ...sessionUpdate } : s));
    });

    // 处理会话退出事件（用户输入 exit 退出时触发）
    socket.on('session:exited', ({ sessionId }) => {
      console.log(`[App] 会话已退出: ${sessionId}`);
      // 如果退出的是当前会话，清除 currentSession
      setCurrentSession(prev => {
        if (prev?.id === sessionId) {
          // 清理终端
          if (terminalInstance.current) {
            terminalInstance.current.clear();
          }
          return null;
        }
        return prev;
      });
    });

    socket.on('terminal:output', (data) => {
      if (terminalInstance.current && data.sessionId === currentSessionRef.current?.id) {
        terminalInstance.current.write(data.data);

        // Windows 平台：将 xterm.js 光标移动到 Ink 假光标位置（用于 IME 输入法定位）
        // macOS/Linux 不需要此功能，跳过以避免输入时底部闪烁
        if (!isWindowsPlatform) return;

        // 使用防抖避免频繁移动导致闪烁
        if (cursorSyncTimeout) {
          clearTimeout(cursorSyncTimeout);
        }
        cursorSyncTimeout = setTimeout(() => {
          if (!terminalInstance.current) return;
          const term = terminalInstance.current;
          const buffer = term.buffer.active;

          // 从底部向上搜索反色空格（Ink 的假光标）
          for (let row = buffer.viewportY + term.rows - 1; row >= buffer.viewportY; row--) {
            const line = buffer.getLine(row);
            if (!line) continue;

            for (let col = 0; col < term.cols; col++) {
              const cell = line.getCell(col);
              if (cell) {
                const char = cell.getChars();
                const isInverse = cell.isInverse();
                // Ink 假光标：反色属性的空格或空字符
                if (isInverse && (char === ' ' || char === '')) {
                  const y = row - buffer.viewportY + 1;
                  const x = col + 1;
                  // 只有位置变化时才移动光标，避免重复移动
                  if (x !== lastCursorX || y !== lastCursorY) {
                    lastCursorX = x;
                    lastCursorY = y;
                    term.write(`\x1b[${y};${x}H`);
                  }
                  return;
                }
              }
            }
          }
        }, 100); // 100ms 防抖
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

    // Team 事件
    socket.on('teams:list', (data) => setTeams(data || []));
    socket.on('teams:updated', (data) => setTeams(data || []));
    socket.on('team:created', (team) => {
      setCurrentSession(null);
      setCurrentTeam(team);
    });
    socket.on('team:updated', (team) => {
      // 团队被销毁或完成时清除 currentTeam
      if (team.status === 'destroyed' || team.status === 'completed') {
        setCurrentTeam(prev => prev?.id === team.id ? null : prev);
      } else {
        setCurrentTeam(prev => prev?.id === team.id ? team : prev);
      }
      setTeams(prev => prev.map(t => t.id === team.id ? team : t));
    });
    socket.emit('teams:list');

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('sessions:list');
      socket.off('sessions:updated');
      socket.off('session:attached');
      socket.off('session:updated');
      socket.off('session:exited');
      socket.off('terminal:output');
      socket.off('ai:suggestion');
      socket.off('ai:autoExecuted');
      socket.off('ai:executed');
      socket.off('ai:complete');
      socket.off('ai:needInput');
      socket.off('settings:loaded');
      socket.off('tunnel:connected');
      socket.off('tunnel:disconnected');
      socket.off('teams:list');
      socket.off('teams:updated');
      socket.off('team:created');
      socket.off('team:updated');
    };
  }, []);

  // 加载 AI 设置
  useEffect(() => {
    socket.on('settings:loaded', (settings) => {
      setAiSettings(prev => ({ ...prev, ...settings }));
      if (settings.tunnelUrl) {
        setTunnelUrl(settings.tunnelUrl);
      }
    });
    socket.emit('settings:load');

    // 加载 tunnel URL
    fetch('/api/tunnel/url')
      .then(res => res.json())
      .then(data => {
        if (data.tunnelUrl) {
          setTunnelUrl(data.tunnelUrl);
        }
      })
      .catch(err => console.error('加载 tunnel URL 失败:', err));

    // 加载监控策略插件列表
    fetch('/api/monitor-plugins')
      .then(res => res.json())
      .then(data => {
        if (data.plugins) {
          setMonitorPlugins(data.plugins);
        }
      })
      .catch(err => console.error('加载监控插件失败:', err));

    // 加载订阅状态
    fetch('/api/subscription/status')
      .then(res => res.json())
      .then(data => {
        setSubscriptionStatus(data);
      })
      .catch(err => console.error('加载订阅状态失败:', err));

    // 监听 Cloudflare Tunnel 连接事件（自动获取免费域名）
    socket.on('tunnel:connected', (data) => {
      console.log('[Tunnel] 已连接:', data.url);
      setTunnelUrl(data.url);
    });

    socket.on('tunnel:disconnected', () => {
      console.log('[Tunnel] 已断开');
      setTunnelUrl('');
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

      // 当状态是不需要操作时（如程序运行中），清除当前会话的旧建议
      if (data.needsAction === false && data.sessionId === currentSessionRef.current?.id) {
        setSuggestion(null);
      }
    });

    // 监听会话内存更新
    socket.on('sessions:memory', (memoryMap) => {
      setSessionMemory(memoryMap);
    });

    // 监听进程详情响应
    socket.on('session:processDetails', (data) => {
      setProcessDetails(prev => prev && prev.sessionId === data.sessionId
        ? { ...prev, details: data.details }
        : prev
      );
    });

    socket.on('ai:statusLoading', (data) => {
      setAiStatusLoading(prev => ({ ...prev, [data.sessionId]: true }));
      addDebugLog('request', { sessionId: data.sessionId, message: t('aiPanel.requestingAnalysis') });
    });

    socket.on('ai:error', (data) => {
      addDebugLog('error', data);
    });

    // 监听 AI 健康状态变化
    socket.on('ai:healthStatus', (data) => {
      setAiHealthStatus(data);
      if (data.status === 'failed') {
        addDebugLog('healthError', {
          message: `${t('aiPanel.serviceFailedMsg')}: ${data.lastError}`,
          nextRetry: new Date(data.nextRecoveryCheck).toLocaleTimeString()
        });
      } else if (data.status === 'healthy' && data.consecutiveErrors === 0) {
        addDebugLog('healthRecovered', { message: t('aiPanel.serviceRecovered') });
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

  // 点击外部关闭进程详情弹窗
  useEffect(() => {
    if (!processDetails) return;

    const handleClickOutside = (e) => {
      if (!e.target.closest('.process-details-popup') && !e.target.closest('.process-count')) {
        setProcessDetails(null);
      }
    };

    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [processDetails]);

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

  // 初始化终端（复用终端实例，避免每次切换会话都重建）
  useEffect(() => {
    if (!terminalRef.current) return;

    // 如果已有终端实例，复用它（不销毁）
    if (terminalInstance.current) {
      // 终端已存在，只需要标记为就绪
      setTerminalReady(true);
      return;
    }

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Monaco, Menlo, monospace',
      scrollback: 10000,
      allowProposedApi: true,
      // 鼠标选择优化：按住 Option(Mac)/Alt(Win) 键可强制选择文本，绕过终端程序的鼠标模式
      macOptionClickForcesSelection: true,
      theme: {
        background: '#000000',
        foreground: '#eaeaea',
        cursor: '#e94560',
        selectionBackground: 'rgba(255, 255, 255, 0.3)'  // 选中文本背景色
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

    // 获取终端的 textarea 元素，用于监听 IME 事件
    const textareaElement = terminalRef.current?.querySelector('textarea.xterm-helper-textarea');

    // 监听 IME composition 事件
    const handleCompositionStart = () => {
      isComposing = true;
      console.log('[Terminal] IME composition started');
    };

    const handleCompositionEnd = () => {
      isComposing = false;
      console.log('[Terminal] IME composition ended');
    };

    if (textareaElement) {
      textareaElement.addEventListener('compositionstart', handleCompositionStart);
      textareaElement.addEventListener('compositionend', handleCompositionEnd);
    }

    // 注册输入监听器（dispose 时会自动清理）
    term.onData((data) => {
      const session = currentSessionRef.current;
      if (session) {
        // IME 组合中时跳过发送（等待组合完成）
        if (isComposing) {
          console.log('[Terminal] Skipping input during IME composition');
          return;
        }

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
    setTerminalReady(true); // 标记终端已初始化

    // 自动获取焦点
    term.focus();

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

    // 鼠标滚轮事件：让 xterm.js 自行处理滚动
    // xterm.js 在 normal screen 模式下会滚动 scrollback buffer（查看历史输出）
    // 在 alternate screen 模式下（如 Claude Code Ink 框架），xterm.js 会将滚轮转为上下箭头
    // 这是预期行为：normal screen 滚动历史，alternate screen 滚动输入记录
    const termElement = terminalRef.current;

    // 使用 ResizeObserver 监听容器大小变化
    const resizeObserver = new ResizeObserver(() => {
      handleResize();
    });
    resizeObserver.observe(terminalRef.current);

    return () => {
      window.removeEventListener('resize', handleResize);
      resizeObserver.disconnect();
      // 清理 IME 事件监听器
      if (textareaElement) {
        textareaElement.removeEventListener('compositionstart', handleCompositionStart);
        textareaElement.removeEventListener('compositionend', handleCompositionEnd);
      }
      // 重置 IME 状态
      isComposing = false;
      // 注意：不在这里销毁终端实例，让它在切换会话时复用
      // 终端实例只在组件真正卸载（currentSession 变为 null）时才销毁
      setTerminalReady(false);
    };
  }, [currentSession?.id]); // 依赖 currentSession?.id 以便在会话变化时重新设置事件监听

  // 当 currentSession 变为 null 时，销毁终端实例
  useEffect(() => {
    if (!currentSession && terminalInstance.current) {
      console.log('[Terminal] 会话关闭，销毁终端实例');
      terminalInstance.current.dispose();
      terminalInstance.current = null;
    }
  }, [currentSession]);

  // 处理缓存的屏幕内容
  useEffect(() => {
    // 只有当终端实例存在时才处理
    if (pendingScreenContent === null || !terminalInstance.current) {
      return;
    }

    const term = terminalInstance.current;

    // 使用局部变量保存当前要处理的内容，立即清空状态防止重复处理
    const contentToWrite = pendingScreenContent;
    setPendingScreenContent(null);
    setPendingCursorPosition(null);

    // 只有当有实际内容时才重置终端，避免不必要的清空
    if (contentToWrite.trim().length > 0) {
      // 清空终端（包括 scrollback buffer）
      // 然后写入新会话的完整历史，这样用户可以向上滚动查看
      term.clear();

      // 先调用 fit 确保尺寸正确
      if (fitAddon.current) {
        fitAddon.current.fit();
      }

      // 写入当前可见区域内容
      let content = contentToWrite.replace(/\r\n$/, '');

      // 调试：检查写入前的内容
      const contentLines = content.split(/\r?\n/).length;
      const writeStartTime = performance.now();
      console.log('[Terminal] 准备写入内容:', {
        contentLength: content.length,
        contentLines: contentLines,
        termRows: term.rows,
        willHaveScrollback: contentLines > term.rows
      });

      // 过滤掉光标保存/恢复序列，避免干扰
      content = content
        .replace(/\x1b\[s/g, '')  // 移除保存光标
        .replace(/\x1b\[u/g, '')  // 移除恢复光标
        .replace(/\x1b7/g, '')    // 移除 DEC 保存光标
        .replace(/\x1b8/g, '');   // 移除 DEC 恢复光标

      // 写入内容，使用 callback 确保写入完成后再滚动到底部
      term.write(content, () => {
        const writeTime = performance.now() - writeStartTime;
        // 调试：检查 buffer 状态
        const buffer = term.buffer.active;
        console.log('[Terminal] 写入完成:', {
          writeTime: `${writeTime.toFixed(1)}ms`,
          length: buffer.length,
          baseY: buffer.baseY,
          viewportY: buffer.viewportY,
          rows: term.rows,
          canScroll: buffer.length > term.rows
        });
        term.scrollToBottom();
      });

      // 发送 resize 事件同步尺寸
      setTimeout(() => {
        const session = currentSessionRef.current;
        if (session && terminalInstance.current) {
          socket.emit('terminal:resize', {
            sessionId: session.id,
            cols: terminalInstance.current.cols,
            rows: terminalInstance.current.rows
          });
        }
      }, 100);
    } else {
      console.warn('[Terminal] 收到空的屏幕内容，跳过重置以避免清空终端');
    }

    // 切换会话后自动获取焦点
    term.focus();
  }, [pendingScreenContent, pendingCursorPosition, terminalReady]);

  // 附加到会话
  const attachSession = useCallback((sessionId) => {
    // 不在这里清空终端，由 pendingScreenContent 处理时统一清空和写入
    setSuggestion(null);
    setCurrentTeam(null); // 切换到单会话视图
    socket.emit('session:attach', sessionId);
  }, []);

  // 创建会话
  const createSession = (data) => {
    socket.emit('session:create', data);
    setShowCreateModal(false);
  };

  // 打开最近项目（如果已有会话则切换，否则创建新会话）
  const handleOpenRecentProject = (project) => {
    // 规范化路径（去除末尾斜杠）
    const normalizePath = (p) => p ? p.replace(/\/+$/, '') : '';
    const projectPath = normalizePath(project.path);

    // 检查是否有现有会话在该项目目录下工作
    const existingSession = sessions.find(s => normalizePath(s.workingDir) === projectPath);

    if (existingSession) {
      // 已有会话，直接切换
      console.log(`[App] 项目 ${project.name} 已有会话 ${existingSession.id}，切换过去`);
      attachSession(existingSession.id);
    } else {
      // 检查是否正在创建该项目的会话（防止重复点击）
      if (creatingProjectPaths.has(projectPath)) {
        console.log(`[App] 项目 ${project.name} 正在创建会话中，忽略重复点击`);
        return;
      }

      // 标记为正在创建
      setCreatingProjectPaths(prev => new Set(prev).add(projectPath));

      // 没有现有会话，创建新会话
      const sessionData = {
        name: project.name,
        aiType: project.aiType,
        workingDir: project.path,
        projectName: project.name,
        projectDesc: '',  // 由服务器端从项目文件提取
        resumeCommand: project.resumeCommand
      };
      socket.emit('session:createAndResume', sessionData);
    }
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

  // AI 生成目标
  const handleGenerateGoal = (autoApply = false) => {
    if (!currentSession || generatingGoal) return;

    setGeneratingGoal(true);
    socket.emit('goal:generate', {
      sessionId: currentSession.id
    });

    // 监听生成结果
    const handleGoalGenerated = (data) => {
      if (data.sessionId === currentSession.id) {
        setGeneratingGoal(false);
        if (data.goal) {
          if (autoApply) {
            // 直接应用生成的目标（用于"重新生成"按钮）
            socket.emit('session:update', { id: currentSession.id, goal: data.goal });
          } else {
            // 打开编辑模式让用户确认（用于魔法棒按钮）
            setGoalInput(data.goal);
            setEditingGoal(true);
          }
        }
        socket.off('goal:generated', handleGoalGenerated);
      }
    };

    socket.on('goal:generated', handleGoalGenerated);

    // 超时处理
    setTimeout(() => {
      setGeneratingGoal(false);
      socket.off('goal:generated', handleGoalGenerated);
    }, 30000);
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
    } catch (err) {
      console.error('保存 tunnel URL 失败:', err);
    }
  };

  // 如果需要认证但未登录，显示登录页面
  // 注意：本机访问时 authenticated 会自动为 true
  if (auth.loading) {
    return <div className="loading-screen">加载中...</div>;
  }

  // 远程访问但未设置密码，显示提示页面
  if (auth.requirePasswordSetup) {
    return <LoginPage auth={auth} />;
  }

  if (auth.enabled && !auth.authenticated) {
    return <LoginPage auth={auth} />;
  }

  // 处理文件拖入终端
  const handleTerminalDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  };

  const handleTerminalDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    // 只在离开 terminal-wrapper 时取消高亮
    if (!e.currentTarget.contains(e.relatedTarget)) {
      setIsDragOver(false);
    }
  };

  const handleTerminalDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    if (!currentSession || !socket) return;

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    Array.from(files).forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = reader.result.split(',')[1]; // 去掉 data:xxx;base64, 前缀
        socket.emit('terminal:dropFile', {
          sessionId: currentSession.id,
          fileName: file.name,
          fileData: base64,
        }, (response) => {
          if (response?.error) {
            console.error('[DropFile] 上传失败:', response.error);
          } else {
            console.log('[DropFile] 文件已发送到终端:', response?.filePath);
          }
        });
      };
      reader.readAsDataURL(file);
    });
  };

  return (
    <ToastContainer>
    <div className="app">
      {/* 侧边栏 */}
      <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <button
          className="panel-toggle sidebar-toggle"
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          title={sidebarCollapsed ? t('sidebar.expand') : t('sidebar.collapse')}
        >
          {sidebarCollapsed ? '›' : '‹'}
        </button>
        <div className="sidebar-header">
          <h1
            onClick={() => setCurrentSession(null)}
            style={{ cursor: 'pointer' }}
            title={t('welcome.startHint')}
          >
            {t('app.title')} <span style={{ fontSize: '14px', opacity: 0.7, fontWeight: 'normal' }}>{t('app.subtitle')}</span>
          </h1>
          <button className="btn btn-primary btn-small" onClick={() => setShowCreateModal(true)}>
            {t('sidebar.newSession')}
          </button>
          <button className="btn btn-small" onClick={() => setShowCreateTeamDialog(true)} title="创建 Agent Team" style={{ marginLeft: '4px' }}>
            Team
          </button>
        </div>

        {/* Teams 分组 */}
        {teams.length > 0 && (
          <div className="sidebar-teams-section">
            <div className="sidebar-teams-header">
              <span>Teams</span>
              <button className="create-team-btn" onClick={() => setShowCreateTeamDialog(true)} title="创建团队">+</button>
            </div>
            {teams.filter(t => t.status !== 'completed').map(team => (
              <div
                key={team.id}
                className={`sidebar-team-item ${currentTeam?.id === team.id ? 'active' : ''}`}
                onClick={() => {
                  setCurrentTeam(team);
                  setCurrentSession(null);
                }}
              >
                <span className="team-icon">{team.status === 'active' ? '▶' : '⏸'}</span>
                <span className="team-name">{team.name}</span>
                <span className="team-progress-mini">
                  {team.taskStats?.completed || 0}/{team.taskStats?.total || 0}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="session-list">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`session-item ${currentSession?.id === session.id ? 'active' : ''} ${aiStatusMap[session.id]?.needsAction && !session.autoActionEnabled ? 'needs-action' : ''}`}
              onClick={() => attachSession(session.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setSessionContextMenu({ session, x: e.clientX, y: e.clientY });
              }}
              onMouseEnter={(e) => {
                if (session.projectDesc || session.goal) {
                  const rect = e.currentTarget.getBoundingClientRect();
                  setTooltipPosition({ top: rect.top });
                  setHoveredSession(session);
                }
              }}
              onMouseLeave={() => setHoveredSession(null)}
            >
              {/* 需要操作时显示红色徽章（自动模式开启时不显示，因为会自动处理） */}
              {aiStatusMap[session.id]?.needsAction && !session.autoActionEnabled && (
                <span className="action-badge" title={aiStatusMap[session.id]?.suggestedAction || '需要操作'} />
              )}
              <div className="session-header">
                <div className="session-name">
                  <span className={`session-status ${session.autoActionEnabled ? 'auto' : 'paused'}`} />
                  {session.projectName || session.name}
                  {sessionMemory[session.id]?.memory > 0 && (
                    <span className={`session-memory ${sessionMemory[session.id]?.memory > 500 ? 'high' : ''}`}>
                      {sessionMemory[session.id]?.processCount > 1 && (
                        <span
                          className="process-count clickable"
                          onClick={(e) => {
                            e.stopPropagation();
                            const rect = e.currentTarget.getBoundingClientRect();
                            setProcessDetails({
                              sessionId: session.id,
                              details: null,
                              position: { top: rect.bottom + 5, left: rect.left }
                            });
                            socket.emit('session:processDetails', session.id);
                          }}
                        >
                          {sessionMemory[session.id]?.processCount}
                        </span>
                      )}
                      {sessionMemory[session.id]?.memory}MB
                    </span>
                  )}
                </div>
                <button
                  className="btn-delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (aiSettings.confirmCloseSession) {
                      // 显示确认对话框
                      setCloseSessionConfirm({ show: true, session });
                    } else {
                      // 直接关闭
                      socket.emit('session:close', session.id);
                      if (currentSession?.id === session.id) {
                        setCurrentSession(null);
                      }
                    }
                  }}
                  title={t('sidebar.closeSession')}
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
          {/* 底部按钮行 */}
          <div className="sidebar-footer-row">
            {/* 订阅状态标志 */}
            <span
              className={`subscription-badge ${subscriptionStatus?.valid ? 'pro' : 'free'}`}
              title={subscriptionStatus?.valid
                ? `${subscriptionStatus.info?.plan || 'Pro'} - 剩余 ${subscriptionStatus.remainingDays || 0} 天`
                : '免费版 - 点击升级'}
              onClick={() => {
                setSettingsDefaultTab('subscription');
                setShowSettings(true);
              }}
            >
              {subscriptionStatus?.valid ? 'Pro' : 'Free'}
            </span>
            {/* 二维码折叠按钮 */}
            {tunnelUrl && (
              <button
                className={`btn btn-icon qr-toggle-btn ${qrCodeExpanded ? 'active' : ''}`}
                onClick={() => setQrCodeExpanded(!qrCodeExpanded)}
                title={qrCodeExpanded ? "收起二维码" : "显示远程访问二维码"}
              >
                📱
              </button>
            )}
            {/* 设置按钮 */}
            <button className="btn btn-secondary settings-btn" onClick={() => {
              setSettingsDefaultTab('ai');
              setShowSettings(true);
            }}>
              ⚙️ 设置
            </button>
          </div>

          {/* 可折叠的二维码区域 */}
          {tunnelUrl && qrCodeExpanded && (
            <div className="qr-code-panel">
              <QRCodeDisplay url={tunnelUrl} />
            </div>
          )}
        </div>
      </aside>

      {/* 主内容区 */}
      <main className="main-content">
        {currentTeam ? (
          <TeamView team={currentTeam} socket={socket} />
        ) : currentSession ? (
          <div className="terminal-container">
            <div
              className={`terminal-wrapper${isDragOver ? ' drag-over' : ''}`}
              ref={terminalRef}
              onMouseDown={() => terminalInstance.current?.focus()}
              onDragOver={handleTerminalDragOver}
              onDragLeave={handleTerminalDragLeave}
              onDrop={handleTerminalDrop}
            >
              <span className="terminal-selection-tip">
                按住 Shift 或 Option 键选择文字
              </span>
              {isDragOver && (
                <div className="drop-overlay">
                  <div className="drop-overlay-content">
                    <span style={{ fontSize: '2rem' }}>📎</span>
                    <span>拖放文件到终端</span>
                  </div>
                </div>
              )}
              {/* 自动模式运行状态提示 - 悬浮在终端底部 */}
              {currentSession.autoActionEnabled && (
                <div className="ai-suggestion auto-mode-active">
                  <div className="ai-suggestion-header">
                    <span className="ai-suggestion-title">
                      <span>🤖</span> {t('controls.autoRunning')}
                    </span>
                    <button
                      className="btn btn-secondary btn-small"
                      onClick={() => toggleAutoAction(currentSession.id, false)}
                    >
                      {t('controls.pause')}
                    </button>
                  </div>
                  <div className="ai-reasoning">
                    {t('aiPanel.aiMonitoring')}
                  </div>
                </div>
              )}
            </div>

            {/* 语音输入按钮 */}
            <VoiceInput
              socket={socket}
              sessionId={currentSession?.id}
              enabled={aiSettings.voiceInputEnabled}
              voiceMode={aiSettings.voiceMode || 'confirm'}
            />

            {/* AI 建议卡片 - 仅在开启建议显示、非自动模式下显示，且 AI 状态允许操作 */}
            {suggestion && aiSettings.showSuggestions && !currentSession.autoActionEnabled &&
             aiStatusMap[currentSession.id]?.needsAction !== false &&
             !aiStatusMap[currentSession.id]?.currentState?.includes('等待') &&
             !aiStatusMap[currentSession.id]?.currentState?.includes('运行中') &&
             aiStatusMap[currentSession.id]?.currentState !== '确认界面' && (
              <div className="ai-suggestion">
                <div className="ai-suggestion-header">
                  <span className="ai-suggestion-title">
                    {suggestion.type === 'complete' ? (
                      <><span>✅</span> {t('suggestion.goalCompleted')}</>
                    ) : suggestion.type === 'needInput' ? (
                      <><span>❓</span> {t('common.needInput')}</>
                    ) : (
                      <><span>💡</span> {t('suggestion.aiSuggestion')}</>
                    )}
                  </span>
                </div>

                {suggestion.type === 'complete' ? (
                  <>
                    <div className="ai-reasoning">{suggestion.summary}</div>
                    <div className="ai-actions">
                      <button className="btn btn-secondary" onClick={() => setSuggestion(null)}>
                        {t('common.close')}
                      </button>
                    </div>
                  </>
                ) : suggestion.type === 'needInput' ? (
                  <>
                    <div className="ai-reasoning">{suggestion.question}</div>
                    <div className="ai-actions">
                      <button className="btn btn-secondary" onClick={() => setSuggestion(null)}>
                        {t('common.close')}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    {suggestion.isDangerous && (
                      <div className="danger-warning">
                        ⚠️ {t('suggestion.dangerWarning')}
                      </div>
                    )}

                    <div className="ai-command">$ {suggestion.command}</div>
                    <div className="ai-reasoning">{suggestion.reasoning}</div>

                    <div className="ai-actions">
                      <button className="btn btn-primary" onClick={executeSuggestion}>
                        {t('suggestion.execute')}
                      </button>
                      <button className="btn btn-secondary" onClick={() => setSuggestion(null)}>
                        {t('suggestion.ignore')}
                      </button>
                    </div>
                  </>
                )}
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
                      placeholder={t('goal.placeholder')}
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') setEditingGoal(false);
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveGoal();
                      }}
                    />
                    <div className="goal-edit-actions">
                      <span className="goal-edit-hint">Ctrl/Cmd+Enter {t('common.save')}</span>
                      <button className="btn btn-primary btn-small" onClick={saveGoal}>
                        {t('common.save')}
                      </button>
                      <button className="btn btn-secondary btn-small" onClick={() => setEditingGoal(false)}>
                        {t('common.cancel')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <span className="settings-label goal-display" onClick={startEditGoal}>
                      {t('goal.title')}: {currentSession.goal || t('goal.notSet')}
                    </span>
                    <div className="settings-actions">
                      <button
                        className="btn btn-secondary btn-small btn-icon"
                        onClick={handleGenerateGoal}
                        disabled={generatingGoal}
                        title="AI 生成目标"
                      >
                        {generatingGoal ? (
                          <span className="loading-spinner-small"></span>
                        ) : (
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M15 4V2"/>
                            <path d="M15 16v-2"/>
                            <path d="M8 9h2"/>
                            <path d="M20 9h2"/>
                            <path d="M17.8 11.8 19 13"/>
                            <path d="M15 9h0"/>
                            <path d="M17.8 6.2 19 5"/>
                            <path d="m3 21 9-9"/>
                            <path d="M12.2 6.2 11 5"/>
                          </svg>
                        )}
                      </button>
                      <button className="btn btn-secondary btn-small" onClick={startEditGoal}>
                        {t('common.edit')}
                      </button>
                      <button
                        className="btn btn-secondary btn-small"
                        onClick={() => handleGenerateGoal(true)}
                        disabled={generatingGoal}
                        title={t('goal.regenerateTooltip')}
                      >
                        {generatingGoal ? '...' : t('goal.regenerate')}
                      </button>
                    </div>
                  </>
                )}
              </div>
              {/* 监控策略插件选择 */}
              <div className="settings-row" style={{ marginTop: '12px' }}>
                <span className="settings-label" style={{ marginRight: '8px' }}>监控策略:</span>
                <select
                  value={currentSession.monitorPluginId || 'auto'}
                  onChange={(e) => {
                    const pluginId = e.target.value;
                    socket.emit('session:updateSettings', {
                      sessionId: currentSession.id,
                      settings: { monitorPluginId: pluginId }
                    });
                    // 更新本地状态
                    setCurrentSession(prev => ({ ...prev, monitorPluginId: pluginId }));
                  }}
                  style={{
                    flex: 1,
                    padding: '4px 8px',
                    background: '#2a2a2a',
                    border: '1px solid #444',
                    borderRadius: '4px',
                    color: '#fff',
                    fontSize: '12px'
                  }}
                >
                  <option value="auto">自动检测</option>
                  {monitorPlugins.map(plugin => (
                    <option key={plugin.id} value={plugin.id}>
                      {plugin.name}
                    </option>
                  ))}
                </select>
                {/* 显示自动检测到的插件 */}
                {(currentSession.monitorPluginId === 'auto' || !currentSession.monitorPluginId) &&
                 aiStatusMap[currentSession.id]?.pluginName && (
                  <span style={{
                    marginLeft: '8px',
                    padding: '2px 8px',
                    background: '#10b981',
                    color: '#fff',
                    borderRadius: '4px',
                    fontSize: '11px',
                    whiteSpace: 'nowrap'
                  }}>
                    → {aiStatusMap[currentSession.id].pluginName}
                    {aiStatusMap[currentSession.id].phaseName && (
                      <span style={{ opacity: 0.8 }}> · {aiStatusMap[currentSession.id].phaseName}</span>
                    )}
                  </span>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="empty-state welcome-page">
            {/* 顶部标题区 */}
            <div className="welcome-header">
              <h2>{t('app.welcome')}</h2>
              <p className="welcome-subtitle">{t('app.description')}</p>
              <button
                className="btn btn-primary welcome-start-btn"
                onClick={() => setShowCreateModal(true)}
              >
                + {t('session.createNew')}
              </button>
            </div>

            {/* 三栏内容区 */}
            <div className="welcome-content">
              {/* 左栏：最近项目 */}
              <div className="welcome-column">
                <div className="welcome-card">
                  <h3 className="welcome-card-title">{t('recentProjects.title')}</h3>
                  <RecentProjects
                    socket={socket}
                    onOpenProject={(project) => {
                      handleOpenRecentProject(project);
                    }}
                    onPlayback={(projectPath) => {
                      setPlaybackProjectPath(projectPath);
                    }}
                    compact={true}
                  />
                </div>

                <div className="welcome-card">
                  <h3 className="welcome-card-title">{t('closedSessions.title')}</h3>
                  <ClosedSessionsList
                    socket={socket}
                    onRestore={(session) => {
                      if (session?.id) {
                        attachSession(session.id);
                      }
                    }}
                    compact={true}
                  />
                </div>
              </div>

              {/* 中栏：核心功能 */}
              <div className="welcome-column">
                <div className="welcome-card feature-card">
                  <h3 className="welcome-card-title">{t('welcome.coreFeatures')}</h3>
                  <div className="feature-grid">
                    <div className="feature-item">
                      <div className="feature-icon-box">🤖</div>
                      <div className="feature-content">
                        <strong>{t('welcome.aiMonitoring')}</strong>
                        <p>{t('welcome.aiMonitoringDesc')}</p>
                      </div>
                    </div>
                    <div className="feature-item">
                      <div className="feature-icon-box">⚡</div>
                      <div className="feature-content">
                        <strong>{t('welcome.automation')}</strong>
                        <p>{t('welcome.automationDesc')}</p>
                      </div>
                    </div>
                    <div className="feature-item">
                      <div className="feature-icon-box">📱</div>
                      <div className="feature-content">
                        <strong>{t('welcome.multiSession')}</strong>
                        <p>{t('welcome.multiSessionDesc')}</p>
                      </div>
                    </div>
                    <div className="feature-item">
                      <div className="feature-icon-box">🌐</div>
                      <div className="feature-content">
                        <strong>{t('welcome.remoteAccess')}</strong>
                        <p>{t('welcome.remoteAccessDesc')}</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* 右栏：使用指南 */}
              <div className="welcome-column">
                <div className="welcome-card">
                  <h3 className="welcome-card-title">{t('welcome.usageTips')}</h3>
                  <div className="tips-list">
                    <div className="tip-item">
                      <span className="tip-number">1</span>
                      <div className="tip-content">
                        <strong>{t('welcome.createSession')}</strong>
                        <p>{t('welcome.createSessionDesc')}</p>
                      </div>
                    </div>
                    <div className="tip-item">
                      <span className="tip-number">2</span>
                      <div className="tip-content">
                        <strong>{t('welcome.aiSwitch')}</strong>
                        <p>{t('welcome.aiSwitchDesc')}</p>
                      </div>
                    </div>
                    <div className="tip-item">
                      <span className="tip-number">3</span>
                      <div className="tip-content">
                        <strong>{t('welcome.autoMode')}</strong>
                        <p>{t('welcome.autoModeDesc')}</p>
                      </div>
                    </div>
                    <div className="tip-item">
                      <span className="tip-number">4</span>
                      <div className="tip-content">
                        <strong>{t('welcome.manualConfirm')}</strong>
                        <p>{t('welcome.manualConfirmDesc')}</p>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="welcome-card">
                  <h3 className="welcome-card-title">{t('welcome.shortcuts')}</h3>
                  <div className="shortcuts-list">
                    <div className="shortcut-item">
                      <span className="shortcut-key">{t('welcome.settings')}</span>
                      <span className="shortcut-desc">{t('welcome.settingsDesc')}</span>
                    </div>
                    <div className="shortcut-item">
                      <span className="shortcut-key">{t('welcome.terminalInput')}</span>
                      <span className="shortcut-desc">{t('welcome.terminalInputDesc')}</span>
                    </div>
                    <div className="shortcut-item">
                      <span className="shortcut-key">{t('welcome.sessionSwitch')}</span>
                      <span className="shortcut-desc">{t('welcome.sessionSwitchDesc')}</span>
                    </div>
                    <div className="shortcut-item">
                      <span className="shortcut-key">{t('welcome.statusPanel')}</span>
                      <span className="shortcut-desc">{t('welcome.statusPanelDesc')}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* 底部提示 */}
            <div className="welcome-footer">
              <p>{t('welcome.startHint')}</p>
            </div>
          </div>
        )}
      </main>

      {/* 右侧面板 */}
      {currentTeam && (
        <TeamPanel
          team={currentTeam}
          socket={socket}
          onClose={() => setCurrentTeam(null)}
        />
      )}
      {!currentTeam && currentSession && (
        <aside className={`ai-panel ${aiPanelCollapsed ? 'collapsed' : ''}`}>
          <button
            className="panel-toggle ai-panel-toggle"
            onClick={() => setAiPanelCollapsed(!aiPanelCollapsed)}
            title={aiPanelCollapsed ? t('aiPanel.expand') : t('aiPanel.collapse')}
          >
            {aiPanelCollapsed ? '‹' : '›'}
          </button>
          <div className="ai-panel-header">
            <h3>{t('aiPanel.title')}</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'nowrap', flexShrink: 0 }}>
              {/* 健康状态指示器 */}
              <span
                className={`ai-health-dot ${aiHealthStatus.status} ${aiHealthStatus.networkStatus === 'offline' ? 'offline' : ''}`}
                title={
                  aiHealthStatus.networkStatus === 'offline'
                    ? `${t('aiPanel.networkOffline')}\n${t('aiPanel.consecutiveNetworkErrors')} ${aiHealthStatus.consecutiveNetworkErrors} ${t('aiPanel.times')}\n${t('aiPanel.nextCheck')}: ${new Date(aiHealthStatus.nextRecoveryCheck).toLocaleTimeString()}`
                    : aiHealthStatus.status === 'failed'
                    ? `${t('aiPanel.serviceFailed')}: ${aiHealthStatus.lastError}\n${t('aiPanel.nextRetry')}: ${new Date(aiHealthStatus.nextRecoveryCheck).toLocaleTimeString()}`
                    : aiHealthStatus.status === 'degraded'
                    ? `${t('aiPanel.serviceDegraded')}: ${t('aiPanel.consecutiveErrors')} ${aiHealthStatus.consecutiveErrors} ${t('aiPanel.times')}`
                    : t('aiPanel.serviceNormal')
                }
              />
              <span className={`ai-status-indicator ${aiStatusLoading[currentSession.id] ? 'loading' : ''}`}>
                {!currentSession.aiEnabled ? t('aiPanel.disabled') : (aiStatusLoading[currentSession.id] ? t('aiPanel.analyzing') : `${aiStatusCountdown}s`)}
              </span>
              {/* 操作统计 */}
              <span className="ai-stats-wrapper">
                <span className="ai-stats">
                  {(currentSession?.stats?.total || 0)}次 ✓{(currentSession?.stats?.success || 0)} ✗{(currentSession?.stats?.failed || 0)}
                </span>
                <div className="ai-stats-tooltip">
                  <div className="tooltip-title">{t('stats.title')}</div>
                  <div className="tooltip-item">
                    <span className="tooltip-label">{t('stats.totalOps')}:</span>
                    <span className="tooltip-value">{currentSession?.stats?.total || 0}</span>
                  </div>
                  <div className="tooltip-item">
                    <span className="tooltip-label">{t('stats.success')}:</span>
                    <span className="tooltip-value success">
                      {currentSession?.stats?.success || 0} ({(currentSession?.stats?.total || 0) > 0 ? Math.round((currentSession?.stats?.success || 0) / currentSession.stats.total * 100) : 0}%)
                    </span>
                  </div>
                  <div className="tooltip-item">
                    <span className="tooltip-label">{t('stats.failed')}:</span>
                    <span className="tooltip-value failed">
                      {currentSession?.stats?.failed || 0} ({(currentSession?.stats?.total || 0) > 0 ? Math.round((currentSession?.stats?.failed || 0) / currentSession.stats.total * 100) : 0}%)
                    </span>
                  </div>
                  <div className="tooltip-divider"></div>
                  <div className="tooltip-item">
                    <span className="tooltip-label">{t('stats.aiDecision')}:</span>
                    <span className="tooltip-value">
                      {currentSession?.stats?.aiAnalyzed || 0} ({(currentSession?.stats?.total || 0) > 0 ? Math.round((currentSession?.stats?.aiAnalyzed || 0) / currentSession.stats.total * 100) : 0}%)
                    </span>
                  </div>
                  <div className="tooltip-item">
                    <span className="tooltip-label">{t('stats.programDecision')}:</span>
                    <span className="tooltip-value">
                      {currentSession?.stats?.preAnalyzed || 0} ({(currentSession?.stats?.total || 0) > 0 ? Math.round((currentSession?.stats?.preAnalyzed || 0) / currentSession.stats.total * 100) : 0}%)
                    </span>
                  </div>
                  <div className="tooltip-divider"></div>
                  <div className="tooltip-item">
                    <span className="tooltip-label">{t('stats.sessionDuration')}:</span>
                    <span className="tooltip-value">
                      {currentSession?.createdAt ? (() => {
                        const minutes = Math.floor((Date.now() - new Date(currentSession.createdAt).getTime()) / 60000);
                        if (minutes < 60) return `${minutes}${t('stats.minutes')}`;
                        const hours = Math.floor(minutes / 60);
                        const remainMinutes = minutes % 60;
                        if (hours < 24) return `${hours}${t('stats.hours')}${remainMinutes}${t('stats.minutes')}`;
                        const days = Math.floor(hours / 24);
                        const remainHours = hours % 24;
                        return `${days}${t('stats.days')}${remainHours}${t('stats.hours')}`;
                      })() : t('common.unknown')}
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
                   currentSession.aiType === 'gemini' ? 'Gemini API' :
                   currentSession.aiType === 'droid' ? 'Droid' : 'AI API'}
                </h4>
                {/* Droid 使用官方账号，不显示供应商切换按钮 */}
                {currentSession.aiType !== 'droid' && (
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
                  title={t('aiPanel.switchProvider')}
                >
                  ▼
                </button>
                )}
              </div>

              {(() => {
                // Droid 使用官方账号，特殊处理
                if (currentSession.aiType === 'droid') {
                  return (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <p style={{ fontWeight: 500, color: 'hsl(280 70% 55%)', margin: 0 }}>
                        Factory.ai 官方
                      </p>
                      <span style={{
                        fontSize: '9px',
                        padding: '1px 4px',
                        borderRadius: '3px',
                        background: 'hsl(280 70% 45% / 0.2)',
                        color: 'hsl(280 70% 65%)'
                      }}>
                        OAuth
                      </span>
                    </div>
                  );
                }

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
                        {provider?.name || t('common.notConfigured')}
                      </p>
                      {provider?.configSource && (
                        <span style={{
                          fontSize: '9px',
                          padding: '1px 4px',
                          borderRadius: '3px',
                          background: isLocalConfig ? 'hsl(142 70% 45% / 0.2)' : 'hsl(220 14% 40% / 0.3)',
                          color: isLocalConfig ? 'hsl(142 70% 55%)' : 'hsl(220 14% 70%)'
                        }}>
                          {isLocalConfig ? t('aiPanel.local') : t('aiPanel.global')}
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
                          title={t('aiPanel.deleteLocalConfig')}
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
                            title={t('aiPanel.restoreGlobalConfig')}
                          >
                            {t('aiPanel.global')}
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
                        title={t('aiPanel.syncToLocal')}
                      >
                        {t('aiPanel.local')}
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
                {/* 监控策略插件信息 - 紧凑的状态标签 */}
                {aiStatusMap[currentSession.id].pluginName && (
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '8px 12px',
                    background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.15) 0%, rgba(59, 130, 246, 0.1) 100%)',
                    borderRadius: '8px',
                    border: '1px solid rgba(16, 185, 129, 0.3)',
                    marginBottom: '12px'
                  }}>
                    <span style={{ color: '#10b981', fontSize: '12px', fontWeight: 500 }}>监控策略</span>
                    <span style={{
                      background: '#10b981',
                      color: '#fff',
                      padding: '3px 10px',
                      borderRadius: '12px',
                      fontSize: '11px',
                      fontWeight: 600
                    }}>
                      {aiStatusMap[currentSession.id].pluginName}
                    </span>
                    {aiStatusMap[currentSession.id].phaseName && (
                      <span style={{
                        background: '#3b82f6',
                        color: '#fff',
                        padding: '3px 10px',
                        borderRadius: '12px',
                        fontSize: '11px',
                        fontWeight: 500
                      }}>
                        {aiStatusMap[currentSession.id].phaseName}
                      </span>
                    )}
                  </div>
                )}
                <div className="ai-status-section">
                  <h4>{t('aiPanel.currentState')}</h4>
                  <p>{aiStatusMap[currentSession.id].currentState || t('aiPanel.waitingAnalysis')}</p>
                </div>
                <div className="ai-status-section">
                  <h4>{t('aiPanel.workingDir')}</h4>
                  <p className="mono">{currentSession.workingDir || aiStatusMap[currentSession.id].workingDir || t('common.unknown')}</p>
                </div>
                <div className="ai-status-section">
                  <h4>{t('aiPanel.recentAction')}</h4>
                  <p>{aiStatusMap[currentSession.id].recentAction || t('common.none')}</p>
                </div>
                {/* 需要操作提示 */}
                {aiStatusMap[currentSession.id].needsAction && (
                  <div className="ai-status-section action-needed">
                    <h4>{t('aiPanel.needAction')}</h4>
                    <p className="action-type">{t('aiPanel.actionType')}: {aiStatusMap[currentSession.id].actionType}</p>
                    <p className="suggested-action">
                      {t('aiPanel.suggestedAction')}: <code>{aiStatusMap[currentSession.id].suggestedAction}</code>
                    </p>
                    {aiStatusMap[currentSession.id].actionReason && (
                      <p className="action-reason">{aiStatusMap[currentSession.id].actionReason}</p>
                    )}
                    {/* 自动操作状态提示 */}
                    {currentSession.autoActionEnabled && (
                      <div className="auto-action-hint">
                        {t('aiPanel.autoActionEnabled')}
                      </div>
                    )}
                  </div>
                )}
                {aiStatusMap[currentSession.id].suggestion && (
                  <div className="ai-status-section suggestion">
                    <h4>{t('suggestion.suggestion')}</h4>
                    <p>{aiStatusMap[currentSession.id].suggestion}</p>
                  </div>
                )}
                {aiStatusMap[currentSession.id].updatedAt && (
                  <div className="ai-status-time">
                    {t('common.updateAt')}: {new Date(aiStatusMap[currentSession.id].updatedAt).toLocaleTimeString()}
                  </div>
                )}
              </>
            ) : (
              <div className="ai-status-empty">
                {aiStatusLoading[currentSession.id] ? t('aiPanel.analyzing') : t('aiPanel.waitingAiAnalysis')}
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
                  <span style={{ color: '#aaa' }}>{t('aiPanel.monitoringProvider')}: </span>
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
                  <span style={{ color: '#aaa' }}>{t('aiPanel.model')}: </span>
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
              {currentSession.autoActionEnabled ? t('controls.autoOn') : t('controls.autoOff')}
            </button>
            <button
              className="btn btn-secondary btn-small"
              onClick={() => setShowScheduleManager(true)}
              title={t('schedule.title')}
            >
              📅 {t('schedule.manage')}
            </button>
            <button
              className="btn btn-secondary btn-small"
              onClick={() => socket.emit('ai:requestStatus', { sessionId: currentSession.id })}
              disabled={aiStatusLoading[currentSession.id]}
            >
              {t('controls.analyzeNow')}
            </button>
            <button
              className="btn btn-secondary btn-small"
              onClick={() => setShowDebugPanel(!showDebugPanel)}
            >
              {showDebugPanel ? t('controls.hideDebug') : t('controls.showLog')}
            </button>
            <button
              className="btn btn-secondary btn-small"
              onClick={() => setShowHistory(true)}
            >
              {t('common.history')}
            </button>
            {!currentSession.teamId && (
              <button
                className="btn btn-secondary btn-small"
                onClick={() => setShowStartTeamDialog(true)}
                title="从当前会话启动团队模式"
              >
                Team
              </button>
            )}
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

      {/* 会话右键菜单 */}
      {sessionContextMenu && (
        <div
          className="context-menu-overlay"
          onClick={() => setSessionContextMenu(null)}
          onContextMenu={(e) => { e.preventDefault(); setSessionContextMenu(null); }}
        >
          <div
            className="context-menu"
            style={{ top: sessionContextMenu.y, left: sessionContextMenu.x }}
            onClick={(e) => e.stopPropagation()}
          >
            {!sessionContextMenu.session.teamId && (
              <div
                className="context-menu-item"
                onClick={() => {
                  setShowStartTeamDialog(true);
                  // 先 attach 到该会话，确保 currentSession 正确
                  attachSession(sessionContextMenu.session.id);
                  setSessionContextMenu(null);
                }}
              >
                启动 Team 模式
              </div>
            )}
            {sessionContextMenu.session.teamId && (
              <div className="context-menu-item disabled">
                已在团队中
              </div>
            )}
            <div
              className="context-menu-item"
              onClick={() => {
                toggleAutoAction(sessionContextMenu.session.id, !sessionContextMenu.session.autoActionEnabled);
                setSessionContextMenu(null);
              }}
            >
              {sessionContextMenu.session.autoActionEnabled ? '关闭自动操作' : '开启自动操作'}
            </div>
            <div className="context-menu-separator" />
            <div
              className="context-menu-item danger"
              onClick={() => {
                socket.emit('session:close', sessionContextMenu.session.id);
                if (currentSession?.id === sessionContextMenu.session.id) {
                  setCurrentSession(null);
                }
                setSessionContextMenu(null);
              }}
            >
              关闭会话
            </div>
          </div>
        </div>
      )}

      {/* 创建团队对话框 */}
      {showCreateTeamDialog && (
        <CreateTeamDialog
          onClose={() => setShowCreateTeamDialog(false)}
          onCreate={(data) => {
            socket.emit('team:create', data, (response) => {
              if (response?.team) {
                setCurrentSession(null);
                setCurrentTeam(response.team);
                toast.success('团队创建成功');
              } else if (response?.error) {
                toast.error('创建团队失败: ' + response.error);
              }
            });
            setShowCreateTeamDialog(false);
          }}
        />
      )}

      {/* 从现有会话启动团队 */}
      {showStartTeamDialog && currentSession && (
        <StartTeamFromSessionDialog
          session={currentSession}
          onClose={() => setShowStartTeamDialog(false)}
          onCreate={(data) => {
            socket.emit('team:createFromSession', data, (response) => {
              if (response?.team) {
                setCurrentSession(null);
                setCurrentTeam(response.team);
                toast.success('团队创建成功');
              } else if (response?.error) {
                toast.error('从会话创建团队失败: ' + response.error);
              }
            });
            setShowStartTeamDialog(false);
          }}
        />
      )}

      {/* 终端回放面板 */}
      {(showHistory && currentSession) && (
        <TerminalPlayback
          sessionId={currentSession.id}
          onClose={() => setShowHistory(false)}
        />
      )}
      {/* 存储管理的回放面板 */}
      {playbackSessionId && (
        <TerminalPlayback
          sessionId={playbackSessionId}
          onClose={() => setPlaybackSessionId(null)}
        />
      )}
      {/* 项目级别的回放面板 */}
      {playbackProjectPath && (
        <TerminalPlayback
          projectPath={playbackProjectPath}
          onClose={() => setPlaybackProjectPath(null)}
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
          defaultTab={settingsDefaultTab}
          onPlayback={(sessionId) => {
            setShowSettings(false);
            setPlaybackSessionId(sessionId);
          }}
        />
      )}

      {/* 预约管理器 */}
      {showScheduleManager && currentSession && (
        <ScheduleManager
          socket={socket}
          sessionId={currentSession.id}
          projectPath={currentSession.workingDir}
          onClose={() => setShowScheduleManager(false)}
        />
      )}

      {/* 关闭会话确认对话框 */}
      {closeSessionConfirm.show && closeSessionConfirm.session && (
        <div className="modal-overlay" onClick={() => setCloseSessionConfirm({ show: false, session: null })}>
          <div className="modal confirm-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '400px' }}>
            <h2 style={{ marginBottom: '16px', fontSize: '18px' }}>{t('interface.confirmCloseTitle')}</h2>
            <p style={{ marginBottom: '24px', color: 'var(--text-secondary)' }}>
              {t('interface.confirmCloseMessage', { name: closeSessionConfirm.session.projectName || closeSessionConfirm.session.name })}
            </p>
            <div className="modal-actions" style={{ justifyContent: 'flex-end', gap: '12px' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setCloseSessionConfirm({ show: false, session: null })}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  const session = closeSessionConfirm.session;
                  socket.emit('session:close', session.id);
                  if (currentSession?.id === session.id) {
                    setCurrentSession(null);
                  }
                  setCloseSessionConfirm({ show: false, session: null });
                }}
                style={{ background: '#dc2626', borderColor: '#dc2626' }}
              >
                {t('common.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 全局会话悬停提示 - 使用 fixed 定位避免被遮挡 */}
      {hoveredSession && (
        <div
          className="session-tooltip visible"
          style={{ top: tooltipPosition.top }}
        >
          {hoveredSession.projectDesc || hoveredSession.goal}
        </div>
      )}

      {/* 进程详情弹窗 */}
      {processDetails && (
        <div
          className="process-details-popup"
          style={{
            top: processDetails.position?.top || 100,
            left: Math.min(processDetails.position?.left || 100, window.innerWidth - 320)
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="popup-header">
            <span className="popup-title">进程详情</span>
            <button className="popup-close" onClick={() => setProcessDetails(null)}>×</button>
          </div>
          {!processDetails.details ? (
            <div className="loading">加载中...</div>
          ) : processDetails.details.length === 0 ? (
            <div className="loading">无进程信息</div>
          ) : (
            processDetails.details.map((proc, idx) => (
              <div key={idx} className="process-item">
                <span className="pid">{proc.pid}</span>
                <span className="cpu">{proc.cpu}%</span>
                <span className="memory">{proc.memory}MB</span>
                <span className="command" title={proc.command}>{proc.command}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
    </ToastContainer>
  );
}

// QR Code Display 组件（嵌入式）
function QRCodeDisplay({ url }) {
  const { t } = useTranslation();
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
        {copied ? t('common.copied') : new URL(url).hostname}
      </div>
    </div>
  );
}

// 订阅状态缓存（模块级变量，避免重复请求）
let subscriptionStatusCache = null;
let subscriptionStatusCacheTime = 0;
const SUBSCRIPTION_CACHE_TTL = 60000; // 缓存 60 秒

// 订阅面板组件（嵌入设置页面）
function SubscriptionPanel() {
  const [status, setStatus] = useState(subscriptionStatusCache);
  const [loading, setLoading] = useState(!subscriptionStatusCache);
  const [activating, setActivating] = useState(false);
  const [activationCode, setActivationCode] = useState('');
  const [message, setMessage] = useState(null);

  // 激活方式切换
  const [activationMode, setActivationMode] = useState('login'); // 'login' | 'code'

  // 邮箱+密码登录
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    // 如果缓存有效，直接使用
    const now = Date.now();
    if (subscriptionStatusCache && (now - subscriptionStatusCacheTime) < SUBSCRIPTION_CACHE_TTL) {
      setStatus(subscriptionStatusCache);
      setLoading(false);
      return;
    }
    loadStatus();
  }, []);

  const loadStatus = async (forceRefresh = false) => {
    // 如果不是强制刷新且缓存有效，直接返回
    const now = Date.now();
    if (!forceRefresh && subscriptionStatusCache && (now - subscriptionStatusCacheTime) < SUBSCRIPTION_CACHE_TTL) {
      setStatus(subscriptionStatusCache);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      const res = await fetch('/api/subscription/status');
      const data = await res.json();
      // 更新缓存
      subscriptionStatusCache = data;
      subscriptionStatusCacheTime = Date.now();
      setStatus(data);
    } catch (err) {
      setMessage({ type: 'error', text: '加载订阅状态失败' });
    } finally {
      setLoading(false);
    }
  };

  const handleActivate = async () => {
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
        await loadStatus(true); // 强制刷新
      } else {
        setMessage({ type: 'error', text: result.message || '激活失败' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: '网络错误，请稍后重试' });
    } finally {
      setActivating(false);
    }
  };

  // 邮箱+密码激活
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
        await loadStatus(true);
      } else {
        setMessage({ type: 'error', text: result.message || '激活失败' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: '网络错误，请稍后重试' });
    } finally {
      setActivating(false);
    }
  };

  const handleVerify = async () => {
    try {
      setMessage(null);
      const res = await fetch('/api/subscription/verify', { method: 'POST' });
      const result = await res.json();

      if (result.success) {
        setMessage({ type: 'success', text: result.message || '验证成功' });
        await loadStatus(true); // 强制刷新
      } else {
        setMessage({ type: 'error', text: result.message || '验证失败' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: '网络错误' });
    }
  };

  const handleDeactivate = async () => {
    if (!confirm('确定要停用许可证吗？')) return;

    try {
      const res = await fetch('/api/subscription/deactivate', { method: 'POST' });
      const result = await res.json();

      if (result.success) {
        setMessage({ type: 'success', text: '许可证已停用' });
        await loadStatus(true); // 强制刷新
      } else {
        setMessage({ type: 'error', text: result.message || '停用失败' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: '网络错误' });
    }
  };

  const openSubscriptionPage = () => {
    if (status?.subscriptionUrl) {
      window.open(status.subscriptionUrl, '_blank');
    }
  };

  const copyMachineId = () => {
    if (status?.machineId) {
      navigator.clipboard.writeText(status.machineId);
      setMessage({ type: 'success', text: '机器 ID 已复制' });
      setTimeout(() => setMessage(null), 2000);
    }
  };

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '40px', color: '#888' }}>加载中...</div>;
  }

  return (
    <div style={{ padding: '0 4px' }}>
      {/* 消息提示 */}
      {message && (
        <div style={{
          marginBottom: '16px',
          padding: '12px',
          borderRadius: '6px',
          background: message.type === 'success' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)',
          color: message.type === 'success' ? '#10b981' : '#ef4444'
        }}>
          {message.text}
        </div>
      )}

      {/* 订阅状态 */}
      <div style={{ marginBottom: '20px', padding: '16px', background: 'rgba(255,255,255,0.05)', borderRadius: '8px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <span style={{ color: '#888' }}>订阅状态</span>
          <span style={{
            padding: '4px 12px',
            borderRadius: '4px',
            fontSize: '13px',
            background: status?.valid ? 'rgba(16, 185, 129, 0.2)' : 'rgba(100, 100, 100, 0.3)',
            color: status?.valid ? '#10b981' : '#888'
          }}>
            {status?.valid ? '已激活' : '未激活'}
          </span>
        </div>

        {status?.valid && status?.info && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
              <span style={{ color: '#888' }}>订阅类型</span>
              <span style={{ color: '#fff' }}>{status.info.plan}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
              <span style={{ color: '#888' }}>到期时间</span>
              <span style={{ color: '#fff' }}>{new Date(status.info.expiresAt).toLocaleDateString()}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: '#888' }}>剩余天数</span>
              <span style={{ color: status.remainingDays <= 7 ? '#f59e0b' : '#fff' }}>
                {status.remainingDays} 天
              </span>
            </div>
          </>
        )}
      </div>

      {/* 机器 ID */}
      <div style={{ marginBottom: '20px', padding: '16px', background: 'rgba(255,255,255,0.05)', borderRadius: '8px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <span style={{ color: '#888' }}>机器 ID</span>
          <button
            onClick={copyMachineId}
            style={{ background: 'none', border: 'none', color: '#3b82f6', cursor: 'pointer', fontSize: '13px' }}
          >
            复制
          </button>
        </div>
        <code style={{ fontSize: '11px', color: '#aaa', wordBreak: 'break-all', display: 'block' }}>
          {status?.machineId}
        </code>
        <small style={{ color: '#666', fontSize: '11px', marginTop: '8px', display: 'block' }}>
          购买订阅时需要提供此 ID
        </small>
      </div>

      {/* 激活区域 */}
      {!status?.valid && (
        <div style={{ marginBottom: '20px', padding: '16px', background: 'rgba(255,255,255,0.05)', borderRadius: '8px' }}>
          <h3 style={{ fontSize: '14px', color: '#fff', marginBottom: '12px' }}>激活许可证</h3>

          {/* 激活方式切换 */}
          <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
            <button
              onClick={() => setActivationMode('login')}
              style={{
                flex: 1,
                padding: '8px',
                background: activationMode === 'login' ? '#3b82f6' : 'transparent',
                border: '1px solid #4b5563',
                borderRadius: '6px',
                color: activationMode === 'login' ? '#fff' : '#888',
                cursor: 'pointer',
                fontSize: '13px'
              }}
            >
              邮箱登录
            </button>
            <button
              onClick={() => setActivationMode('code')}
              style={{
                flex: 1,
                padding: '8px',
                background: activationMode === 'code' ? '#3b82f6' : 'transparent',
                border: '1px solid #4b5563',
                borderRadius: '6px',
                color: activationMode === 'code' ? '#fff' : '#888',
                cursor: 'pointer',
                fontSize: '13px'
              }}
            >
              激活码
            </button>
          </div>

          {/* 邮箱登录激活 */}
          {activationMode === 'login' && (
            <div style={{ marginBottom: '12px' }}>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="邮箱"
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  marginBottom: '8px',
                  background: '#374151',
                  border: '1px solid #4b5563',
                  borderRadius: '6px',
                  color: '#fff',
                  fontSize: '14px',
                  boxSizing: 'border-box'
                }}
              />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="密码"
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  marginBottom: '12px',
                  background: '#374151',
                  border: '1px solid #4b5563',
                  borderRadius: '6px',
                  color: '#fff',
                  fontSize: '14px',
                  boxSizing: 'border-box'
                }}
              />
              <button
                onClick={handleActivateByLogin}
                disabled={activating}
                style={{
                  width: '100%',
                  padding: '12px',
                  background: activating ? '#4b5563' : '#3b82f6',
                  border: 'none',
                  borderRadius: '6px',
                  color: '#fff',
                  cursor: activating ? 'not-allowed' : 'pointer',
                  fontSize: '14px'
                }}
              >
                {activating ? '激活中...' : '登录激活'}
              </button>
              <p style={{ fontSize: '12px', color: '#888', marginTop: '8px', textAlign: 'center' }}>
                使用购买订阅时注册的邮箱和密码
              </p>
            </div>
          )}

          {/* 激活码激活 */}
          {activationMode === 'code' && (
            <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
              <input
                type="text"
                value={activationCode}
                onChange={(e) => setActivationCode(e.target.value)}
                placeholder="输入激活码或许可证密钥"
                style={{
                  flex: 1,
                  padding: '10px 12px',
                  background: '#374151',
                  border: '1px solid #4b5563',
                  borderRadius: '6px',
                  color: '#fff',
                  fontSize: '14px'
                }}
              />
              <button
                onClick={handleActivate}
                disabled={activating}
                style={{
                  padding: '10px 20px',
                  background: activating ? '#4b5563' : '#3b82f6',
                  border: 'none',
                  borderRadius: '6px',
                  color: '#fff',
                  cursor: activating ? 'not-allowed' : 'pointer'
                }}
              >
                {activating ? '激活中...' : '激活'}
              </button>
            </div>
          )}

          <button
            onClick={openSubscriptionPage}
            style={{
              width: '100%',
              padding: '12px',
              background: '#10b981',
              border: 'none',
              borderRadius: '6px',
              color: '#fff',
              cursor: 'pointer',
              fontSize: '14px'
            }}
          >
            购买订阅
          </button>
        </div>
      )}

      {/* 已激活的操作 */}
      {status?.valid && (
        <div style={{ display: 'flex', gap: '12px' }}>
          <button
            onClick={handleVerify}
            style={{
              flex: 1,
              padding: '12px',
              background: '#3b82f6',
              border: 'none',
              borderRadius: '6px',
              color: '#fff',
              cursor: 'pointer'
            }}
          >
            在线验证
          </button>
          <button
            onClick={handleDeactivate}
            style={{
              padding: '12px 20px',
              background: '#ef4444',
              border: 'none',
              borderRadius: '6px',
              color: '#fff',
              cursor: 'pointer'
            }}
          >
            停用
          </button>
        </div>
      )}

      {/* 缓存状态 */}
      {status?.lastVerifyTime && (
        <div style={{ marginTop: '16px', textAlign: 'center', fontSize: '12px', color: '#666' }}>
          上次验证: {new Date(status.lastVerifyTime).toLocaleString()}
          {status.cacheValid && ' (缓存有效)'}
        </div>
      )}
    </div>
  );
}

function SettingsModal({ settings, onChange, onSave, onClose, auth, tunnelUrl, onTunnelUrlChange, socket, defaultTab = 'ai', onPlayback }) {
  const { t, language, setLanguage: changeLanguage } = useTranslation();
  const [activeTab, setActiveTab] = useState(defaultTab);
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
  // 测试模型选择状态
  const [testModel, setTestModel] = useState('');

  // 预设模型列表
  const MODEL_OPTIONS = {
    claude: [
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (推荐)' },
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6 (最新旗舰)' },
      { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5' },
      { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5 (快速)' },
      { id: 'claude-opus-4-1-20250805', name: 'Claude Opus 4.1' },
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4.0' },
    ],
    codex: [
      { id: 'gpt-5.2', name: 'GPT-5.2 (最新前沿)' },
      { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex (推荐)' },
      { id: 'gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max (深度推理)' },
      { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini (快速)' },
      { id: 'gpt-5-codex', name: 'GPT-5 Codex' },
    ],
    gemini: [
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro (默认)' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
      { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite' },
      { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro (预览版)' },
      { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash (预览版)' },
    ]
  };

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
    // 获取当前供应商的默认模型
    const provider = providers.find(p => p.appType === appType && p.id === providerId);
    const defaultProviderModel = provider?.model || '';
    // 优先使用已保存的模型配置，其次是临时选择的模型，最后是供应商默认模型
    // 这样确保测试和监控使用相同的模型
    const savedModel = appType === 'claude' ? settings?.claude?.model :
                       appType === 'codex' ? settings?.codex?.model : '';
    const modelToTest = testModel || savedModel || defaultProviderModel;
    setProviderTestStatus('testing');
    setProviderTestMessage(t('common.testing'));
    socket.emit('settings:testProvider', { providerId, appType, model: modelToTest });
  };

  // 选择供应商时自动填充配置
  const handleProviderSelect = async (value) => {
    setSelectedProviderId(value);
    // 重置测试状态和测试模型
    setProviderTestStatus(null);
    setProviderTestMessage('');
    setTestModel(''); // 重置测试模型，让它使用已保存的模型

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
    const providerModel = provider.model || '';

    // 检查是否是同一个供应商（保留用户之前选择的模型）
    const isSameProvider = settings?._providerId === value;

    // 根据 apiType 设置对应的配置
    const updates = {
      apiType,
      _providerId: value,
      _providerName: `${provider.name} (${appType})`
    };

    if (apiType === 'openai') {
      // Codex 使用 OpenAI 协议
      // 如果是同一个供应商，保留用户之前选择的模型
      const existingModel = isSameProvider ? settings?.openai?.model : null;
      updates.openai = {
        apiUrl: apiUrl ? `${apiUrl}/v1/chat/completions` : '',
        apiKey,
        model: existingModel || providerModel || 'gpt-4o'
      };
    } else if (apiType === 'claude') {
      // Claude 使用 Anthropic 协议
      // 如果是同一个供应商，保留用户之前选择的模型
      const existingModel = isSameProvider ? settings?.claude?.model : null;
      updates.claude = {
        apiUrl: apiUrl ? `${apiUrl}/v1/messages` : '',
        apiKey,
        model: existingModel || providerModel || defaultModel
      };
    }

    onChange(prev => ({ ...prev, ...updates }));
  };

  // 测试 API 连接
  const testApi = async (type) => {
    setTestStatus(prev => ({ ...prev, [type]: 'testing' }));
    setTestMessage(prev => ({ ...prev, [type]: t('common.testing') }));

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
    // 如果密码已启用，且用户留空密码字段，直接返回（留空表示不修改）
    if (auth.enabled && !authPassword && !authConfirm) {
      setAuthMessage(t('auth.passwordUnchanged'));
      return;
    }

    // 首次启用密码或更新密码时，必须填写密码
    if (!authPassword) {
      setAuthMessage(t('auth.passwordRequired'));
      return;
    }

    if (authPassword !== authConfirm) {
      setAuthMessage(t('auth.passwordMismatch'));
      return;
    }
    if (authPassword.length < 4) {
      setAuthMessage(t('auth.passwordTooShort'));
      return;
    }

    const result = await auth.setupAuth(authUsername, authPassword);
    if (result.success) {
      setAuthMessage(result.message || t('auth.setupSuccess'));
      setAuthPassword('');
      setAuthConfirm('');
    } else {
      setAuthMessage(result.error || t('auth.setupFailed'));
    }
  };

  const handleDisableAuth = async () => {
    const result = await auth.setupAuth(null, null, true);
    if (result.success) {
      setAuthMessage(t('auth.disableSuccess'));
    }
  };

  const handleLogout = async () => {
    await auth.logout();
  };

  return (
    <div className="modal-overlay" onClick={(e) => {
      // 只有点击 overlay 本身时才关闭，点击子元素不关闭
      if (e.target === e.currentTarget) {
        onClose();
      }
    }}>
      <div className={`modal settings-modal ${activeTab === 'api' ? 'api-tab' : ''}`}>
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
          <button
            className={`tab-btn ${activeTab === 'cli-tools' ? 'active' : ''}`}
            onClick={() => setActiveTab('cli-tools')}
          >
            CLI 工具
          </button>
          <button
            className={`tab-btn ${activeTab === 'monitor-plugins' ? 'active' : ''}`}
            onClick={() => setActiveTab('monitor-plugins')}
          >
            监控插件
          </button>
          <button
            className={`tab-btn ${activeTab === 'provider-priority' ? 'active' : ''}`}
            onClick={() => setActiveTab('provider-priority')}
          >
            供应商切换
          </button>
          <button
            className={`tab-btn ${activeTab === 'storage' ? 'active' : ''}`}
            onClick={() => setActiveTab('storage')}
          >
            存储管理
          </button>
          <button
            className={`tab-btn ${activeTab === 'subscription' ? 'active' : ''}`}
            onClick={() => setActiveTab('subscription')}
          >
            订阅
          </button>
          <button
            className={`tab-btn ${activeTab === 'advanced' ? 'active' : ''}`}
            onClick={() => setActiveTab('advanced')}
          >
            高级
          </button>
          <button
            className={`tab-btn ${activeTab === 'about' ? 'active' : ''}`}
            onClick={() => setActiveTab('about')}
          >
            {t('settings.about')}
          </button>
        </div>

        <div className="settings-content">
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

              {/* Cli Only 警告提示 */}
              <div style={{
                background: 'rgba(127, 29, 29, 0.2)',
                border: '1px solid rgba(239, 68, 68, 0.5)',
                borderRadius: '6px',
                padding: '12px',
                marginBottom: '12px',
                marginTop: '8px'
              }}>
                <p style={{
                  color: '#f87171',
                  fontSize: '13px',
                  lineHeight: '1.6',
                  margin: 0
                }}>
                  {t('provider.cliOnlyWarning')}
                </p>
              </div>

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
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ color: '#aaa' }}>模型: </span>
                      <select
                        value={testModel || model}
                        onChange={(e) => {
                          const newModel = e.target.value;
                          setTestModel(newModel);
                          // 同时更新 settings 中的模型配置
                          if (appType === 'claude') {
                            onChange(prev => ({
                              ...prev,
                              claude: { ...prev.claude, model: newModel }
                            }));
                          } else if (appType === 'codex') {
                            onChange(prev => ({
                              ...prev,
                              openai: { ...prev.openai, model: newModel }
                            }));
                          }
                        }}
                        style={{
                          padding: '4px 8px',
                          background: '#2a2a2a',
                          color: '#fff',
                          border: '1px solid #444',
                          borderRadius: '4px',
                          fontSize: '11px',
                          fontFamily: 'monospace',
                          cursor: 'pointer',
                          minWidth: '180px'
                        }}
                      >
                        {/* 当前配置的模型（如果不在预设列表中） */}
                        {model && !MODEL_OPTIONS[appType]?.find(m => m.id === model) && (
                          <option value={model}>{model} (当前)</option>
                        )}
                        {/* 预设模型列表 */}
                        {MODEL_OPTIONS[appType]?.map(m => (
                          <option key={m.id} value={m.id}>
                            {m.name}{m.id === model ? ' (当前)' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {/* 测试按钮和结果 */}
                  <div style={{ marginTop: '12px', display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <button
                      type="button"
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
                      {providerTestStatus === 'testing' ? t('common.testing') : t('common.test')}
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
                        {testStatus.openai === 'testing' ? t('common.testing') : t('common.test')}
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
                        {testStatus.claude === 'testing' ? t('common.testing') : t('common.test')}
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

            {/* AI 建议弹窗开关 */}
            <div className="form-group" style={{ marginTop: '16px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={settings.showSuggestions || false}
                  onChange={(e) => updateField('showSuggestions', e.target.checked)}
                  style={{ width: '16px', height: '16px' }}
                />
                <span>显示 AI 建议弹窗</span>
              </label>
              <small style={{ color: '#888', fontSize: '12px', marginTop: '4px', display: 'block' }}>
                关闭后，AI 分析结果仅在右侧面板显示，不会弹出建议卡片
              </small>
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
                  {auth.enabled ? t('auth.enabled') : t('auth.disabled')}
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
              <label>{auth.enabled ? t('auth.newPassword') : t('auth.setPassword')}</label>
              <input
                type="password"
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
                placeholder={auth.enabled ? t('auth.placeholderOptional') : t('auth.placeholder')}
              />
            </div>
            <div className="form-group">
              <label>{t('auth.confirmPassword')}</label>
              <input
                type="password"
                value={authConfirm}
                onChange={(e) => setAuthConfirm(e.target.value)}
                placeholder={t('auth.confirmPassword')}
              />
            </div>

            {authMessage && <div className="auth-message">{authMessage}</div>}

            <div className="modal-actions" style={{ marginBottom: '16px' }}>
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                {t('common.cancel')}
              </button>
              <button type="button" className="btn btn-primary" onClick={() => {
                if (onTunnelUrlChange) {
                  onTunnelUrlChange(localTunnelUrl);
                }
                toast.success(t('toast.tunnelUrlSaved'));
              }}>
                {t('common.save')} URL
              </button>
            </div>

            <div style={{ borderTop: '1px solid #333', margin: '20px 0' }}></div>

            <div className="modal-actions">
              {auth.enabled && (
                <button type="button" className="btn btn-danger" onClick={handleDisableAuth}>
                  {t('auth.disablePassword')}
                </button>
              )}
              <button type="button" className="btn btn-primary" onClick={handleAuthSetup}>
                {auth.enabled ? t('auth.updatePassword') : t('auth.enablePassword')}
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

            {/* 关闭会话确认开关 */}
            <div className="form-group" style={{ marginTop: '24px' }}>
              <h3 style={{ margin: '0 0 12px 0', fontSize: '16px', color: '#fff' }}>
                {t('interface.confirmCloseSession')}
              </h3>
              <small style={{ color: '#888', fontSize: '12px', display: 'block', marginBottom: '16px' }}>
                {t('interface.confirmCloseSessionHint')}
              </small>
              <label style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                cursor: 'pointer',
                padding: '12px 16px',
                background: '#2a2a2a',
                borderRadius: '8px',
                border: '1px solid #444'
              }}>
                <input
                  type="checkbox"
                  checked={settings.confirmCloseSession !== false}
                  onChange={(e) => {
                    onChange({ ...settings, confirmCloseSession: e.target.checked });
                    onSave();
                  }}
                  style={{
                    width: '18px',
                    height: '18px',
                    cursor: 'pointer'
                  }}
                />
                <span style={{ color: '#fff', fontSize: '14px' }}>
                  {settings.confirmCloseSession !== false ? t('interface.enabled') : t('interface.disabled')}
                </span>
              </label>
            </div>

            <div className="form-group" style={{ marginTop: '24px' }}>
              <h3 style={{ margin: '0 0 12px 0', fontSize: '16px', color: '#fff' }}>
                语音输入
              </h3>
              <small style={{ color: '#888', fontSize: '12px', display: 'block', marginBottom: '16px' }}>
                使用本地 Whisper 模型识别语音并输入到终端（首次使用需下载约 150MB 模型）
              </small>
              <label style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                cursor: 'pointer',
                padding: '12px 16px',
                background: '#2a2a2a',
                borderRadius: '8px',
                border: '1px solid #444'
              }}>
                <input
                  type="checkbox"
                  checked={settings.voiceInputEnabled || false}
                  onChange={(e) => {
                    onChange({ ...settings, voiceInputEnabled: e.target.checked });
                    onSave();
                  }}
                  style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                />
                <span style={{ color: '#fff', fontSize: '14px' }}>
                  {settings.voiceInputEnabled ? '已启用（麦克风按钮显示在终端右下角）' : '已禁用'}
                </span>
              </label>

              {/* 识别后行为 */}
              {settings.voiceInputEnabled && (
                <div style={{ marginTop: '12px' }}>
                  <div style={{ color: '#aaa', fontSize: '12px', marginBottom: '8px' }}>识别后行为</div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    {[
                      { value: 'confirm', label: '确认后发送', desc: '弹窗确认，可 AI 修正' },
                      { value: 'auto', label: '直接发送', desc: '识别完立即输入终端' },
                    ].map(opt => (
                      <label key={opt.value} style={{
                        flex: 1, display: 'flex', flexDirection: 'column', gap: '4px',
                        cursor: 'pointer', padding: '10px 12px', borderRadius: '8px',
                        background: (settings.voiceMode || 'confirm') === opt.value ? 'hsl(var(--primary) / 0.15)' : '#2a2a2a',
                        border: `1px solid ${(settings.voiceMode || 'confirm') === opt.value ? 'hsl(var(--primary))' : '#444'}`,
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <input
                            type="radio"
                            name="voiceMode"
                            value={opt.value}
                            checked={(settings.voiceMode || 'confirm') === opt.value}
                            onChange={() => { onChange({ ...settings, voiceMode: opt.value }); onSave(); }}
                          />
                          <span style={{ color: '#fff', fontSize: '13px', fontWeight: 500 }}>{opt.label}</span>
                        </div>
                        <span style={{ color: '#888', fontSize: '11px', paddingLeft: '20px' }}>{opt.desc}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                {t('common.close')}
              </button>
            </div>
          </div>
        )}

        {activeTab === 'cli-tools' && (
          <CliToolsManager />
        )}

        {activeTab === 'monitor-plugins' && (
          <MonitorPluginsManager />
        )}

        {activeTab === 'provider-priority' && (
          <ProviderPriority />
        )}

        {activeTab === 'storage' && (
          <StorageManager socket={socket} onPlayback={onPlayback} />
        )}

        {activeTab === 'subscription' && (
          <SubscriptionPanel />
        )}

        {activeTab === 'advanced' && (
          <AdvancedSettings embedded={true} />
        )}

        {activeTab === 'about' && (
          <AboutPage socket={socket} onClose={onClose} />
        )}
        </div>
      </div>
    </div>
  );
}

// 关于页面组件
function AboutPage({ socket, onClose }) {
  const { t } = useTranslation();
  const [updateStatus, setUpdateStatus] = useState('');
  const [checking, setChecking] = useState(false);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [currentVersion, setCurrentVersion] = useState('');
  const [systemInfo, setSystemInfo] = useState(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);

  useEffect(() => {
    // 获取当前版本
    fetch('/api/update/version')
      .then(res => res.json())
      .then(data => setCurrentVersion(data.version || '1.0.0'))
      .catch(() => setCurrentVersion('1.0.0'));

    // 获取系统信息
    if (socket) {
      socket.emit('system:info');
      socket.on('system:info', (info) => {
        setSystemInfo(info);
      });

      return () => {
        socket.off('system:info');
      };
    }
  }, [socket]);

  const checkUpdate = async () => {
    setChecking(true);
    setUpdateStatus(t('about.checking'));

    try {
      const response = await fetch('/api/update/check?force=true');
      const data = await response.json();

      if (data.error) {
        setUpdateStatus('检查更新失败: ' + data.error);
      } else if (data.hasUpdate) {
        setUpdateInfo(data);
        setUpdateStatus(`发现新版本: v${data.latestVersion}`);
      } else {
        setUpdateInfo(null);
        setUpdateStatus(t('about.upToDate'));
      }
    } catch (error) {
      setUpdateStatus('检查更新失败: ' + error.message);
    } finally {
      setChecking(false);
    }
  };

  const downloadUpdate = async () => {
    if (!updateInfo) return;

    setDownloading(true);
    setDownloadProgress(0);

    try {
      // 获取下载链接
      const response = await fetch(`/api/update/download?platform=${navigator.platform.includes('Mac') ? 'darwin' : navigator.platform.includes('Win') ? 'win32' : 'linux'}&arch=${navigator.userAgent.includes('arm64') ? 'arm64' : 'x64'}`);
      const data = await response.json();

      if (data.url) {
        // 打开下载链接
        window.open(data.url, '_blank');
        setUpdateStatus('已打开下载页面');
      } else if (updateInfo.downloadUrl) {
        window.open(updateInfo.downloadUrl, '_blank');
        setUpdateStatus('已打开下载页面');
      } else {
        setUpdateStatus('未找到下载链接');
      }
    } catch (error) {
      setUpdateStatus('获取下载链接失败');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="about-page" style={{ padding: '20px' }}>
      {/* 应用信息 */}
      <div style={{ textAlign: 'center', marginBottom: '30px' }}>
        <h2 style={{ fontSize: '24px', color: '#4a9eff', marginBottom: '8px' }}>
          {t('about.appName')}
        </h2>
        <p style={{ color: '#888', marginBottom: '8px' }}>
          {t('about.description')}
        </p>
        <p style={{ color: '#666', fontSize: '14px' }}>
          {t('about.version')}: v{currentVersion}
        </p>
      </div>

      {/* 检查更新 */}
      <div style={{ marginBottom: '30px', textAlign: 'center' }}>
        <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
          <button
            onClick={checkUpdate}
            disabled={checking || downloading}
            style={{
              padding: '10px 24px',
              background: '#4a9eff',
              border: 'none',
              borderRadius: '6px',
              color: '#fff',
              fontSize: '14px',
              cursor: (checking || downloading) ? 'not-allowed' : 'pointer',
              opacity: (checking || downloading) ? 0.6 : 1
            }}
          >
            {checking ? t('about.checking') : t('about.checkUpdate')}
          </button>
          {updateInfo && updateInfo.hasUpdate && (
            <button
              onClick={downloadUpdate}
              disabled={downloading}
              style={{
                padding: '10px 24px',
                background: '#22c55e',
                border: 'none',
                borderRadius: '6px',
                color: '#fff',
                fontSize: '14px',
                cursor: downloading ? 'not-allowed' : 'pointer',
                opacity: downloading ? 0.6 : 1
              }}
            >
              {downloading ? '下载中...' : `下载 v${updateInfo.latestVersion}`}
            </button>
          )}
        </div>
        {updateStatus && (
          <p style={{ marginTop: '12px', color: updateInfo?.hasUpdate ? '#22c55e' : '#4a9eff', fontSize: '14px' }}>
            {updateStatus}
          </p>
        )}
        {updateInfo && updateInfo.notes && (
          <div style={{ marginTop: '16px', padding: '12px', background: '#2a2a2a', borderRadius: '8px', textAlign: 'left' }}>
            <h4 style={{ color: '#fff', marginBottom: '8px', fontSize: '14px' }}>更新日志:</h4>
            <p style={{ color: '#888', fontSize: '13px', whiteSpace: 'pre-wrap', maxHeight: '150px', overflow: 'auto' }}>
              {updateInfo.notes}
            </p>
          </div>
        )}
      </div>

      {/* 项目链接 */}
      <div style={{ marginBottom: '30px' }}>
        <h3 style={{ fontSize: '16px', color: '#fff', marginBottom: '12px' }}>
          {t('about.projectLinks')}
        </h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <a href="https://zhangifonly.github.io/whatyterm-pages/" target="_blank" rel="noopener noreferrer"
            style={{ padding: '12px', background: '#2a2a2a', borderRadius: '6px', color: '#4a9eff', textDecoration: 'none', display: 'block', textAlign: 'center' }}>
            🏠 {t('about.homepage')}
          </a>
          <a href="https://github.com/zhangifonly/WhatyTerm" target="_blank" rel="noopener noreferrer"
            style={{ padding: '12px', background: '#2a2a2a', borderRadius: '6px', color: '#4a9eff', textDecoration: 'none', display: 'block', textAlign: 'center' }}>
            🔗 {t('about.github')}
          </a>
          <a href="https://github.com/zhangifonly/WhatyTerm/issues" target="_blank" rel="noopener noreferrer"
            style={{ padding: '12px', background: '#2a2a2a', borderRadius: '6px', color: '#4a9eff', textDecoration: 'none', display: 'block', textAlign: 'center' }}>
            🐛 {t('about.issues')}
          </a>
          <a href="https://github.com/zhangifonly/WhatyTerm/releases" target="_blank" rel="noopener noreferrer"
            style={{ padding: '12px', background: '#2a2a2a', borderRadius: '6px', color: '#4a9eff', textDecoration: 'none', display: 'block', textAlign: 'center' }}>
            📦 {t('about.releases')}
          </a>
        </div>
      </div>

      {/* 系统信息 */}
      {systemInfo && (
        <div style={{ marginBottom: '30px' }}>
          <h3 style={{ fontSize: '16px', color: '#fff', marginBottom: '12px' }}>
            {t('about.systemInfo')}
          </h3>
          <div style={{ background: '#2a2a2a', borderRadius: '6px', padding: '16px', fontSize: '13px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: '8px', color: '#ccc' }}>
              <span>{t('about.nodeVersion')}:</span><span>{systemInfo.nodeVersion}</span>
              <span>{t('about.platform')}:</span><span>{systemInfo.platform}</span>
              <span>{t('about.configPath')}:</span><span>{systemInfo.configPath}</span>
            </div>
          </div>
        </div>
      )}

      {/* 技术栈 */}
      <div style={{ marginBottom: '30px' }}>
        <h3 style={{ fontSize: '16px', color: '#fff', marginBottom: '12px' }}>
          {t('about.techStack')}
        </h3>
        <div style={{ background: '#2a2a2a', borderRadius: '6px', padding: '16px', fontSize: '13px' }}>
          <div style={{ color: '#ccc', lineHeight: '1.8' }}>
            <div><strong>{t('about.frontend')}:</strong> React + Vite + Tailwind CSS</div>
            <div><strong>{t('about.backend')}:</strong> Node.js + Express + Socket.IO</div>
            <div><strong>{t('about.terminal')}:</strong> node-pty + tmux</div>
            <div><strong>AI:</strong> Claude / OpenAI / Gemini</div>
          </div>
        </div>
      </div>

      {/* 版权信息 */}
      <div style={{ textAlign: 'center', color: '#666', fontSize: '12px', paddingTop: '20px', borderTop: '1px solid #333' }}>
        <p>© 2025 WhatyTerm Team</p>
        <p style={{ marginTop: '4px' }}>{t('about.license')}: MIT</p>
      </div>

      {/* 关闭按钮 */}
      <div className="modal-actions" style={{ marginTop: '30px' }}>
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
    </div>
  );
}

function CreateTeamDialog({ onClose, onCreate }) {
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [workingDir, setWorkingDir] = useState('');
  const [memberCount, setMemberCount] = useState(2);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!name.trim() || !goal.trim()) return;
    onCreate({ name: name.trim(), goal: goal.trim(), workingDir: workingDir.trim(), memberCount });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>创建 Agent Team</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>团队名称</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="例如: ecommerce-team"
              autoFocus
            />
          </div>
          <div className="form-group">
            <label>目标</label>
            <textarea
              value={goal}
              onChange={e => setGoal(e.target.value)}
              placeholder="描述团队要完成的目标..."
            />
          </div>
          <div className="form-group">
            <label>工作目录</label>
            <input
              type="text"
              value={workingDir}
              onChange={e => setWorkingDir(e.target.value)}
              placeholder="/path/to/project（可选）"
            />
          </div>
          <div className="form-group">
            <label>Agent 数量: {memberCount}</label>
            <input
              type="range"
              min="1"
              max="6"
              value={memberCount}
              onChange={e => setMemberCount(parseInt(e.target.value))}
              style={{ width: '100%' }}
            />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>取消</button>
            <button type="submit" className="btn btn-primary" disabled={!name.trim() || !goal.trim()}>创建</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function StartTeamFromSessionDialog({ session, onClose, onCreate }) {
  const [goal, setGoal] = useState('');
  const [memberCount, setMemberCount] = useState(2);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!goal.trim()) return;
    onCreate({
      sessionId: session.id,
      goal: goal.trim(),
      memberCount
    });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>从当前会话启动团队</h2>
        <p style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', marginBottom: '12px' }}>
          当前会话 "{session.projectName || session.name}" 将成为 Team Lead，
          自动创建 {memberCount} 个 Teammate 并启动 Claude。
        </p>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>团队目标</label>
            <textarea
              value={goal}
              onChange={e => setGoal(e.target.value)}
              placeholder="描述团队要完成的目标..."
              autoFocus
            />
          </div>
          <div className="form-group">
            <label>Teammate 数量: {memberCount}</label>
            <input
              type="range"
              min="1"
              max="4"
              value={memberCount}
              onChange={e => setMemberCount(parseInt(e.target.value))}
              style={{ width: '100%' }}
            />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>取消</button>
            <button type="submit" className="btn btn-primary" disabled={!goal.trim()}>启动团队</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CreateSessionModal({ onClose, onCreate }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [aiType, setAiType] = useState('claude'); // 默认使用 Claude
  const [monitorPlugin, setMonitorPlugin] = useState('auto'); // 监控策略插件
  const [availablePlugins, setAvailablePlugins] = useState([]);

  // 加载可用的监控策略插件
  useEffect(() => {
    fetch('/api/monitor-plugins')
      .then(res => res.json())
      .then(data => {
        if (data.plugins) {
          setAvailablePlugins(data.plugins);
        }
      })
      .catch(err => console.error('加载监控插件失败:', err));
  }, []);

  const handleSubmit = (e) => {
    e.preventDefault();
    onCreate({
      name: name || `session-${Date.now()}`,
      goal,
      systemPrompt,
      aiType, // 添加 AI 类型
      monitorPlugin: monitorPlugin === 'auto' ? null : monitorPlugin // 监控策略插件
    });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{t('session.createNew')}</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>{t('common.apiType')}</label>
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
            <label>{t('session.monitorPlugin') || '监控策略'}</label>
            <select
              value={monitorPlugin}
              onChange={(e) => setMonitorPlugin(e.target.value)}
              style={{ width: '100%', padding: '8px', background: '#2a2a2a', border: '1px solid #444', borderRadius: '4px', color: '#fff' }}
            >
              <option value="auto">{t('session.monitorPluginAuto') || '自动检测'}</option>
              {availablePlugins.map(plugin => (
                <option key={plugin.id} value={plugin.id}>
                  {plugin.name} - {plugin.phases?.length || 0} 阶段
                </option>
              ))}
            </select>
            {monitorPlugin !== 'auto' && availablePlugins.find(p => p.id === monitorPlugin) && (
              <div style={{ marginTop: '4px', fontSize: '12px', color: '#888' }}>
                {availablePlugins.find(p => p.id === monitorPlugin)?.description}
              </div>
            )}
          </div>
          <div className="form-group">
            <label>{t('session.sessionName')}</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('session.sessionNamePlaceholder')}
            />
          </div>
          <div className="form-group">
            <label>{t('session.goalWithHint')}</label>
            <input
              type="text"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder={t('session.goalPlaceholder')}
            />
          </div>
          <div className="form-group">
            <label>{t('session.systemPrompt')}</label>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder={t('session.systemPromptPlaceholder')}
            />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="btn btn-primary">
              {t('session.create')}
            </button>
          </div>
        </form>
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
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [remainingAttempts, setRemainingAttempts] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    // 使用在线登录（邮箱+密码）
    const result = await auth.onlineLogin(email, password);
    if (!result.success) {
      setError(result.error || t('auth.loginFailed'));
      if (result.remainingAttempts !== undefined) {
        setRemainingAttempts(result.remainingAttempts);
      }
    }
    setLoading(false);
  };

  // 远程访问但未设置密码，现在改为显示在线登录
  // 不再要求本机设置密码，直接允许使用在线账户登录
  if (auth.requirePasswordSetup) {
    // 继续显示登录表单，使用在线认证
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>WhatyTerm</h1>
        <p className="login-subtitle">AI 自动化终端管理工具</p>
        <p style={{ fontSize: '13px', color: '#888', marginBottom: '20px' }}>
          使用您在 term.whaty.org 注册的账户登录
        </p>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>邮箱</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              autoFocus
              required
            />
          </div>
          <div className="form-group">
            <label>密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('auth.enterPassword')}
              required
            />
          </div>
          {error && (
            <div className="login-error">
              {error}
              {remainingAttempts !== null && remainingAttempts > 0 && (
                <span style={{ display: 'block', fontSize: '12px', marginTop: '4px' }}>
                  剩余尝试次数: {remainingAttempts}
                </span>
              )}
            </div>
          )}
          <button type="submit" className="btn btn-primary btn-block" disabled={loading}>
            {loading ? t('auth.loggingIn') : t('auth.login')}
          </button>
        </form>
        <div style={{ marginTop: '16px', textAlign: 'center' }}>
          <a
            href="https://term.whaty.org"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: '#4a9eff', fontSize: '13px', textDecoration: 'none' }}
          >
            还没有账户？立即注册
          </a>
          <span style={{ margin: '0 8px', color: '#555' }}>|</span>
          <a
            href="https://term.whaty.org/forgot-password"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: '#4a9eff', fontSize: '13px', textDecoration: 'none' }}
          >
            忘记密码？
          </a>
        </div>
      </div>
    </div>
  );
}

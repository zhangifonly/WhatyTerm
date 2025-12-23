/**
 * Toast 轻量级提示组件
 * 显示黄色小提醒，用户可以点击叉关闭
 */
import React, { useState, useEffect, useCallback, createContext, useContext, useRef } from 'react';

// Toast 上下文
const ToastContext = createContext(null);

// 全局 toast 引用，用于在非组件代码中调用
let globalToastRef = null;

// Toast 类型配置
const TOAST_TYPES = {
  info: {
    bg: 'hsl(45 100% 50% / 0.15)',
    border: 'hsl(45 100% 50% / 0.4)',
    color: 'hsl(45 100% 70%)',
    icon: 'ℹ️'
  },
  success: {
    bg: 'hsl(142 70% 45% / 0.15)',
    border: 'hsl(142 70% 45% / 0.4)',
    color: 'hsl(142 70% 65%)',
    icon: '✓'
  },
  error: {
    bg: 'hsl(0 70% 50% / 0.15)',
    border: 'hsl(0 70% 50% / 0.4)',
    color: 'hsl(0 70% 70%)',
    icon: '✕'
  },
  warning: {
    bg: 'hsl(30 100% 50% / 0.15)',
    border: 'hsl(30 100% 50% / 0.4)',
    color: 'hsl(30 100% 70%)',
    icon: '⚠'
  }
};

// 单个 Toast 项
function ToastItem({ id, message, type = 'info', onClose }) {
  const config = TOAST_TYPES[type] || TOAST_TYPES.info;

  useEffect(() => {
    // 5秒后自动关闭
    const timer = setTimeout(() => {
      onClose(id);
    }, 5000);
    return () => clearTimeout(timer);
  }, [id, onClose]);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
        padding: '10px 12px',
        background: config.bg,
        border: `1px solid ${config.border}`,
        borderRadius: '6px',
        color: config.color,
        fontSize: '12px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        animation: 'toastSlideIn 0.2s ease-out',
        maxWidth: '320px',
        wordBreak: 'break-word'
      }}
    >
      <span style={{ fontSize: '14px', lineHeight: 1 }}>{config.icon}</span>
      <span style={{ flex: 1, lineHeight: 1.4 }}>{message}</span>
      <button
        onClick={() => onClose(id)}
        style={{
          background: 'transparent',
          border: 'none',
          color: config.color,
          cursor: 'pointer',
          padding: '0',
          fontSize: '14px',
          lineHeight: 1,
          opacity: 0.7
        }}
        onMouseEnter={(e) => e.target.style.opacity = 1}
        onMouseLeave={(e) => e.target.style.opacity = 0.7}
      >
        ×
      </button>
    </div>
  );
}

// Toast 容器组件
export function ToastContainer({ children }) {
  const [toasts, setToasts] = useState([]);
  const toastRef = useRef(null);

  const addToast = useCallback((message, type = 'info') => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, message, type }]);
    return id;
  }, []);

  const removeToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  // 创建 toast 函数对象
  useEffect(() => {
    const toast = (message) => addToast(message, 'info');
    toast.success = (message) => addToast(message, 'success');
    toast.error = (message) => addToast(message, 'error');
    toast.warning = (message) => addToast(message, 'warning');
    toast.info = (message) => addToast(message, 'info');
    toastRef.current = toast;
    globalToastRef = toast;
  }, [addToast]);

  return (
    <ToastContext.Provider value={toastRef.current}>
      {children}
      {/* Toast 容器 - 固定在右上角 */}
      <div
        style={{
          position: 'fixed',
          top: '16px',
          right: '16px',
          zIndex: 10000,
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          pointerEvents: 'none'
        }}
      >
        <style>{`
          @keyframes toastSlideIn {
            from {
              opacity: 0;
              transform: translateX(100%);
            }
            to {
              opacity: 1;
              transform: translateX(0);
            }
          }
        `}</style>
        {toasts.map(t => (
          <div key={t.id} style={{ pointerEvents: 'auto' }}>
            <ToastItem
              id={t.id}
              message={t.message}
              type={t.type}
              onClose={removeToast}
            />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// Hook 用于在组件中使用 toast
export function useToast() {
  const toast = useContext(ToastContext);
  if (!toast) {
    // 如果没有 Provider，返回一个 fallback（使用 console）
    const fallback = (msg) => console.log('[Toast]', msg);
    fallback.success = (msg) => console.log('[Toast Success]', msg);
    fallback.error = (msg) => console.error('[Toast Error]', msg);
    fallback.warning = (msg) => console.warn('[Toast Warning]', msg);
    fallback.info = (msg) => console.log('[Toast Info]', msg);
    return fallback;
  }
  return toast;
}

// 全局 toast 函数，用于在任何地方调用
export function toast(message) {
  if (globalToastRef) {
    return globalToastRef(message);
  }
  console.log('[Toast]', message);
}
toast.success = (message) => {
  if (globalToastRef) return globalToastRef.success(message);
  console.log('[Toast Success]', message);
};
toast.error = (message) => {
  if (globalToastRef) return globalToastRef.error(message);
  console.error('[Toast Error]', message);
};
toast.warning = (message) => {
  if (globalToastRef) return globalToastRef.warning(message);
  console.warn('[Toast Warning]', message);
};
toast.info = (message) => {
  if (globalToastRef) return globalToastRef.info(message);
  console.log('[Toast Info]', message);
};

export default { ToastContainer, useToast, toast };

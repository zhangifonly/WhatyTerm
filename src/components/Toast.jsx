/**
 * Toast 轻量级提示组件
 * 右上角的提醒（成功/信息/警告/错误），5 秒后自动消失，也可以点叉关闭
 */
import React, { useState, useEffect, useCallback, createContext, useContext, useRef } from 'react';

// Toast 上下文
const ToastContext = createContext(null);

// 全局 toast 引用，用于在非组件代码中调用
let globalToastRef = null;

// Toast 类型配置：hue 是类型色（色条、图标、边框用）。
// ⚠ 背景必须不透明：原来是 15% 透明度的色块，底下终端的字会透上来和提示叠在一起，看不清
//   （切换供应商时的绿色提示就是这样）。现在是「主题弹层底色 + 一层淡色调」，正文用主题前景色，
//   深色、浅色主题下都清楚 —— 原来的浅绿字放在浅色主题的白底上本来也看不清。
const TOAST_TYPES = {
  info: { hue: '45 100% 50%', icon: 'ℹ️' },
  success: { hue: '142 70% 42%', icon: '✓' },
  error: { hue: '0 72% 52%', icon: '✕' },
  warning: { hue: '30 100% 50%', icon: '⚠' },
};

/** 不透明背景：淡色调叠在主题弹层底色上（渐变只是为了能叠两层，颜色是平的） */
export const toastBackground = (hue) => `linear-gradient(hsl(${hue} / 0.16), hsl(${hue} / 0.16)), hsl(var(--popover))`;

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
        background: toastBackground(config.hue),
        border: `1px solid hsl(${config.hue} / 0.55)`,
        borderLeft: `3px solid hsl(${config.hue})`,
        borderRadius: '6px',
        color: 'hsl(var(--popover-foreground))',
        fontSize: '13px',
        boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
        animation: 'toastSlideIn 0.2s ease-out',
        maxWidth: '320px',
        wordBreak: 'break-word'
      }}
    >
      <span style={{ fontSize: '14px', lineHeight: 1.4, color: `hsl(${config.hue})`, fontWeight: 700 }}>{config.icon}</span>
      <span style={{ flex: 1, lineHeight: 1.4 }}>{message}</span>
      <button
        onClick={() => onClose(id)}
        style={{
          background: 'transparent',
          border: 'none',
          color: 'inherit',
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

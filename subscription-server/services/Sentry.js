/**
 * Sentry 错误监控服务
 * 自动捕获和报告应用程序错误
 */

import * as Sentry from '@sentry/node';

const SENTRY_DSN = process.env.SENTRY_DSN || '';

// 是否启用 Sentry
const isEnabled = !!SENTRY_DSN;

/**
 * 初始化 Sentry
 */
function init(app) {
  if (!isEnabled) {
    console.log('[Sentry] DSN 未配置，错误监控已禁用');
    return;
  }

  Sentry.init({
    dsn: SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    release: process.env.npm_package_version || '1.0.0',

    // 性能监控采样率
    tracesSampleRate: 0.1,

    // 忽略常见的非关键错误
    ignoreErrors: [
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'Request aborted'
    ],

    // 在发送前处理事件
    beforeSend(event, hint) {
      // 过滤敏感信息
      if (event.request) {
        // 移除敏感请求头
        if (event.request.headers) {
          delete event.request.headers.authorization;
          delete event.request.headers.cookie;
        }
        // 移除敏感请求体字段
        if (event.request.data) {
          const data = typeof event.request.data === 'string'
            ? JSON.parse(event.request.data)
            : event.request.data;
          if (data.password) data.password = '[FILTERED]';
          if (data.token) data.token = '[FILTERED]';
          if (data.licenseKey) data.licenseKey = '[FILTERED]';
          event.request.data = JSON.stringify(data);
        }
      }
      return event;
    }
  });

  console.log('[Sentry] 错误监控已启用');
}

/**
 * Express 错误处理中间件
 */
function errorHandler() {
  if (!isEnabled) {
    return (err, req, res, next) => next(err);
  }
  return Sentry.expressErrorHandler();
}

/**
 * 手动捕获异常
 */
function captureException(error, context = {}) {
  if (!isEnabled) return;

  Sentry.withScope(scope => {
    Object.entries(context).forEach(([key, value]) => {
      scope.setExtra(key, value);
    });
    Sentry.captureException(error);
  });
}

/**
 * 手动捕获消息
 */
function captureMessage(message, level = 'info', context = {}) {
  if (!isEnabled) return;

  Sentry.withScope(scope => {
    Object.entries(context).forEach(([key, value]) => {
      scope.setExtra(key, value);
    });
    Sentry.captureMessage(message, level);
  });
}

/**
 * 设置用户上下文
 */
function setUser(user) {
  if (!isEnabled) return;
  Sentry.setUser(user);
}

/**
 * 清除用户上下文
 */
function clearUser() {
  if (!isEnabled) return;
  Sentry.setUser(null);
}

export {
  init,
  errorHandler,
  captureException,
  captureMessage,
  setUser,
  clearUser,
  isEnabled
};

export default {
  init,
  errorHandler,
  captureException,
  captureMessage,
  setUser,
  clearUser,
  isEnabled
};

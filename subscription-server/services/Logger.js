/**
 * 日志服务模块
 * 使用 Winston 实现结构化日志，支持日志轮转
 */

import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 日志目录
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, '..', 'data', 'logs');

// 日志级别
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

// 自定义日志格式
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let log = `${timestamp} [${level.toUpperCase()}] ${message}`;
    if (Object.keys(meta).length > 0) {
      log += ` ${JSON.stringify(meta)}`;
    }
    return log;
  })
);

// 控制台格式（带颜色）
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let log = `${timestamp} ${level} ${message}`;
    if (Object.keys(meta).length > 0 && Object.keys(meta).some(k => meta[k] !== undefined)) {
      const filteredMeta = Object.fromEntries(
        Object.entries(meta).filter(([_, v]) => v !== undefined)
      );
      if (Object.keys(filteredMeta).length > 0) {
        log += ` ${JSON.stringify(filteredMeta)}`;
      }
    }
    return log;
  })
);

// 创建日志传输器
const transports = [
  // 控制台输出
  new winston.transports.Console({
    format: consoleFormat
  })
];

// 生产环境添加文件日志
if (process.env.NODE_ENV === 'production' || process.env.ENABLE_FILE_LOG === 'true') {
  // 普通日志（每日轮转）
  transports.push(
    new DailyRotateFile({
      dirname: LOG_DIR,
      filename: 'app-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '14d',
      format: logFormat
    })
  );

  // 错误日志（单独文件）
  transports.push(
    new DailyRotateFile({
      dirname: LOG_DIR,
      filename: 'error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '30d',
      level: 'error',
      format: logFormat
    })
  );
}

// 创建 logger 实例
const logger = winston.createLogger({
  level: LOG_LEVEL,
  transports
});

// 便捷方法
const log = {
  info: (message, meta = {}) => logger.info(message, meta),
  warn: (message, meta = {}) => logger.warn(message, meta),
  error: (message, meta = {}) => logger.error(message, meta),
  debug: (message, meta = {}) => logger.debug(message, meta),

  // HTTP 请求日志
  http: (req, res, duration) => {
    const meta = {
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip || req.connection.remoteAddress
    };

    if (res.statusCode >= 400) {
      logger.warn(`HTTP ${req.method} ${req.originalUrl}`, meta);
    } else {
      logger.info(`HTTP ${req.method} ${req.originalUrl}`, meta);
    }
  },

  // 支付日志
  payment: (action, data) => {
    logger.info(`[支付] ${action}`, { ...data, _category: 'payment' });
  },

  // 认证日志
  auth: (action, data) => {
    logger.info(`[认证] ${action}`, { ...data, _category: 'auth' });
  },

  // 许可证日志
  license: (action, data) => {
    logger.info(`[许可证] ${action}`, { ...data, _category: 'license' });
  },

  // 定时任务日志
  cron: (action, data) => {
    logger.info(`[定时任务] ${action}`, { ...data, _category: 'cron' });
  }
};

// Express 中间件：请求日志
function requestLogger() {
  return (req, res, next) => {
    const start = Date.now();

    res.on('finish', () => {
      const duration = Date.now() - start;
      // 跳过健康检查和静态资源
      if (!req.originalUrl.includes('/health') &&
          !req.originalUrl.match(/\.(js|css|png|jpg|ico|svg)$/)) {
        log.http(req, res, duration);
      }
    });

    next();
  };
}

// Express 中间件：错误日志
function errorLogger() {
  return (err, req, res, next) => {
    logger.error(`Unhandled error: ${err.message}`, {
      stack: err.stack,
      method: req.method,
      url: req.originalUrl,
      body: req.body,
      _category: 'error'
    });
    next(err);
  };
}

export { logger, log, requestLogger, errorLogger };
export default log;

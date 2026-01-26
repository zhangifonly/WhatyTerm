import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import QRCode from 'qrcode';
import { paymentConfig, checkAlipayConfig, checkWechatConfig } from './config/payment.js';
import { initAlipay, createAlipayOrder, queryAlipayOrder, verifyAlipayNotify, closeAlipayOrder } from './services/alipay.js';
import { initWechatPay, createWechatOrder, queryWechatOrder, verifyWechatNotify, closeWechatOrder } from './services/wechat.js';
import { sendPasswordResetEmail, sendOrderConfirmationEmail, sendLicenseExpiryReminder } from './services/EmailService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 配置
const PORT = process.env.PORT || 3100;
const JWT_SECRET = process.env.JWT_SECRET || 'whatyterm-subscription-secret-2025';
const LICENSE_SECRET = process.env.LICENSE_SECRET || 'whatyterm-license-secret-2025';

// 初始化数据库
const db = new Database(path.join(__dirname, 'data', 'subscription.db'));
db.pragma('journal_mode = WAL');

// 初始化表结构
db.exec(`
  -- 系统配置表
  CREATE TABLE IF NOT EXISTS system_config (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER DEFAULT (strftime('%s', 'now'))
  );

  -- 用户表
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT,
    reset_token TEXT,
    reset_token_expires INTEGER,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER DEFAULT (strftime('%s', 'now'))
  );

  -- 订阅计划表
  CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    price_monthly INTEGER NOT NULL,
    price_yearly INTEGER NOT NULL,
    max_devices INTEGER DEFAULT 1,
    features TEXT,
    is_active INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  );

  -- 许可证表
  CREATE TABLE IF NOT EXISTS licenses (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    license_key TEXT UNIQUE NOT NULL,
    status TEXT DEFAULT 'active',
    expires_at INTEGER NOT NULL,
    max_devices INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (plan_id) REFERENCES plans(id)
  );

  -- 设备激活表
  CREATE TABLE IF NOT EXISTS activations (
    id TEXT PRIMARY KEY,
    license_id TEXT NOT NULL,
    machine_id TEXT NOT NULL,
    hostname TEXT,
    platform TEXT,
    arch TEXT,
    activated_at INTEGER DEFAULT (strftime('%s', 'now')),
    last_seen_at INTEGER DEFAULT (strftime('%s', 'now')),
    is_active INTEGER DEFAULT 1,
    FOREIGN KEY (license_id) REFERENCES licenses(id),
    UNIQUE(license_id, machine_id)
  );

  -- 订单表
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    currency TEXT DEFAULT 'CNY',
    payment_method TEXT,
    payment_id TEXT,
    status TEXT DEFAULT 'pending',
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    paid_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (plan_id) REFERENCES plans(id)
  );

  -- 激活码表（用于手动发放）
  CREATE TABLE IF NOT EXISTS activation_codes (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    plan_id TEXT NOT NULL,
    duration_days INTEGER NOT NULL,
    max_uses INTEGER DEFAULT 1,
    used_count INTEGER DEFAULT 0,
    created_by TEXT,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    expires_at INTEGER,
    FOREIGN KEY (plan_id) REFERENCES plans(id)
  );

  -- 激活码使用记录
  CREATE TABLE IF NOT EXISTS code_redemptions (
    id TEXT PRIMARY KEY,
    code_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    license_id TEXT NOT NULL,
    redeemed_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (code_id) REFERENCES activation_codes(id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (license_id) REFERENCES licenses(id)
  );

  -- 创建索引
  CREATE INDEX IF NOT EXISTS idx_licenses_user ON licenses(user_id);
  CREATE INDEX IF NOT EXISTS idx_licenses_key ON licenses(license_key);
  CREATE INDEX IF NOT EXISTS idx_activations_license ON activations(license_id);
  CREATE INDEX IF NOT EXISTS idx_activations_machine ON activations(machine_id);
  CREATE INDEX IF NOT EXISTS idx_codes_code ON activation_codes(code);
`);

// 初始化默认计划
const defaultPlans = [
  {
    id: 'personal',
    name: '个人版',
    description: '适合个人开发者',
    price_monthly: 2900,
    price_yearly: 29900,
    max_devices: 1,
    features: JSON.stringify(['all-plugins', 'email-support'])
  },
  {
    id: 'professional',
    name: '专业版',
    description: '适合小型团队',
    price_monthly: 9900,
    price_yearly: 99900,
    max_devices: 5,
    features: JSON.stringify(['all-plugins', 'priority-support', 'team-management'])
  },
  {
    id: 'enterprise',
    name: '企业版',
    description: '适合企业用户',
    price_monthly: 29900,
    price_yearly: 299900,
    max_devices: 999,
    features: JSON.stringify(['all-plugins', 'dedicated-support', 'custom-features', 'sla'])
  }
];

const insertPlan = db.prepare(`
  INSERT OR IGNORE INTO plans (id, name, description, price_monthly, price_yearly, max_devices, features)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

for (const plan of defaultPlans) {
  insertPlan.run(plan.id, plan.name, plan.description, plan.price_monthly, plan.price_yearly, plan.max_devices, plan.features);
}

// 创建 Express 应用
const app = express();

// 中间件
app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 速率限制
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use('/api/', limiter);

// 工具函数
function generateLicenseKey() {
  const segments = [];
  for (let i = 0; i < 4; i++) {
    segments.push(crypto.randomBytes(4).toString('hex').toUpperCase());
  }
  return segments.join('-');
}

function generateActivationCode() {
  return 'WT-' + crypto.randomBytes(8).toString('hex').toUpperCase();
}

function signLicenseData(data) {
  const hmac = crypto.createHmac('sha256', LICENSE_SECRET);
  hmac.update(JSON.stringify(data));
  return hmac.digest('hex');
}

// JWT 中间件
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: '未授权' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token 无效' });
  }
}

// ============================================
// 公开 API
// ============================================

// 获取订阅计划
app.get('/api/plans', (req, res) => {
  const plans = db.prepare('SELECT * FROM plans WHERE is_active = 1').all();
  res.json(plans.map(p => ({
    ...p,
    features: JSON.parse(p.features || '[]')
  })));
});

// 用户注册
app.post('/api/auth/register', async (req, res) => {
  const { email, password, name } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: '邮箱和密码必填' });
  }

  try {
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      return res.status(400).json({ error: '邮箱已注册' });
    }

    const id = uuidv4();
    const passwordHash = await bcrypt.hash(password, 10);

    db.prepare('INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, ?, ?)')
      .run(id, email, passwordHash, name || null);

    // 新用户注册赠送一个月 Pro 版本（个人版）
    const licenseId = uuidv4();
    const licenseKey = generateLicenseKey();
    const expiresAt = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // 30天后过期
    const planId = 'personal'; // 个人版

    db.prepare(`
      INSERT INTO licenses (id, user_id, plan_id, license_key, status, expires_at, max_devices)
      VALUES (?, ?, ?, ?, 'active', ?, 1)
    `).run(licenseId, id, planId, licenseKey, expiresAt);

    console.log(`[注册赠送] 用户 ${email} 获得一个月 Pro 试用，许可证: ${licenseKey}`);

    const token = jwt.sign({ id, email }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      success: true,
      token,
      user: { id, email, name },
      trialLicense: {
        licenseKey,
        expiresAt: new Date(expiresAt * 1000).toISOString(),
        plan: 'personal',
        message: '恭喜！您已获得一个月 Pro 版本免费试用'
      }
    });
  } catch (err) {
    console.error('注册失败:', err);
    res.status(500).json({ error: '注册失败' });
  }
});

// 用户登录
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: '邮箱和密码必填' });
  }

  try {
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) {
      return res.status(401).json({ error: '邮箱或密码错误' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: '邮箱或密码错误' });
    }

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

    res.json({ success: true, token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    console.error('登录失败:', err);
    res.status(500).json({ error: '登录失败' });
  }
});

// 验证用户凭据（供 WhatyTerm 客户端远程访问认证使用）
// 此 API 不返回 JWT token，仅验证用户身份并返回许可证信息
app.post('/api/auth/verify-credentials', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ valid: false, error: '邮箱和密码必填' });
  }

  try {
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) {
      console.log(`[验证凭据] 用户不存在: ${email}`);
      return res.json({ valid: false, error: '邮箱或密码错误' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      console.log(`[验证凭据] 密码错误: ${email}`);
      return res.json({ valid: false, error: '邮箱或密码错误' });
    }

    // 获取用户的有效许可证
    const licenses = db.prepare(`
      SELECT l.*, p.name as plan_name, p.features
      FROM licenses l
      JOIN plans p ON l.plan_id = p.id
      WHERE l.user_id = ? AND l.status = 'active' AND l.expires_at > ?
    `).all(user.id, Math.floor(Date.now() / 1000));

    const hasValidLicense = licenses.length > 0;

    console.log(`[验证凭据] 用户验证成功: ${email}, 有效许可证: ${hasValidLicense}`);

    res.json({
      valid: true,
      userId: user.id,
      email: user.email,
      name: user.name,
      hasValidLicense,
      licenses: licenses.map(l => ({
        id: l.id,
        planId: l.plan_id,
        planName: l.plan_name,
        expiresAt: new Date(l.expires_at * 1000).toISOString(),
        features: JSON.parse(l.features || '[]')
      }))
    });
  } catch (err) {
    console.error('[验证凭据] 验证失败:', err);
    res.status(500).json({ valid: false, error: '验证失败' });
  }
});

// 忘记密码 - 生成重置令牌
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: '请输入邮箱地址' });
  }

  try {
    const user = db.prepare('SELECT id, email, name FROM users WHERE email = ?').get(email);

    // 无论用户是否存在，都返回成功（防止邮箱枚举攻击）
    if (!user) {
      return res.json({
        success: true,
        message: '如果该邮箱已注册，您将收到密码重置链接'
      });
    }

    // 生成重置令牌（32字节随机字符串）
    const resetToken = crypto.randomBytes(32).toString('hex');
    // 令牌有效期：1小时
    const resetTokenExpires = Math.floor(Date.now() / 1000) + 3600;

    // 保存令牌到数据库
    db.prepare(`
      UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?
    `).run(resetToken, resetTokenExpires, user.id);

    console.log(`[密码重置] 用户 ${email} 请求重置密码`);

    // 发送密码重置邮件
    const emailSent = await sendPasswordResetEmail(email, resetToken, user.name);
    if (!emailSent) {
      console.warn(`[密码重置] 邮件发送失败，用户: ${email}`);
    }

    res.json({
      success: true,
      message: '如果该邮箱已注册，您将收到密码重置链接',
      // 仅在开发/测试环境返回令牌，生产环境应移除
      ...(process.env.NODE_ENV !== 'production' && {
        resetToken,
        expiresIn: '1小时'
      })
    });
  } catch (err) {
    console.error('忘记密码处理失败:', err);
    res.status(500).json({ error: '处理失败，请稍后重试' });
  }
});

// 重置密码 - 使用令牌重置
app.post('/api/auth/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword) {
    return res.status(400).json({ error: '缺少必要参数' });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ error: '密码长度至少6位' });
  }

  try {
    // 查找有效的重置令牌
    const user = db.prepare(`
      SELECT id, email FROM users
      WHERE reset_token = ? AND reset_token_expires > strftime('%s', 'now')
    `).get(token);

    if (!user) {
      return res.status(400).json({ error: '重置链接无效或已过期' });
    }

    // 更新密码并清除重置令牌
    const passwordHash = await bcrypt.hash(newPassword, 10);
    db.prepare(`
      UPDATE users
      SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL, updated_at = strftime('%s', 'now')
      WHERE id = ?
    `).run(passwordHash, user.id);

    console.log(`[密码重置] 用户 ${user.email} 密码重置成功`);

    res.json({
      success: true,
      message: '密码重置成功，请使用新密码登录'
    });
  } catch (err) {
    console.error('重置密码失败:', err);
    res.status(500).json({ error: '重置失败，请稍后重试' });
  }
});

// 验证重置令牌是否有效
app.get('/api/auth/verify-reset-token', (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.status(400).json({ valid: false, error: '缺少令牌' });
  }

  try {
    const user = db.prepare(`
      SELECT id, email FROM users
      WHERE reset_token = ? AND reset_token_expires > strftime('%s', 'now')
    `).get(token);

    if (!user) {
      return res.json({ valid: false, error: '重置链接无效或已过期' });
    }

    res.json({
      valid: true,
      email: user.email.replace(/(.{2}).*(@.*)/, '$1***$2') // 隐藏部分邮箱
    });
  } catch (err) {
    console.error('验证令牌失败:', err);
    res.status(500).json({ valid: false, error: '验证失败' });
  }
});

// ============================================
// 许可证 API（客户端调用）
// ============================================

// 激活许可证（邮箱+密码认证方式）
app.post('/api/license/activate', async (req, res) => {
  const { email, password, machineId, hostname, platform, arch } = req.body;

  if (!email || !password || !machineId) {
    return res.status(400).json({ success: false, message: '缺少邮箱、密码或机器 ID' });
  }

  try {
    // 验证用户身份
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) {
      return res.json({ success: false, message: '邮箱或密码错误' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.json({ success: false, message: '邮箱或密码错误' });
    }

    // 查找用户的有效许可证
    const license = db.prepare(`
      SELECT l.*, p.name as plan_name
      FROM licenses l
      JOIN plans p ON l.plan_id = p.id
      WHERE l.user_id = ? AND l.status = 'active' AND l.expires_at > strftime('%s', 'now')
      ORDER BY l.expires_at DESC
      LIMIT 1
    `).get(user.id);

    if (!license) {
      return res.json({ success: false, message: '没有有效的许可证，请先兑换激活码' });
    }

    // 检查设备数量
    const activeDevices = db.prepare(`
      SELECT COUNT(*) as count FROM activations
      WHERE license_id = ? AND is_active = 1
    `).get(license.id).count;

    // 检查是否已经激活过这台设备
    const existingActivation = db.prepare(`
      SELECT id FROM activations WHERE license_id = ? AND machine_id = ?
    `).get(license.id, machineId);

    if (!existingActivation && activeDevices >= license.max_devices) {
      return res.json({
        success: false,
        message: `已达到最大设备数 (${license.max_devices})，请先在用户中心解绑其他设备`
      });
    }

    // 创建或更新激活记录
    if (existingActivation) {
      db.prepare(`
        UPDATE activations SET hostname = ?, platform = ?, arch = ?, last_seen_at = strftime('%s', 'now'), is_active = 1
        WHERE id = ?
      `).run(hostname, platform, arch, existingActivation.id);
    } else {
      const activationId = uuidv4();
      db.prepare(`
        INSERT INTO activations (id, license_id, machine_id, hostname, platform, arch)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(activationId, license.id, machineId, hostname, platform, arch);
    }

    res.json({
      success: true,
      message: '激活成功',
      license: {
        key: license.license_key,
        plan: license.plan_id,
        planName: license.plan_name,
        email: user.email,
        expiresAt: new Date(license.expires_at * 1000).toISOString(),
        maxDevices: license.max_devices
      }
    });
  } catch (err) {
    console.error('激活失败:', err);
    res.status(500).json({ success: false, message: '激活失败' });
  }
});

// 验证许可证
app.post('/api/license/verify', (req, res) => {
  const { code, machineId } = req.body;

  if (!code || !machineId) {
    return res.status(400).json({ success: false, message: '缺少参数' });
  }

  try {
    // 查找许可证
    const license = db.prepare(`
      SELECT l.*, p.name as plan_name, u.email
      FROM licenses l
      JOIN plans p ON l.plan_id = p.id
      JOIN users u ON l.user_id = u.id
      WHERE l.license_key = ? AND l.status = 'active'
    `).get(code);

    if (!license) {
      return res.json({ success: false, message: '许可证无效', code: 'LICENSE_INVALID' });
    }

    // 检查是否过期
    if (license.expires_at < Math.floor(Date.now() / 1000)) {
      return res.json({ success: false, message: '许可证已过期', code: 'LICENSE_EXPIRED' });
    }

    // 检查设备是否已激活
    const activation = db.prepare(`
      SELECT id FROM activations WHERE license_id = ? AND machine_id = ? AND is_active = 1
    `).get(license.id, machineId);

    if (!activation) {
      return res.json({ success: false, message: '此设备未激活或已被解绑', code: 'DEVICE_DEACTIVATED' });
    }

    // 更新最后访问时间
    db.prepare(`
      UPDATE activations SET last_seen_at = strftime('%s', 'now') WHERE id = ?
    `).run(activation.id);

    res.json({
      success: true,
      message: '验证成功',
      license: {
        key: license.license_key,
        plan: license.plan_id,
        planName: license.plan_name,
        email: license.email,
        expiresAt: new Date(license.expires_at * 1000).toISOString(),
        maxDevices: license.max_devices
      }
    });
  } catch (err) {
    console.error('验证失败:', err);
    res.status(500).json({ success: false, message: '验证失败' });
  }
});

// 停用许可证（解绑设备）
app.post('/api/license/deactivate', (req, res) => {
  const { code, machineId } = req.body;

  if (!code || !machineId) {
    return res.status(400).json({ success: false, message: '缺少参数' });
  }

  try {
    const license = db.prepare('SELECT id FROM licenses WHERE license_key = ?').get(code);

    if (!license) {
      return res.json({ success: false, message: '许可证无效' });
    }

    // 停用设备
    const result = db.prepare(`
      UPDATE activations SET is_active = 0 WHERE license_id = ? AND machine_id = ?
    `).run(license.id, machineId);

    if (result.changes > 0) {
      res.json({ success: true, message: '设备已解绑' });
    } else {
      res.json({ success: false, message: '未找到激活记录' });
    }
  } catch (err) {
    console.error('停用失败:', err);
    res.status(500).json({ success: false, message: '停用失败' });
  }
});

// ============================================
// 用户 API（需要登录）
// ============================================

// 获取用户许可证
app.get('/api/user/licenses', authMiddleware, (req, res) => {
  try {
    const licenses = db.prepare(`
      SELECT l.*, p.name as plan_name
      FROM licenses l
      JOIN plans p ON l.plan_id = p.id
      WHERE l.user_id = ?
      ORDER BY l.created_at DESC
    `).all(req.user.id);

    // 获取每个许可证的激活设备
    const result = licenses.map(license => {
      const activations = db.prepare(`
        SELECT * FROM activations WHERE license_id = ? AND is_active = 1
      `).all(license.id);

      return {
        ...license,
        activations
      };
    });

    res.json(result);
  } catch (err) {
    console.error('获取许可证失败:', err);
    res.status(500).json({ error: '获取失败' });
  }
});

// 兑换激活码
app.post('/api/user/redeem', authMiddleware, (req, res) => {
  const { code } = req.body;

  if (!code) {
    return res.status(400).json({ error: '缺少激活码' });
  }

  try {
    const activationCode = db.prepare(`
      SELECT ac.*, p.max_devices
      FROM activation_codes ac
      JOIN plans p ON ac.plan_id = p.id
      WHERE ac.code = ? AND (ac.expires_at IS NULL OR ac.expires_at > strftime('%s', 'now'))
    `).get(code);

    if (!activationCode) {
      return res.status(400).json({ error: '激活码无效或已过期' });
    }

    if (activationCode.used_count >= activationCode.max_uses) {
      return res.status(400).json({ error: '激活码已达到最大使用次数' });
    }

    // 创建许可证
    const licenseId = uuidv4();
    const licenseKey = generateLicenseKey();
    const expiresAt = Math.floor(Date.now() / 1000) + (activationCode.duration_days * 24 * 60 * 60);

    db.prepare(`
      INSERT INTO licenses (id, user_id, plan_id, license_key, expires_at, max_devices)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(licenseId, req.user.id, activationCode.plan_id, licenseKey, expiresAt, activationCode.max_devices);

    // 更新激活码使用次数
    db.prepare('UPDATE activation_codes SET used_count = used_count + 1 WHERE id = ?')
      .run(activationCode.id);

    // 记录兑换
    db.prepare(`
      INSERT INTO code_redemptions (id, code_id, user_id, license_id)
      VALUES (?, ?, ?, ?)
    `).run(uuidv4(), activationCode.id, req.user.id, licenseId);

    res.json({
      success: true,
      license: {
        id: licenseId,
        key: licenseKey,
        plan_id: activationCode.plan_id,
        expires_at: expiresAt
      }
    });
  } catch (err) {
    console.error('兑换失败:', err);
    res.status(500).json({ error: '兑换失败' });
  }
});

// 获取用户所有设备
app.get('/api/user/devices', authMiddleware, (req, res) => {
  try {
    const devices = db.prepare(`
      SELECT a.*, l.license_key, l.expires_at as license_expires_at, p.name as plan_name
      FROM activations a
      JOIN licenses l ON a.license_id = l.id
      JOIN plans p ON l.plan_id = p.id
      WHERE l.user_id = ?
      ORDER BY a.activated_at DESC
    `).all(req.user.id);

    res.json(devices);
  } catch (err) {
    console.error('获取设备失败:', err);
    res.status(500).json({ error: '获取失败' });
  }
});

// 解绑设备
app.post('/api/user/devices/:id/deactivate', authMiddleware, (req, res) => {
  const { id } = req.params;

  try {
    // 验证设备属于当前用户
    const device = db.prepare(`
      SELECT a.* FROM activations a
      JOIN licenses l ON a.license_id = l.id
      WHERE a.id = ? AND l.user_id = ?
    `).get(id, req.user.id);

    if (!device) {
      return res.status(404).json({ error: '设备不存在或无权操作' });
    }

    // 解绑设备（设置 is_active = 0）
    db.prepare('UPDATE activations SET is_active = 0 WHERE id = ?').run(id);

    res.json({ success: true, message: '设备已解绑' });
  } catch (err) {
    console.error('解绑失败:', err);
    res.status(500).json({ error: '解绑失败' });
  }
});

// ============================================
// 管理 API
// ============================================

// 简单的管理员验证
function adminMiddleware(req, res, next) {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_KEY && adminKey !== 'whatyterm-admin-2025') {
    return res.status(403).json({ error: '无权限' });
  }
  next();
}

// 生成激活码
app.post('/api/admin/codes/generate', adminMiddleware, (req, res) => {
  const { planId, durationDays, maxUses, count, expiresAt } = req.body;

  if (!planId || !durationDays) {
    return res.status(400).json({ error: '缺少必要参数' });
  }

  try {
    const codes = [];
    const insertCode = db.prepare(`
      INSERT INTO activation_codes (id, code, plan_id, duration_days, max_uses, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const generateCount = count || 1;
    for (let i = 0; i < generateCount; i++) {
      const id = uuidv4();
      const code = generateActivationCode();
      insertCode.run(id, code, planId, durationDays, maxUses || 1, expiresAt || null);
      codes.push(code);
    }

    res.json({ success: true, codes });
  } catch (err) {
    console.error('生成激活码失败:', err);
    res.status(500).json({ error: '生成失败' });
  }
});

// 获取统计信息
app.get('/api/admin/stats', adminMiddleware, (req, res) => {
  try {
    const stats = {
      totalUsers: db.prepare('SELECT COUNT(*) as count FROM users').get().count,
      totalLicenses: db.prepare('SELECT COUNT(*) as count FROM licenses').get().count,
      activeLicenses: db.prepare("SELECT COUNT(*) as count FROM licenses WHERE status = 'active' AND expires_at > strftime('%s', 'now')").get().count,
      totalActivations: db.prepare('SELECT COUNT(*) as count FROM activations WHERE is_active = 1').get().count,
      totalCodes: db.prepare('SELECT COUNT(*) as count FROM activation_codes').get().count,
      usedCodes: db.prepare('SELECT COUNT(*) as count FROM activation_codes WHERE used_count > 0').get().count
    };

    res.json(stats);
  } catch (err) {
    console.error('获取统计失败:', err);
    res.status(500).json({ error: '获取失败' });
  }
});

// 获取所有订单（支持分页和筛选）
app.get('/api/admin/orders', adminMiddleware, (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const status = req.query.status;
    const search = req.query.search;

    let whereClause = '1=1';
    const params = [];

    if (status) {
      whereClause += ' AND o.status = ?';
      params.push(status);
    }

    if (search) {
      whereClause += ' AND (o.payment_id LIKE ? OR o.id LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    const total = db.prepare(`
      SELECT COUNT(*) as count FROM orders o WHERE ${whereClause}
    `).get(...params).count;

    const orders = db.prepare(`
      SELECT o.*, p.name as plan_name, u.email
      FROM orders o
      JOIN plans p ON o.plan_id = p.id
      LEFT JOIN users u ON o.user_id = u.id
      WHERE ${whereClause}
      ORDER BY o.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    res.json({
      data: orders,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('获取订单失败:', err);
    res.status(500).json({ error: '获取失败' });
  }
});

// 获取所有用户（支持分页和搜索）
app.get('/api/admin/users', adminMiddleware, (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const search = req.query.search;

    let whereClause = '1=1';
    const params = [];

    if (search) {
      whereClause += ' AND (u.email LIKE ? OR u.name LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    const total = db.prepare(`
      SELECT COUNT(*) as count FROM users u WHERE ${whereClause}
    `).get(...params).count;

    const users = db.prepare(`
      SELECT u.id, u.email, u.name, u.created_at,
        (SELECT COUNT(*) FROM licenses WHERE user_id = u.id) as license_count,
        (SELECT COUNT(*) FROM activations a JOIN licenses l ON a.license_id = l.id WHERE l.user_id = u.id AND a.is_active = 1) as device_count
      FROM users u
      WHERE ${whereClause}
      ORDER BY u.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    res.json({
      data: users,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('获取用户失败:', err);
    res.status(500).json({ error: '获取失败' });
  }
});

// 获取用户详情
app.get('/api/admin/users/:id', adminMiddleware, (req, res) => {
  try {
    const user = db.prepare('SELECT id, email, name, created_at FROM users WHERE id = ?').get(req.params.id);
    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }

    const licenses = db.prepare(`
      SELECT l.*, p.name as plan_name
      FROM licenses l
      JOIN plans p ON l.plan_id = p.id
      WHERE l.user_id = ?
      ORDER BY l.created_at DESC
    `).all(req.params.id);

    const devices = db.prepare(`
      SELECT a.*, l.license_key
      FROM activations a
      JOIN licenses l ON a.license_id = l.id
      WHERE l.user_id = ?
      ORDER BY a.activated_at DESC
    `).all(req.params.id);

    res.json({ user, licenses, devices });
  } catch (err) {
    console.error('获取用户详情失败:', err);
    res.status(500).json({ error: '获取失败' });
  }
});

// 获取所有设备（支持分页和搜索）
app.get('/api/admin/devices', adminMiddleware, (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const search = req.query.search;
    const status = req.query.status; // active, inactive

    let whereClause = '1=1';
    const params = [];

    if (search) {
      whereClause += ' AND (a.hostname LIKE ? OR a.machine_id LIKE ? OR u.email LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (status === 'active') {
      whereClause += ' AND a.is_active = 1';
    } else if (status === 'inactive') {
      whereClause += ' AND a.is_active = 0';
    }

    const total = db.prepare(`
      SELECT COUNT(*) as count
      FROM activations a
      JOIN licenses l ON a.license_id = l.id
      JOIN users u ON l.user_id = u.id
      WHERE ${whereClause}
    `).get(...params).count;

    const devices = db.prepare(`
      SELECT a.*, l.license_key, l.expires_at as license_expires_at, p.name as plan_name, u.email
      FROM activations a
      JOIN licenses l ON a.license_id = l.id
      JOIN plans p ON l.plan_id = p.id
      JOIN users u ON l.user_id = u.id
      WHERE ${whereClause}
      ORDER BY a.last_seen_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    res.json({
      data: devices,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('获取设备失败:', err);
    res.status(500).json({ error: '获取失败' });
  }
});

// 管理员解绑设备
app.post('/api/admin/devices/:id/deactivate', adminMiddleware, (req, res) => {
  try {
    const result = db.prepare('UPDATE activations SET is_active = 0 WHERE id = ?').run(req.params.id);
    if (result.changes > 0) {
      res.json({ success: true, message: '设备已解绑' });
    } else {
      res.status(404).json({ error: '设备不存在' });
    }
  } catch (err) {
    console.error('解绑设备失败:', err);
    res.status(500).json({ error: '解绑失败' });
  }
});

// 许可证延期
app.post('/api/admin/licenses/:id/extend', adminMiddleware, (req, res) => {
  const { days } = req.body;
  if (!days || days < 1) {
    return res.status(400).json({ error: '请指定有效的延期天数' });
  }

  try {
    const license = db.prepare('SELECT * FROM licenses WHERE id = ?').get(req.params.id);
    if (!license) {
      return res.status(404).json({ error: '许可证不存在' });
    }

    const currentExpiry = Math.max(license.expires_at, Math.floor(Date.now() / 1000));
    const newExpiry = currentExpiry + (days * 24 * 60 * 60);

    db.prepare('UPDATE licenses SET expires_at = ?, updated_at = strftime(\'%s\', \'now\') WHERE id = ?')
      .run(newExpiry, req.params.id);

    res.json({
      success: true,
      message: `许可证已延期 ${days} 天`,
      newExpiresAt: newExpiry
    });
  } catch (err) {
    console.error('延期许可证失败:', err);
    res.status(500).json({ error: '延期失败' });
  }
});

// 禁用/启用许可证
app.post('/api/admin/licenses/:id/toggle', adminMiddleware, (req, res) => {
  try {
    const license = db.prepare('SELECT * FROM licenses WHERE id = ?').get(req.params.id);
    if (!license) {
      return res.status(404).json({ error: '许可证不存在' });
    }

    const newStatus = license.status === 'active' ? 'disabled' : 'active';
    db.prepare('UPDATE licenses SET status = ?, updated_at = strftime(\'%s\', \'now\') WHERE id = ?')
      .run(newStatus, req.params.id);

    res.json({
      success: true,
      message: newStatus === 'active' ? '许可证已启用' : '许可证已禁用',
      status: newStatus
    });
  } catch (err) {
    console.error('切换许可证状态失败:', err);
    res.status(500).json({ error: '操作失败' });
  }
});

// 删除激活码
app.delete('/api/admin/codes/:id', adminMiddleware, (req, res) => {
  try {
    const code = db.prepare('SELECT * FROM activation_codes WHERE id = ?').get(req.params.id);
    if (!code) {
      return res.status(404).json({ error: '激活码不存在' });
    }

    if (code.used_count > 0) {
      return res.status(400).json({ error: '已使用的激活码不能删除' });
    }

    db.prepare('DELETE FROM activation_codes WHERE id = ?').run(req.params.id);
    res.json({ success: true, message: '激活码已删除' });
  } catch (err) {
    console.error('删除激活码失败:', err);
    res.status(500).json({ error: '删除失败' });
  }
});

// 获取激活码（支持分页和筛选）
app.get('/api/admin/codes', adminMiddleware, (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const search = req.query.search;
    const status = req.query.status; // unused, used, all

    let whereClause = '1=1';
    const params = [];

    if (search) {
      whereClause += ' AND ac.code LIKE ?';
      params.push(`%${search}%`);
    }

    if (status === 'unused') {
      whereClause += ' AND ac.used_count = 0';
    } else if (status === 'used') {
      whereClause += ' AND ac.used_count > 0';
    }

    const total = db.prepare(`
      SELECT COUNT(*) as count FROM activation_codes ac WHERE ${whereClause}
    `).get(...params).count;

    const codes = db.prepare(`
      SELECT ac.*, p.name as plan_name
      FROM activation_codes ac
      JOIN plans p ON ac.plan_id = p.id
      WHERE ${whereClause}
      ORDER BY ac.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    res.json({
      data: codes,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('获取激活码失败:', err);
    res.status(500).json({ error: '获取失败' });
  }
});

// 获取许可证（支持分页和筛选）
app.get('/api/admin/licenses', adminMiddleware, (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const search = req.query.search;
    const status = req.query.status; // active, expired, disabled

    let whereClause = '1=1';
    const params = [];

    if (search) {
      whereClause += ' AND (l.license_key LIKE ? OR u.email LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    if (status === 'active') {
      whereClause += " AND l.status = 'active' AND l.expires_at > strftime('%s', 'now')";
    } else if (status === 'expired') {
      whereClause += " AND l.expires_at <= strftime('%s', 'now')";
    } else if (status === 'disabled') {
      whereClause += " AND l.status = 'disabled'";
    }

    const total = db.prepare(`
      SELECT COUNT(*) as count
      FROM licenses l
      JOIN users u ON l.user_id = u.id
      WHERE ${whereClause}
    `).get(...params).count;

    const licenses = db.prepare(`
      SELECT l.*, p.name as plan_name, u.email,
        (SELECT COUNT(*) FROM activations WHERE license_id = l.id AND is_active = 1) as active_devices
      FROM licenses l
      JOIN plans p ON l.plan_id = p.id
      JOIN users u ON l.user_id = u.id
      WHERE ${whereClause}
      ORDER BY l.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    res.json({
      data: licenses,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('获取许可证失败:', err);
    res.status(500).json({ error: '获取失败' });
  }
});

// ============================================
// 配置管理 API
// ============================================

// 获取配置
function getConfig(key) {
  const row = db.prepare('SELECT value FROM system_config WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : null;
}

// 保存配置
function setConfig(key, value) {
  db.prepare(`
    INSERT INTO system_config (key, value, updated_at)
    VALUES (?, ?, strftime('%s', 'now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value));
}

// 加载支付配置到内存
function loadPaymentConfigFromDB() {
  const alipayConfig = getConfig('alipay');
  if (alipayConfig) {
    paymentConfig.alipay.appId = alipayConfig.appId || '';
    paymentConfig.alipay.privateKey = alipayConfig.privateKey || '';
    paymentConfig.alipay.alipayPublicKey = alipayConfig.publicKey || '';
  }

  const wechatConfig = getConfig('wechat');
  if (wechatConfig) {
    paymentConfig.wechat.mchid = wechatConfig.mchid || '';
    paymentConfig.wechat.appId = wechatConfig.appId || '';
    paymentConfig.wechat.apiKey = wechatConfig.apiKey || '';
    paymentConfig.wechat.serialNo = wechatConfig.serialNo || '';
    paymentConfig.wechat.privateKey = wechatConfig.privateKey || '';
  }
}

// 获取支付配置状态
app.get('/api/admin/config/payment', adminMiddleware, (req, res) => {
  const alipayConfig = getConfig('alipay') || {};
  const wechatConfig = getConfig('wechat') || {};

  res.json({
    alipay: {
      configured: !!(alipayConfig.appId && alipayConfig.privateKey && alipayConfig.publicKey),
      appId: alipayConfig.appId ? alipayConfig.appId.slice(0, 8) + '****' : ''
    },
    wechat: {
      configured: !!(wechatConfig.mchid && wechatConfig.apiKey && wechatConfig.serialNo && wechatConfig.privateKey),
      mchid: wechatConfig.mchid ? wechatConfig.mchid.slice(0, 6) + '****' : '',
      appId: wechatConfig.appId ? wechatConfig.appId.slice(0, 8) + '****' : ''
    }
  });
});

// 保存支付宝配置
app.post('/api/admin/config/alipay', adminMiddleware, (req, res) => {
  const { appId, privateKey, publicKey } = req.body;

  if (!appId || !privateKey || !publicKey) {
    return res.status(400).json({ error: '配置不完整' });
  }

  try {
    setConfig('alipay', { appId, privateKey, publicKey });

    // 更新内存配置
    paymentConfig.alipay.appId = appId;
    paymentConfig.alipay.privateKey = privateKey;
    paymentConfig.alipay.alipayPublicKey = publicKey;

    // 重新初始化支付宝客户端
    initAlipay();

    res.json({ success: true, message: '支付宝配置已保存' });
  } catch (err) {
    console.error('保存支付宝配置失败:', err);
    res.status(500).json({ error: '保存失败' });
  }
});

// 保存微信支付配置
app.post('/api/admin/config/wechat', adminMiddleware, (req, res) => {
  const { mchid, appId, apiKey, serialNo, privateKey } = req.body;

  if (!mchid || !apiKey || !serialNo || !privateKey) {
    return res.status(400).json({ error: '配置不完整' });
  }

  try {
    setConfig('wechat', { mchid, appId, apiKey, serialNo, privateKey });

    // 更新内存配置
    paymentConfig.wechat.mchid = mchid;
    paymentConfig.wechat.appId = appId || '';
    paymentConfig.wechat.apiKey = apiKey;
    paymentConfig.wechat.serialNo = serialNo;
    paymentConfig.wechat.privateKey = privateKey;

    // 重新初始化微信支付客户端
    initWechatPay();

    res.json({ success: true, message: '微信支付配置已保存' });
  } catch (err) {
    console.error('保存微信支付配置失败:', err);
    res.status(500).json({ error: '保存失败' });
  }
});

// ============================================
// 支付 API
// ============================================

// 生成订单号
function generateOrderNo() {
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const random = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `${paymentConfig.order.prefix}${dateStr}${random}`;
}

// 获取可用支付方式
app.get('/api/payment/methods', (req, res) => {
  const methods = [];

  if (checkAlipayConfig()) {
    methods.push({
      id: 'alipay',
      name: '支付宝',
      icon: 'alipay',
      enabled: true
    });
  }

  if (checkWechatConfig()) {
    methods.push({
      id: 'wechat',
      name: '微信支付',
      icon: 'wechat',
      enabled: true
    });
  }

  res.json(methods);
});

// 创建支付订单
app.post('/api/payment/create', async (req, res) => {
  const { planId, period, paymentMethod, machineId, email } = req.body;

  if (!planId || !period || !paymentMethod) {
    return res.status(400).json({ error: '缺少必要参数' });
  }

  if (!['monthly', 'yearly'].includes(period)) {
    return res.status(400).json({ error: '无效的订阅周期' });
  }

  if (!['alipay', 'wechat'].includes(paymentMethod)) {
    return res.status(400).json({ error: '无效的支付方式' });
  }

  try {
    // 获取计划信息
    const plan = db.prepare('SELECT * FROM plans WHERE id = ? AND is_active = 1').get(planId);
    if (!plan) {
      return res.status(400).json({ error: '无效的订阅计划' });
    }

    // 计算金额
    const amount = period === 'monthly' ? plan.price_monthly : plan.price_yearly;
    const durationDays = period === 'monthly' ? 30 : 365;

    // 创建或获取用户
    let userId;
    if (email) {
      const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      if (existingUser) {
        userId = existingUser.id;
      } else {
        userId = uuidv4();
        db.prepare('INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, ?, ?)')
          .run(userId, email, 'pending-payment', email.split('@')[0]);
      }
    } else if (machineId) {
      const deviceEmail = `device-${machineId}@whatyterm.local`;
      const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(deviceEmail);
      if (existingUser) {
        userId = existingUser.id;
      } else {
        userId = uuidv4();
        db.prepare('INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, ?, ?)')
          .run(userId, deviceEmail, 'device-user', `Device ${machineId.slice(0, 8)}`);
      }
    } else {
      userId = uuidv4();
      db.prepare('INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, ?, ?)')
        .run(userId, `guest-${userId.slice(0, 8)}@whatyterm.local`, 'guest-user', 'Guest');
    }

    // 生成订单号
    const orderNo = generateOrderNo();

    // 创建订单记录
    const orderId = uuidv4();
    db.prepare(`
      INSERT INTO orders (id, user_id, plan_id, amount, payment_method, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `).run(orderId, userId, planId, amount, paymentMethod);

    // 更新订单号
    db.prepare('UPDATE orders SET payment_id = ? WHERE id = ?').run(orderNo, orderId);

    // 订单描述
    const subject = `WhatyTerm ${plan.name} - ${period === 'monthly' ? '月付' : '年付'}`;

    // 调用支付接口
    let paymentResult;
    if (paymentMethod === 'alipay') {
      paymentResult = await createAlipayOrder(orderNo, amount, subject);
    } else {
      paymentResult = await createWechatOrder(orderNo, amount, subject);
    }

    if (!paymentResult.success) {
      // 更新订单状态为失败
      db.prepare("UPDATE orders SET status = 'failed' WHERE id = ?").run(orderId);
      return res.status(500).json({ error: paymentResult.error || '创建支付订单失败' });
    }

    // 生成二维码图片
    const qrCodeDataUrl = await QRCode.toDataURL(paymentResult.qrCode, {
      width: 256,
      margin: 2
    });

    res.json({
      success: true,
      orderNo: orderNo,
      orderId: orderId,
      amount: amount,
      qrCode: paymentResult.qrCode,
      qrCodeImage: qrCodeDataUrl,
      paymentMethod: paymentMethod,
      expireMinutes: paymentConfig.order.expireMinutes,
      plan: {
        id: plan.id,
        name: plan.name,
        period: period,
        durationDays: durationDays
      }
    });
  } catch (err) {
    console.error('创建支付订单失败:', err);
    res.status(500).json({ error: '创建订单失败' });
  }
});

// 查询订单状态
app.get('/api/payment/status/:orderNo', async (req, res) => {
  const { orderNo } = req.params;

  try {
    // 查询本地订单
    const order = db.prepare(`
      SELECT o.*, p.name as plan_name, p.max_devices, u.email
      FROM orders o
      JOIN plans p ON o.plan_id = p.id
      JOIN users u ON o.user_id = u.id
      WHERE o.payment_id = ?
    `).get(orderNo);

    if (!order) {
      return res.status(404).json({ error: '订单不存在' });
    }

    // 如果订单已完成，直接返回
    if (order.status === 'paid') {
      const license = db.prepare(`
        SELECT * FROM licenses WHERE user_id = ? ORDER BY created_at DESC LIMIT 1
      `).get(order.user_id);

      return res.json({
        success: true,
        status: 'paid',
        order: {
          orderNo: orderNo,
          amount: order.amount,
          planName: order.plan_name,
          paidAt: order.paid_at
        },
        license: license ? {
          key: license.license_key,
          expiresAt: new Date(license.expires_at * 1000).toISOString()
        } : null
      });
    }

    // 查询支付平台订单状态
    let paymentStatus;
    if (order.payment_method === 'alipay') {
      paymentStatus = await queryAlipayOrder(orderNo);
    } else {
      paymentStatus = await queryWechatOrder(orderNo);
    }

    if (!paymentStatus.success) {
      return res.json({
        success: true,
        status: order.status,
        order: {
          orderNo: orderNo,
          amount: order.amount,
          planName: order.plan_name
        }
      });
    }

    // 检查是否已支付
    const isPaid = order.payment_method === 'alipay'
      ? paymentStatus.tradeStatus === 'TRADE_SUCCESS'
      : paymentStatus.tradeState === 'SUCCESS';

    if (isPaid && order.status !== 'paid') {
      // 处理支付成功
      await handlePaymentSuccess(order, paymentStatus);

      const license = db.prepare(`
        SELECT * FROM licenses WHERE user_id = ? ORDER BY created_at DESC LIMIT 1
      `).get(order.user_id);

      return res.json({
        success: true,
        status: 'paid',
        order: {
          orderNo: orderNo,
          amount: order.amount,
          planName: order.plan_name,
          paidAt: Math.floor(Date.now() / 1000)
        },
        license: license ? {
          key: license.license_key,
          expiresAt: new Date(license.expires_at * 1000).toISOString()
        } : null
      });
    }

    res.json({
      success: true,
      status: order.status,
      order: {
        orderNo: orderNo,
        amount: order.amount,
        planName: order.plan_name
      }
    });
  } catch (err) {
    console.error('查询订单状态失败:', err);
    res.status(500).json({ error: '查询失败' });
  }
});

// 处理支付成功
async function handlePaymentSuccess(order, paymentStatus) {
  const now = Math.floor(Date.now() / 1000);

  // 更新订单状态
  db.prepare(`
    UPDATE orders SET status = 'paid', paid_at = ? WHERE id = ?
  `).run(now, order.id);

  // 计算订阅时长
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(order.plan_id);
  const durationDays = order.amount === plan.price_monthly ? 30 : 365;
  const expiresAt = now + (durationDays * 24 * 60 * 60);

  // 创建许可证
  const licenseId = uuidv4();
  const licenseKey = generateLicenseKey();

  db.prepare(`
    INSERT INTO licenses (id, user_id, plan_id, license_key, expires_at, max_devices)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(licenseId, order.user_id, order.plan_id, licenseKey, expiresAt, plan.max_devices);

  console.log(`订单 ${order.payment_id} 支付成功，已创建许可证 ${licenseKey}`);

  // 发送订单确认邮件
  try {
    const user = db.prepare('SELECT email FROM users WHERE id = ?').get(order.user_id);
    if (user && user.email && !user.email.includes('@whatyterm.local')) {
      await sendOrderConfirmationEmail(user.email, {
        orderId: order.payment_id,
        planName: plan.name,
        period: order.amount === plan.price_monthly ? 'monthly' : 'yearly',
        amount: order.amount,
        expiresAt: new Date(expiresAt * 1000).toISOString(),
        licenseKey: licenseKey
      });
    }
  } catch (emailErr) {
    console.error('发送订单确认邮件失败:', emailErr.message);
  }
}

// 支付宝异步通知
app.post('/api/payment/alipay/notify', express.urlencoded({ extended: true }), async (req, res) => {
  console.log('收到支付宝回调:', req.body);

  try {
    // 验证签名
    if (!verifyAlipayNotify(req.body)) {
      console.error('支付宝签名验证失败');
      return res.send('fail');
    }

    const { out_trade_no, trade_status, trade_no } = req.body;

    // 查询订单
    const order = db.prepare(`
      SELECT o.*, p.max_devices
      FROM orders o
      JOIN plans p ON o.plan_id = p.id
      WHERE o.payment_id = ?
    `).get(out_trade_no);

    if (!order) {
      console.error('订单不存在:', out_trade_no);
      return res.send('fail');
    }

    // 检查交易状态
    if (trade_status === 'TRADE_SUCCESS' || trade_status === 'TRADE_FINISHED') {
      if (order.status !== 'paid') {
        await handlePaymentSuccess(order, { tradeNo: trade_no });
      }
    }

    res.send('success');
  } catch (err) {
    console.error('处理支付宝回调失败:', err);
    res.send('fail');
  }
});

// 微信支付异步通知
app.post('/api/payment/wechat/notify', express.raw({ type: 'application/json' }), async (req, res) => {
  console.log('收到微信支付回调');

  try {
    const body = JSON.parse(req.body.toString());

    // 验证签名并解密
    const verifyResult = verifyWechatNotify(req.headers, body);
    if (!verifyResult.success) {
      console.error('微信支付签名验证失败:', verifyResult.error);
      return res.status(400).json({ code: 'FAIL', message: verifyResult.error });
    }

    const { out_trade_no, trade_state, transaction_id } = verifyResult.data;

    // 查询订单
    const order = db.prepare(`
      SELECT o.*, p.max_devices
      FROM orders o
      JOIN plans p ON o.plan_id = p.id
      WHERE o.payment_id = ?
    `).get(out_trade_no);

    if (!order) {
      console.error('订单不存在:', out_trade_no);
      return res.status(404).json({ code: 'FAIL', message: '订单不存在' });
    }

    // 检查交易状态
    if (trade_state === 'SUCCESS') {
      if (order.status !== 'paid') {
        await handlePaymentSuccess(order, { transactionId: transaction_id });
      }
    }

    res.json({ code: 'SUCCESS', message: '成功' });
  } catch (err) {
    console.error('处理微信支付回调失败:', err);
    res.status(500).json({ code: 'FAIL', message: '处理失败' });
  }
});

// 取消订单
app.post('/api/payment/cancel/:orderNo', async (req, res) => {
  const { orderNo } = req.params;

  try {
    const order = db.prepare("SELECT * FROM orders WHERE payment_id = ? AND status = 'pending'").get(orderNo);

    if (!order) {
      return res.status(404).json({ error: '订单不存在或已处理' });
    }

    // 关闭支付平台订单
    if (order.payment_method === 'alipay') {
      await closeAlipayOrder(orderNo);
    } else {
      await closeWechatOrder(orderNo);
    }

    // 更新订单状态
    db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(order.id);

    res.json({ success: true, message: '订单已取消' });
  } catch (err) {
    console.error('取消订单失败:', err);
    res.status(500).json({ error: '取消失败' });
  }
});

// 前端页面
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 支付结果页面
app.get('/payment/result', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'payment-result.html'));
});

// 管理后台页面
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// 从数据库加载支付配置
loadPaymentConfigFromDB();

// 初始化支付服务
initAlipay();
initWechatPay();

// 启动服务器
app.listen(PORT, () => {
  console.log(`WhatyTerm 订阅服务器运行在 http://localhost:${PORT}`);
  console.log(`支付宝支付: ${checkAlipayConfig() ? '已启用' : '未配置'}`);
  console.log(`微信支付: ${checkWechatConfig() ? '已启用' : '未配置'}`);
});

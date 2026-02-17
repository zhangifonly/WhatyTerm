/**
 * 邮件服务模块
 * 使用 Nodemailer 发送邮件，支持密码重置和订单通知
 */

import nodemailer from 'nodemailer';

// 邮件配置 - 使用 LAX02 邮件服务器
const EMAIL_CONFIG = {
  host: process.env.SMTP_HOST || 'mail.whaty.org',
  port: parseInt(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === 'true', // 587 端口使用 STARTTLS
  auth: {
    user: process.env.SMTP_USER || 'noreply@whaty.org',
    pass: process.env.SMTP_PASS || ''
  },
  tls: {
    rejectUnauthorized: false // 允许自签名证书
  }
};

// 发件人信息
const FROM_EMAIL = process.env.FROM_EMAIL || 'WhatyTerm <noreply@whaty.org>';
const BASE_URL = process.env.BASE_URL || 'https://term.whaty.org';

// 创建邮件传输器
let transporter = null;

/**
 * 初始化邮件服务
 */
function initEmailService() {
  // 如果没有配置 SMTP 密码，使用测试模式
  if (!EMAIL_CONFIG.auth.pass) {
    console.log('[EmailService] SMTP 密码未配置，使用测试模式（仅记录日志）');
    return null;
  }

  transporter = nodemailer.createTransport(EMAIL_CONFIG);

  // 验证连接
  transporter.verify((error) => {
    if (error) {
      console.error('[EmailService] SMTP 连接验证失败:', error.message);
      transporter = null;
    } else {
      console.log('[EmailService] SMTP 连接验证成功');
    }
  });

  return transporter;
}

/**
 * 发送邮件
 * @param {Object} options - 邮件选项
 * @param {string} options.to - 收件人邮箱
 * @param {string} options.subject - 邮件主题
 * @param {string} options.html - HTML 内容
 * @param {string} [options.text] - 纯文本内容（可选）
 * @returns {Promise<boolean>} 是否发送成功
 */
async function sendEmail({ to, subject, html, text }) {
  if (!transporter) {
    console.log(`[EmailService] 测试模式 - 邮件内容:`);
    console.log(`  收件人: ${to}`);
    console.log(`  主题: ${subject}`);
    console.log(`  内容: ${text || html.replace(/<[^>]+>/g, ' ').slice(0, 200)}...`);
    return true;
  }

  try {
    const info = await transporter.sendMail({
      from: FROM_EMAIL,
      to,
      subject,
      html,
      text: text || html.replace(/<[^>]+>/g, ' ')
    });

    console.log(`[EmailService] 邮件发送成功: ${info.messageId} -> ${to}`);
    return true;
  } catch (error) {
    console.error(`[EmailService] 邮件发送失败: ${error.message}`);
    return false;
  }
}

/**
 * 发送密码重置邮件
 * @param {string} email - 收件人邮箱
 * @param {string} resetToken - 重置令牌
 * @param {string} [userName] - 用户名（可选）
 * @returns {Promise<boolean>}
 */
async function sendPasswordResetEmail(email, resetToken, userName) {
  const resetUrl = `${BASE_URL}/reset-password.html?token=${resetToken}`;
  const displayName = userName || email.split('@')[0];

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
    .content { background: #f8f9fa; padding: 30px; border-radius: 0 0 8px 8px; }
    .button { display: inline-block; background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; margin: 20px 0; }
    .footer { text-align: center; color: #666; font-size: 12px; margin-top: 20px; }
    .warning { background: #fff3cd; border: 1px solid #ffeeba; padding: 10px; border-radius: 4px; margin: 15px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>WhatyTerm</h1>
      <p>密码重置请求</p>
    </div>
    <div class="content">
      <p>您好，${displayName}！</p>
      <p>我们收到了您的密码重置请求。请点击下面的按钮重置您的密码：</p>
      <p style="text-align: center;">
        <a href="${resetUrl}" class="button">重置密码</a>
      </p>
      <p>或者复制以下链接到浏览器：</p>
      <p style="word-break: break-all; background: #e9ecef; padding: 10px; border-radius: 4px; font-size: 12px;">${resetUrl}</p>
      <div class="warning">
        <strong>注意：</strong>此链接将在 1 小时后失效。如果您没有请求重置密码，请忽略此邮件。
      </div>
    </div>
    <div class="footer">
      <p>此邮件由 WhatyTerm 自动发送，请勿回复。</p>
      <p>&copy; ${new Date().getFullYear()} WhatyTerm. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;

  return sendEmail({
    to: email,
    subject: '[WhatyTerm] 密码重置请求',
    html
  });
}

/**
 * 发送订单确认邮件
 * @param {string} email - 收件人邮箱
 * @param {Object} order - 订单信息
 * @returns {Promise<boolean>}
 */
async function sendOrderConfirmationEmail(email, order) {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #28a745 0%, #20c997 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
    .content { background: #f8f9fa; padding: 30px; border-radius: 0 0 8px 8px; }
    .order-info { background: white; padding: 20px; border-radius: 8px; margin: 20px 0; }
    .order-info table { width: 100%; border-collapse: collapse; }
    .order-info td { padding: 10px 0; border-bottom: 1px solid #eee; }
    .order-info td:last-child { text-align: right; font-weight: bold; }
    .total { font-size: 18px; color: #28a745; }
    .footer { text-align: center; color: #666; font-size: 12px; margin-top: 20px; }
    .button { display: inline-block; background: #28a745; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; margin: 20px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>订单确认</h1>
      <p>感谢您的购买！</p>
    </div>
    <div class="content">
      <p>您好！</p>
      <p>您的 WhatyTerm 订阅订单已支付成功。以下是订单详情：</p>

      <div class="order-info">
        <table>
          <tr>
            <td>订单号</td>
            <td>${order.orderId}</td>
          </tr>
          <tr>
            <td>订阅方案</td>
            <td>${order.planName}</td>
          </tr>
          <tr>
            <td>订阅周期</td>
            <td>${order.period === 'yearly' ? '年付' : '月付'}</td>
          </tr>
          <tr>
            <td>有效期至</td>
            <td>${new Date(order.expiresAt).toLocaleDateString('zh-CN')}</td>
          </tr>
          <tr>
            <td>支付金额</td>
            <td class="total">¥${(order.amount / 100).toFixed(2)}</td>
          </tr>
        </table>
      </div>

      ${order.licenseKey ? `
      <p><strong>许可证密钥：</strong></p>
      <p style="word-break: break-all; background: #e9ecef; padding: 15px; border-radius: 4px; font-family: monospace; font-size: 14px;">${order.licenseKey}</p>
      <p style="color: #666; font-size: 12px;">请妥善保管此密钥，激活时需要使用。</p>
      ` : ''}

      <p style="text-align: center;">
        <a href="${BASE_URL}/user.html" class="button">查看我的订阅</a>
      </p>
    </div>
    <div class="footer">
      <p>如有问题，请联系客服。</p>
      <p>&copy; ${new Date().getFullYear()} WhatyTerm. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;

  return sendEmail({
    to: email,
    subject: `[WhatyTerm] 订单确认 - ${order.planName}`,
    html
  });
}

/**
 * 发送新用户欢迎邮件（包含设置密码链接和许可证信息）
 * @param {string} email - 收件人邮箱
 * @param {Object} order - 订单信息
 * @returns {Promise<boolean>}
 */
async function sendWelcomeEmail(email, order) {
  const setPasswordUrl = `${BASE_URL}/reset-password.html?token=${order.resetToken}`;
  const displayName = email.split('@')[0];

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
    .content { background: #f8f9fa; padding: 30px; border-radius: 0 0 8px 8px; }
    .order-info { background: white; padding: 20px; border-radius: 8px; margin: 20px 0; }
    .order-info table { width: 100%; border-collapse: collapse; }
    .order-info td { padding: 10px 0; border-bottom: 1px solid #eee; }
    .order-info td:last-child { text-align: right; font-weight: bold; }
    .total { font-size: 18px; color: #28a745; }
    .footer { text-align: center; color: #666; font-size: 12px; margin-top: 20px; }
    .button { display: inline-block; background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; margin: 10px 5px; }
    .button-green { background: #28a745; }
    .important-box { background: #e7f3ff; border: 1px solid #b3d7ff; padding: 20px; border-radius: 8px; margin: 20px 0; }
    .license-key { word-break: break-all; background: #e9ecef; padding: 15px; border-radius: 4px; font-family: monospace; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>欢迎使用 WhatyTerm！</h1>
      <p>您的订阅已激活</p>
    </div>
    <div class="content">
      <p>您好，${displayName}！</p>
      <p>感谢您购买 WhatyTerm 订阅！您的订单已支付成功。</p>

      <div class="important-box">
        <h3 style="margin-top: 0; color: #0066cc;">⚠️ 重要：请设置您的登录密码</h3>
        <p>为了能够登录用户中心管理您的订阅和设备，请点击下方按钮设置密码：</p>
        <p style="text-align: center;">
          <a href="${setPasswordUrl}" class="button">设置密码</a>
        </p>
        <p style="font-size: 12px; color: #666;">此链接 7 天内有效。设置密码后，您可以使用邮箱 ${email} 登录。</p>
      </div>

      <div class="order-info">
        <h3 style="margin-top: 0;">订单详情</h3>
        <table>
          <tr>
            <td>订单号</td>
            <td>${order.orderId}</td>
          </tr>
          <tr>
            <td>订阅方案</td>
            <td>${order.planName}</td>
          </tr>
          <tr>
            <td>订阅周期</td>
            <td>${order.period === 'yearly' ? '年付' : '月付'}</td>
          </tr>
          <tr>
            <td>有效期至</td>
            <td>${new Date(order.expiresAt).toLocaleDateString('zh-CN')}</td>
          </tr>
          <tr>
            <td>支付金额</td>
            <td class="total">¥${(order.amount / 100).toFixed(2)}</td>
          </tr>
        </table>
      </div>

      ${order.licenseKey ? `
      <p><strong>许可证密钥：</strong></p>
      <p class="license-key">${order.licenseKey}</p>
      <p style="color: #666; font-size: 12px;">请妥善保管此密钥，在 WhatyTerm 客户端激活时需要使用。</p>
      ` : ''}

      <p style="text-align: center; margin-top: 30px;">
        <a href="${setPasswordUrl}" class="button">设置密码</a>
        <a href="${BASE_URL}/user.html" class="button button-green">用户中心</a>
      </p>
    </div>
    <div class="footer">
      <p>如有问题，请联系 zhangzhen@gmail.com</p>
      <p>&copy; ${new Date().getFullYear()} WhatyTerm. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;

  return sendEmail({
    to: email,
    subject: `[WhatyTerm] 欢迎！请设置您的登录密码`,
    html
  });
}

/**
 * 发送许可证即将过期提醒
 * @param {string} email - 收件人邮箱
 * @param {Object} license - 许可证信息
 * @returns {Promise<boolean>}
 */
async function sendLicenseExpiryReminder(email, license) {
  const expiresDate = new Date(license.expiresAt);
  const daysLeft = Math.ceil((expiresDate - new Date()) / (1000 * 60 * 60 * 24));

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #ffc107 0%, #ff9800 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
    .content { background: #f8f9fa; padding: 30px; border-radius: 0 0 8px 8px; }
    .warning-box { background: #fff3cd; border: 1px solid #ffeeba; padding: 20px; border-radius: 8px; margin: 20px 0; text-align: center; }
    .days-left { font-size: 48px; font-weight: bold; color: #ff9800; }
    .footer { text-align: center; color: #666; font-size: 12px; margin-top: 20px; }
    .button { display: inline-block; background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; margin: 20px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>订阅即将到期</h1>
      <p>续费提醒</p>
    </div>
    <div class="content">
      <p>您好！</p>
      <p>您的 WhatyTerm ${license.planName} 订阅即将到期。</p>

      <div class="warning-box">
        <p>距离到期还有</p>
        <div class="days-left">${daysLeft}</div>
        <p>天</p>
        <p style="font-size: 12px; color: #666;">到期日期：${expiresDate.toLocaleDateString('zh-CN')}</p>
      </div>

      <p>为了不影响您的正常使用，建议您及时续费。续费后，您的订阅有效期将自动延长。</p>

      <p style="text-align: center;">
        <a href="${BASE_URL}/#pricing" class="button">立即续费</a>
      </p>
    </div>
    <div class="footer">
      <p>此邮件由 WhatyTerm 自动发送，请勿回复。</p>
      <p>&copy; ${new Date().getFullYear()} WhatyTerm. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;

  return sendEmail({
    to: email,
    subject: `[WhatyTerm] 您的订阅将在 ${daysLeft} 天后到期`,
    html
  });
}

// 初始化
initEmailService();

export {
  initEmailService,
  sendEmail,
  sendPasswordResetEmail,
  sendOrderConfirmationEmail,
  sendWelcomeEmail,
  sendLicenseExpiryReminder
};

// 微信支付服务
import WxPay from 'wechatpay-node-v3';
import { paymentConfig, checkWechatConfig } from '../config/payment.js';
import fs from 'fs';
import path from 'path';

let wxpayClient = null;

// 初始化微信支付客户端
export function initWechatPay() {
  if (!checkWechatConfig()) {
    console.warn('微信支付配置不完整，微信支付功能不可用');
    return false;
  }

  try {
    // 读取私钥文件（如果是文件路径）
    let privateKey = paymentConfig.wechat.privateKey;
    if (privateKey && !privateKey.includes('-----BEGIN')) {
      // 可能是文件路径
      if (fs.existsSync(privateKey)) {
        privateKey = fs.readFileSync(privateKey, 'utf8');
      }
    }

    wxpayClient = new WxPay({
      appid: paymentConfig.wechat.appId,
      mchid: paymentConfig.wechat.mchid,
      publicKey: paymentConfig.wechat.platformCert || '',
      privateKey: privateKey,
      key: paymentConfig.wechat.apiKey
    });

    console.log('微信支付客户端初始化成功');
    return true;
  } catch (err) {
    console.error('微信支付客户端初始化失败:', err);
    return false;
  }
}

// 创建微信支付 Native 订单（扫码支付）
export async function createWechatOrder(orderNo, amount, description) {
  if (!wxpayClient) {
    throw new Error('微信支付客户端未初始化');
  }

  try {
    const params = {
      appid: paymentConfig.wechat.appId,
      mchid: paymentConfig.wechat.mchid,
      description: description,
      out_trade_no: orderNo,
      notify_url: paymentConfig.wechat.notifyUrl,
      amount: {
        total: amount, // 单位：分
        currency: 'CNY'
      },
      time_expire: getExpireTime()
    };

    const result = await wxpayClient.transactions_native(params);

    if (result.status === 200 && result.code_url) {
      return {
        success: true,
        qrCode: result.code_url,
        orderNo: orderNo
      };
    } else {
      return {
        success: false,
        error: result.message || '创建订单失败'
      };
    }
  } catch (err) {
    console.error('创建微信支付订单失败:', err);
    return {
      success: false,
      error: err.message
    };
  }
}

// 查询微信支付订单状态
export async function queryWechatOrder(orderNo) {
  if (!wxpayClient) {
    throw new Error('微信支付客户端未初始化');
  }

  try {
    const result = await wxpayClient.query({
      out_trade_no: orderNo
    });

    if (result.status === 200) {
      return {
        success: true,
        tradeState: result.trade_state,
        tradeStateDesc: result.trade_state_desc,
        transactionId: result.transaction_id,
        amount: result.amount?.total
      };
    } else {
      return {
        success: false,
        error: result.message || '查询失败'
      };
    }
  } catch (err) {
    console.error('查询微信支付订单失败:', err);
    return {
      success: false,
      error: err.message
    };
  }
}

// 验证微信支付回调签名
export function verifyWechatNotify(headers, body) {
  if (!wxpayClient) {
    return { success: false, error: '微信支付客户端未初始化' };
  }

  try {
    const signature = headers['wechatpay-signature'];
    const timestamp = headers['wechatpay-timestamp'];
    const nonce = headers['wechatpay-nonce'];
    const serial = headers['wechatpay-serial'];

    // 验证签名
    const verified = wxpayClient.verifySign({
      timestamp,
      nonce,
      body: typeof body === 'string' ? body : JSON.stringify(body),
      signature,
      serial
    });

    if (!verified) {
      return { success: false, error: '签名验证失败' };
    }

    // 解密通知内容
    const resource = body.resource;
    const decrypted = wxpayClient.decipher_gcm(
      resource.ciphertext,
      resource.associated_data,
      resource.nonce,
      paymentConfig.wechat.apiKey
    );

    return {
      success: true,
      data: JSON.parse(decrypted)
    };
  } catch (err) {
    console.error('验证微信支付签名失败:', err);
    return { success: false, error: err.message };
  }
}

// 关闭微信支付订单
export async function closeWechatOrder(orderNo) {
  if (!wxpayClient) {
    throw new Error('微信支付客户端未初始化');
  }

  try {
    const result = await wxpayClient.close(orderNo);
    return result.status === 204;
  } catch (err) {
    console.error('关闭微信支付订单失败:', err);
    return false;
  }
}

// 获取订单过期时间（RFC 3339 格式）
function getExpireTime() {
  const expireDate = new Date();
  expireDate.setMinutes(expireDate.getMinutes() + paymentConfig.order.expireMinutes);
  return expireDate.toISOString().replace(/\.\d{3}Z$/, '+08:00');
}

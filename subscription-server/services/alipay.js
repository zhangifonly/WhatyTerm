// 支付宝支付服务
import AlipaySdk from 'alipay-sdk';
import { paymentConfig, checkAlipayConfig } from '../config/payment.js';

let alipayClient = null;

// 初始化支付宝客户端
export function initAlipay() {
  if (!checkAlipayConfig()) {
    console.warn('支付宝配置不完整，支付宝支付功能不可用');
    return false;
  }

  try {
    alipayClient = new AlipaySdk({
      appId: paymentConfig.alipay.appId,
      privateKey: paymentConfig.alipay.privateKey,
      alipayPublicKey: paymentConfig.alipay.alipayPublicKey,
      gateway: paymentConfig.alipay.gateway,
      signType: paymentConfig.alipay.signType
    });
    console.log('支付宝客户端初始化成功');
    return true;
  } catch (err) {
    console.error('支付宝客户端初始化失败:', err);
    return false;
  }
}

// 创建支付宝当面付订单（扫码支付）
export async function createAlipayOrder(orderNo, amount, subject, body = '') {
  if (!alipayClient) {
    throw new Error('支付宝客户端未初始化');
  }

  try {
    const result = await alipayClient.exec('alipay.trade.precreate', {
      bizContent: {
        out_trade_no: orderNo,
        total_amount: (amount / 100).toFixed(2), // 转换为元
        subject: subject,
        body: body || subject,
        timeout_express: `${paymentConfig.order.expireMinutes}m`
      },
      notify_url: paymentConfig.alipay.notifyUrl
    });

    if (result.code === '10000') {
      return {
        success: true,
        qrCode: result.qrCode,
        orderNo: orderNo
      };
    } else {
      return {
        success: false,
        error: result.subMsg || result.msg || '创建订单失败'
      };
    }
  } catch (err) {
    console.error('创建支付宝订单失败:', err);
    return {
      success: false,
      error: err.message
    };
  }
}

// 查询支付宝订单状态
export async function queryAlipayOrder(orderNo) {
  if (!alipayClient) {
    throw new Error('支付宝客户端未初始化');
  }

  try {
    const result = await alipayClient.exec('alipay.trade.query', {
      bizContent: {
        out_trade_no: orderNo
      }
    });

    if (result.code === '10000') {
      return {
        success: true,
        tradeStatus: result.tradeStatus,
        tradeNo: result.tradeNo,
        buyerPayAmount: result.buyerPayAmount,
        totalAmount: result.totalAmount
      };
    } else {
      return {
        success: false,
        error: result.subMsg || result.msg || '查询失败'
      };
    }
  } catch (err) {
    console.error('查询支付宝订单失败:', err);
    return {
      success: false,
      error: err.message
    };
  }
}

// 验证支付宝回调签名
export function verifyAlipayNotify(params) {
  if (!alipayClient) {
    return false;
  }

  try {
    return alipayClient.checkNotifySign(params);
  } catch (err) {
    console.error('验证支付宝签名失败:', err);
    return false;
  }
}

// 关闭支付宝订单
export async function closeAlipayOrder(orderNo) {
  if (!alipayClient) {
    throw new Error('支付宝客户端未初始化');
  }

  try {
    const result = await alipayClient.exec('alipay.trade.close', {
      bizContent: {
        out_trade_no: orderNo
      }
    });

    return result.code === '10000';
  } catch (err) {
    console.error('关闭支付宝订单失败:', err);
    return false;
  }
}

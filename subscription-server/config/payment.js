// 支付配置
// 注意：生产环境中这些值应该从环境变量读取

export const paymentConfig = {
  // 支付宝配置
  alipay: {
    // 应用 ID
    appId: process.env.ALIPAY_APP_ID || '',
    // 应用私钥（PKCS1 格式）
    privateKey: process.env.ALIPAY_PRIVATE_KEY || '',
    // 支付宝公钥
    alipayPublicKey: process.env.ALIPAY_PUBLIC_KEY || '',
    // 网关地址（正式环境）
    gateway: 'https://openapi.alipay.com/gateway.do',
    // 签名类型
    signType: 'RSA2',
    // 回调地址
    notifyUrl: process.env.ALIPAY_NOTIFY_URL || 'https://term.whaty.org/api/payment/alipay/notify',
    // 返回地址
    returnUrl: process.env.ALIPAY_RETURN_URL || 'https://term.whaty.org/payment/result'
  },

  // 微信支付配置
  wechat: {
    // 商户号
    mchid: process.env.WECHAT_MCHID || '',
    // 商户 API 密钥 v3
    apiKey: process.env.WECHAT_API_KEY || '',
    // 商户证书序列号
    serialNo: process.env.WECHAT_SERIAL_NO || '',
    // 商户私钥（PEM 格式）
    privateKey: process.env.WECHAT_PRIVATE_KEY || '',
    // 微信支付平台证书（用于验签）
    platformCert: process.env.WECHAT_PLATFORM_CERT || '',
    // 公众号/小程序 AppID
    appId: process.env.WECHAT_APP_ID || '',
    // 回调地址
    notifyUrl: process.env.WECHAT_NOTIFY_URL || 'https://term.whaty.org/api/payment/wechat/notify'
  },

  // CBB 聚合支付配置
  cbb: {
    // 网关地址
    gatewayUrl: process.env.CBB_GATEWAY_URL || 'https://api.webtrn.cn',
    // 应用客户端 ID
    clientId: process.env.CBB_CLIENT_ID || '',
    // 应用客户端密钥
    clientSecret: process.env.CBB_CLIENT_SECRET || '',
    // 客户编号
    customerCode: process.env.CBB_CUSTOMER_CODE || '',
    // RSA 私钥（页面服务签名用，Base64 编码）
    privateKey: process.env.CBB_PRIVATE_KEY || '',
    // RSA 公钥（回调验签用，Base64 编码）
    publicKey: process.env.CBB_PUBLIC_KEY || '',
    // 回调地址
    notifyUrl: process.env.CBB_NOTIFY_URL || 'https://term.whaty.org/api/payment/cbb/notify',
    // 支付成功跳转地址
    returnUrl: process.env.CBB_RETURN_URL || 'https://term.whaty.org/payment/result'
  },

  // 订单配置
  order: {
    // 订单超时时间（分钟）
    expireMinutes: 30,
    // 订单号前缀
    prefix: 'WT'
  }
};

// 检查支付配置是否完整
export function checkAlipayConfig() {
  const { appId, privateKey, alipayPublicKey } = paymentConfig.alipay;
  return !!(appId && privateKey && alipayPublicKey);
}

export function checkWechatConfig() {
  const { mchid, apiKey, serialNo, privateKey } = paymentConfig.wechat;
  return !!(mchid && apiKey && serialNo && privateKey);
}

export function checkCBBConfig() {
  const { clientId, clientSecret, customerCode } = paymentConfig.cbb;
  return !!(clientId && clientSecret && customerCode);
}

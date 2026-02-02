/**
 * CBB 聚合支付服务 Node.js 客户端模板
 *
 * 使用方法:
 *   1. 安装依赖: npm install axios
 *   2. 配置 CLIENT_ID, CLIENT_SECRET, CUSTOMER_CODE 等参数
 *   3. 实例化 CBBPayClient 并调用相应方法
 *
 * 示例:
 *   const client = new CBBPayClient({
 *     clientId: 'your_client_id',
 *     clientSecret: 'your_client_secret',
 *     customerCode: 'your_customer_code'
 *   });
 *
 *   const result = await client.createTrade({
 *     goodName: '测试商品',
 *     amount: '0.01',
 *     outTradeNo: 'test_order_001',
 *     expireTime: '2025-12-31T23:59:59Z'
 *   });
 */

const axios = require('axios');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

class CBBPayClient {
  /**
   * 初始化客户端
   * @param {Object} config 配置对象
   * @param {string} config.clientId 应用客户端ID
   * @param {string} config.clientSecret 应用客户端密钥
   * @param {string} config.customerCode 客户编号
   * @param {string} [config.gatewayUrl] 网关地址，默认 https://api.webtrn.cn
   * @param {string} [config.privateKey] RSA私钥（页面服务签名用，Base64编码）
   * @param {string} [config.publicKey] RSA公钥（回调验签用，Base64编码）
   */
  constructor(config) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.customerCode = config.customerCode;
    this.gatewayUrl = (config.gatewayUrl || 'https://api.webtrn.cn').replace(/\/$/, '');
    this.privateKey = config.privateKey || null;
    this.publicKey = config.publicKey || null;
    this._accessToken = null;
    this._tokenExpiresAt = 0;
  }

  /**
   * 获取访问令牌
   * @param {boolean} [forceRefresh=false] 是否强制刷新
   * @returns {Promise<string>} 访问令牌
   */
  async getAccessToken(forceRefresh = false) {
    // 检查缓存的 token 是否有效
    if (!forceRefresh && this._accessToken && Date.now() < this._tokenExpiresAt) {
      return this._accessToken;
    }

    const url = `${this.gatewayUrl}/auth/v2/security/oauth/token`;
    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret
    });

    const response = await axios.post(url, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    this._accessToken = response.data.access_token;
    // 提前 5 分钟过期
    this._tokenExpiresAt = Date.now() + (response.data.expires_in || 7200) * 1000 - 300000;

    return this._accessToken;
  }

  /**
   * 获取 API 请求头
   * @returns {Promise<Object>} 请求头对象
   */
  async _getHeaders() {
    return {
      'Authorization': `Bearer ${await this.getAccessToken()}`,
      'x-cbb-client-customer': this.customerCode,
      'x-cbb-client-type': 'api',
      'Content-Type': 'application/json'
    };
  }

  /**
   * 调用 API
   * @param {string} method HTTP 方法
   * @param {string} path API 路径
   * @param {Object} [data] 请求体数据
   * @param {Object} [params] 查询参数
   * @returns {Promise<Object>} API 响应数据
   */
  async _callApi(method, path, data = null, params = null) {
    const url = `${this.gatewayUrl}${path}`;
    const headers = await this._getHeaders();

    try {
      const response = await axios({
        method,
        url,
        headers,
        data,
        params
      });
      return response.data;
    } catch (error) {
      // 处理 401 错误（token 过期）
      if (error.response && error.response.status === 401) {
        await this.getAccessToken(true);
        const newHeaders = await this._getHeaders();
        const response = await axios({
          method,
          url,
          headers: newHeaders,
          data,
          params
        });
        return response.data;
      }
      throw error;
    }
  }

  // ==================== 订单接口 ====================

  /**
   * 创建订单
   * @param {Object} options 订单参数
   * @param {string} options.goodName 商品名称
   * @param {string} options.amount 订单金额（元）
   * @param {string} options.outTradeNo 业务订单号
   * @param {string} options.expireTime 过期时间，UTC格式
   * @param {string} [options.businessParams] 业务参数，JSON字符串
   * @returns {Promise<Object>} 订单信息
   */
  async createTrade({ goodName, amount, outTradeNo, expireTime, businessParams }) {
    const data = {
      goodName,
      totalNumber: amount,
      outTradeNo,
      expireTime
    };
    if (businessParams) {
      data.businessParams = businessParams;
    }
    return this._callApi('POST', '/api/v2/pay/trade', data);
  }

  /**
   * 查询订单
   * @param {string} tradeNo CBB系统订单号
   * @param {boolean} [includeThirdPayData=false] 是否包含第三方支付数据
   * @returns {Promise<Object>} 订单信息
   */
  async queryTrade(tradeNo, includeThirdPayData = false) {
    const params = includeThirdPayData ? { includeThirdPayData: 'true' } : null;
    return this._callApi('GET', `/api/v2/pay/trade/${tradeNo}`, null, params);
  }

  /**
   * 根据业务订单号查询订单
   * @param {string} outTradeNo 业务订单号
   * @param {string} createDate 订单创建日期，格式：yyyyMMdd
   * @returns {Promise<Object>} 订单信息
   */
  async queryTradeByOutTradeNo(outTradeNo, createDate) {
    return this._callApi('POST', '/api/v2/pay/trade/outTradeNo', { outTradeNo, createDate });
  }

  // ==================== 退款接口 ====================

  /**
   * 申请退款
   * @param {Object} options 退款参数
   * @param {string} options.tradeNo CBB系统订单号
   * @param {string} options.refundAmount 退款金额
   * @param {string} options.outRequestNo 退款请求号
   * @param {string} options.refundReason 退款原因
   * @returns {Promise<Object>} 退款申请结果
   */
  async applyRefund({ tradeNo, refundAmount, outRequestNo, refundReason }) {
    return this._callApi('POST', '/api/v2/pay/refund/apply', {
      tradeNo,
      refundAmount,
      outRequestNo,
      refundReason
    });
  }

  /**
   * 查询退款结果
   * @param {string} tradeNo CBB系统订单号
   * @param {string} outRequestNo 退款请求号
   * @returns {Promise<Object>} 退款结果
   */
  async queryRefund(tradeNo, outRequestNo) {
    return this._callApi('GET', `/api/v2/pay/refund/query/${tradeNo}/${outRequestNo}`);
  }

  // ==================== 支付辅助接口 ====================

  /**
   * 获取支付二维码
   * @param {string} tradeNo CBB系统订单号
   * @param {string} [payThird='WE_CHAT'] 第三方支付类型
   * @returns {Promise<Object>} 二维码信息
   */
  async getQrCode(tradeNo, payThird = 'WE_CHAT') {
    return this._callApi('GET', `/api/v2/pay/trade/qrCode/${payThird}/${tradeNo}`);
  }

  /**
   * 获取支付渠道列表
   * @param {string} environment 支付环境
   * @returns {Promise<Object>} 支付渠道列表
   */
  async getChannel(environment) {
    return this._callApi('GET', `/api/v2/pay/trade/channel/${environment}`);
  }

  /**
   * 获取微信小程序支付参数
   * @param {string} tradeNo CBB系统订单号
   * @param {string} openId 用户openId
   * @returns {Promise<Object>} 小程序支付参数
   */
  async getWxMiniProgramParam(tradeNo, openId) {
    return this._callApi('GET', `/api/v2/pay/trade/getWxMiniProgramParam/${tradeNo}/${openId}`);
  }

  // ==================== 页面服务 ====================

  /**
   * 构建PC端支付页面URL
   * @param {string} tradeNo CBB系统订单号
   * @param {string} [turnUrl] 支付成功跳转地址
   * @returns {string} 支付页面URL
   */
  buildPcPayUrl(tradeNo, turnUrl = null) {
    if (!this.privateKey) {
      throw new Error('需要配置 privateKey 才能使用页面服务');
    }

    const params = {
      client_id: this.clientId,
      tradeNo,
      nonceStr: uuidv4().replace(/-/g, ''),
      timeStamp: Date.now().toString(),
      charset: 'utf-8'
    };
    if (turnUrl) {
      params.turnUrl = turnUrl;
    }

    return this._buildPageUrl('/page/v2/pay/trade/pc/toPay', params);
  }

  /**
   * 构建移动端H5支付页面URL
   * @param {string} tradeNo CBB系统订单号
   * @param {string} [turnUrl] 支付成功跳转地址
   * @param {string} [quitUrl] 取消支付跳转地址
   * @returns {string} 支付页面URL
   */
  buildWapPayUrl(tradeNo, turnUrl = null, quitUrl = null) {
    if (!this.privateKey) {
      throw new Error('需要配置 privateKey 才能使用页面服务');
    }

    const params = {
      client_id: this.clientId,
      tradeNo,
      nonceStr: uuidv4().replace(/-/g, ''),
      timeStamp: Date.now().toString(),
      charset: 'utf-8'
    };
    if (turnUrl) params.turnUrl = turnUrl;
    if (quitUrl) params.quitUrl = quitUrl;

    return this._buildPageUrl('/page/v2/pay/trade/wap/toPay', params);
  }

  /**
   * 构建带签名的页面URL
   * @private
   */
  _buildPageUrl(path, params) {
    // 计算签名
    const sign = this._signParams(params);

    // 构建 URL（双重 URL 编码）
    const queryParts = Object.entries(params)
      .filter(([k, v]) => k && v)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${encodeURIComponent(encodeURIComponent(v))}`);

    queryParts.push(`sign=${encodeURIComponent(encodeURIComponent(sign))}`);

    return `${this.gatewayUrl}${path}?${queryParts.join('&')}`;
  }

  /**
   * 对参数进行 RSA 签名
   * @private
   */
  _signParams(params) {
    // 构造签名内容
    const content = Object.entries(params)
      .filter(([k, v]) => k && v)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');

    // 构造 PEM 格式私钥
    const privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${this.privateKey}\n-----END PRIVATE KEY-----`;

    // 计算签名
    const sign = crypto.createSign('SHA256');
    sign.update(content, 'utf8');
    return sign.sign(privateKeyPem, 'base64');
  }

  // ==================== 回调验签 ====================

  /**
   * 验证回调签名
   * @param {Object} params 回调参数对象（包含 sign 字段）
   * @returns {boolean} 验证是否通过
   */
  verifyCallback(params) {
    if (!this.publicKey) {
      throw new Error('需要配置 publicKey 才能验证回调签名');
    }

    // 取出签名
    const paramsCopy = { ...params };
    const sign = paramsCopy.sign;
    delete paramsCopy.sign;

    if (!sign) {
      return false;
    }

    // 构造签名内容
    const content = Object.entries(paramsCopy)
      .filter(([k, v]) => k && v)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');

    // 构造 PEM 格式公钥
    const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${this.publicKey}\n-----END PUBLIC KEY-----`;

    // 验证签名
    try {
      const verify = crypto.createVerify('SHA256');
      verify.update(content, 'utf8');
      return verify.verify(publicKeyPem, sign, 'base64');
    } catch (e) {
      return false;
    }
  }
}

module.exports = CBBPayClient;

// ==================== 使用示例 ====================

async function main() {
  // 配置信息（请替换为实际值）
  const config = {
    clientId: 'your_client_id',
    clientSecret: 'your_client_secret',
    customerCode: 'your_customer_code',
    privateKey: null, // 可选，页面服务需要
    publicKey: null   // 可选，回调验签需要
  };

  const client = new CBBPayClient(config);

  try {
    // 创建订单
    const expireTime = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const outTradeNo = `test_${Date.now()}`;

    const result = await client.createTrade({
      goodName: '测试商品',
      amount: '0.01',
      outTradeNo,
      expireTime,
      businessParams: JSON.stringify({ test: true })
    });

    console.log('创建订单结果:', JSON.stringify(result, null, 2));

    if (result.success) {
      const tradeNo = result.data.tradeNo;

      // 查询订单
      const queryResult = await client.queryTrade(tradeNo);
      console.log('查询订单结果:', JSON.stringify(queryResult, null, 2));

      // 获取二维码
      const qrResult = await client.getQrCode(tradeNo, 'WE_CHAT');
      console.log('二维码结果:', JSON.stringify(qrResult, null, 2));
    }
  } catch (error) {
    console.error('操作失败:', error.message);
  }
}

// 如果直接运行此文件
if (require.main === module) {
  main();
}

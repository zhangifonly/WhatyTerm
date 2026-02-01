/**
 * CBB 聚合支付服务客户端
 *
 * 基于 CBB 支付集成 Skill 模板实现
 * 支持页面服务方式（跳转到 CBB 支付页面）
 */

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

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
   * 检查配置是否完整
   */
  isConfigured() {
    return !!(this.clientId && this.clientSecret && this.customerCode);
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

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`获取 access_token 失败: ${response.status} ${text}`);
    }

    const data = await response.json();
    this._accessToken = data.access_token;
    // 提前 5 分钟过期
    this._tokenExpiresAt = Date.now() + (data.expires_in || 7200) * 1000 - 300000;

    console.log('[CBB] access_token 获取成功');
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
    let url = `${this.gatewayUrl}${path}`;
    if (params) {
      const searchParams = new URLSearchParams(params);
      url += `?${searchParams.toString()}`;
    }

    const headers = await this._getHeaders();

    try {
      const options = {
        method,
        headers
      };

      if (data && (method === 'POST' || method === 'PUT')) {
        options.body = JSON.stringify(data);
      }

      const response = await fetch(url, options);

      // 处理 401 错误（token 过期）
      if (response.status === 401) {
        console.log('[CBB] Token 过期，重新获取');
        await this.getAccessToken(true);
        const newHeaders = await this._getHeaders();
        options.headers = newHeaders;
        const retryResponse = await fetch(url, options);
        return await retryResponse.json();
      }

      return await response.json();
    } catch (error) {
      console.error('[CBB] API 调用失败:', error);
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

    console.log('[CBB] 创建订单:', { goodName, amount, outTradeNo });
    const result = await this._callApi('POST', '/api/v2/pay/trade', data);

    if (result.success) {
      console.log('[CBB] 订单创建成功, tradeNo:', result.data?.tradeNo);
    } else {
      console.error('[CBB] 订单创建失败:', result.errorMsg || result.message);
    }

    return result;
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
    let privateKeyPem = this.privateKey;
    if (!privateKeyPem.includes('-----BEGIN')) {
      privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${this.privateKey}\n-----END PRIVATE KEY-----`;
    }

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
      console.error('[CBB] 需要配置 publicKey 才能验证回调签名');
      return false;
    }

    // 取出签名
    const paramsCopy = { ...params };
    const sign = paramsCopy.sign;
    delete paramsCopy.sign;

    if (!sign) {
      console.error('[CBB] 回调参数缺少 sign 字段');
      return false;
    }

    // 构造签名内容
    const content = Object.entries(paramsCopy)
      .filter(([k, v]) => k && v)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');

    // 构造 PEM 格式公钥
    let publicKeyPem = this.publicKey;
    if (!publicKeyPem.includes('-----BEGIN')) {
      publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${this.publicKey}\n-----END PUBLIC KEY-----`;
    }

    // 验证签名
    try {
      const verify = crypto.createVerify('SHA256');
      verify.update(content, 'utf8');
      const result = verify.verify(publicKeyPem, sign, 'base64');
      console.log('[CBB] 回调签名验证:', result ? '通过' : '失败');
      return result;
    } catch (e) {
      console.error('[CBB] 回调签名验证异常:', e.message);
      return false;
    }
  }
}

export default CBBPayClient;

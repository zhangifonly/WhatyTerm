#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CBB 聚合支付服务 Python 客户端模板

使用方法:
    1. 安装依赖: pip install requests pycryptodome
    2. 配置 CLIENT_ID, CLIENT_SECRET, CUSTOMER_CODE 等参数
    3. 实例化 CBBPayClient 并调用相应方法

示例:
    client = CBBPayClient(
        client_id='your_client_id',
        client_secret='your_client_secret',
        customer_code='your_customer_code'
    )

    # 创建订单
    result = client.create_trade(
        good_name='测试商品',
        amount='0.01',
        out_trade_no='test_order_001',
        expire_time='2025-12-31T23:59:59Z'
    )
    print(result)
"""

import base64
import json
import time
import uuid
import urllib.parse
from typing import Dict, Optional, Any

import requests


class CBBPayClient:
    """CBB 聚合支付客户端"""

    def __init__(
        self,
        client_id: str,
        client_secret: str,
        customer_code: str,
        gateway_url: str = 'https://api.webtrn.cn',
        private_key: Optional[str] = None,
        public_key: Optional[str] = None
    ):
        """
        初始化客户端

        Args:
            client_id: 应用客户端ID
            client_secret: 应用客户端密钥
            customer_code: 客户编号
            gateway_url: 网关地址，默认 https://api.webtrn.cn
            private_key: RSA私钥（页面服务签名用，Base64编码）
            public_key: RSA公钥（回调验签用，Base64编码）
        """
        self.client_id = client_id
        self.client_secret = client_secret
        self.customer_code = customer_code
        self.gateway_url = gateway_url.rstrip('/')
        self.private_key = private_key
        self.public_key = public_key
        self._access_token: Optional[str] = None
        self._token_expires_at: float = 0

    def get_access_token(self, force_refresh: bool = False) -> str:
        """
        获取访问令牌

        Args:
            force_refresh: 是否强制刷新

        Returns:
            访问令牌
        """
        # 检查缓存的 token 是否有效
        if not force_refresh and self._access_token and time.time() < self._token_expires_at:
            return self._access_token

        url = f'{self.gateway_url}/auth/v2/security/oauth/token'
        data = {
            'grant_type': 'client_credentials',
            'client_id': self.client_id,
            'client_secret': self.client_secret
        }

        response = requests.post(url, data=data)
        response.raise_for_status()
        result = response.json()

        self._access_token = result['access_token']
        # 提前 5 分钟过期
        self._token_expires_at = time.time() + result.get('expires_in', 7200) - 300

        return self._access_token

    def _get_headers(self) -> Dict[str, str]:
        """获取 API 请求头"""
        return {
            'Authorization': f'Bearer {self.get_access_token()}',
            'x-cbb-client-customer': self.customer_code,
            'x-cbb-client-type': 'api',
            'Content-Type': 'application/json'
        }

    def _call_api(
        self,
        method: str,
        path: str,
        data: Optional[Dict] = None,
        params: Optional[Dict] = None
    ) -> Dict[str, Any]:
        """
        调用 API

        Args:
            method: HTTP 方法
            path: API 路径
            data: 请求体数据
            params: 查询参数

        Returns:
            API 响应数据
        """
        url = f'{self.gateway_url}{path}'
        headers = self._get_headers()

        response = requests.request(
            method=method,
            url=url,
            headers=headers,
            json=data,
            params=params
        )

        # 处理 401 错误（token 过期）
        if response.status_code == 401:
            self.get_access_token(force_refresh=True)
            headers = self._get_headers()
            response = requests.request(
                method=method,
                url=url,
                headers=headers,
                json=data,
                params=params
            )

        response.raise_for_status()
        return response.json()

    # ==================== 订单接口 ====================

    def create_trade(
        self,
        good_name: str,
        amount: str,
        out_trade_no: str,
        expire_time: str,
        business_params: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        创建订单

        Args:
            good_name: 商品名称
            amount: 订单金额（元），如 "100.01"
            out_trade_no: 业务订单号
            expire_time: 过期时间，UTC格式：yyyy-MM-ddTHH:mm:ssZ
            business_params: 业务参数，JSON字符串

        Returns:
            订单信息
        """
        data = {
            'goodName': good_name,
            'totalNumber': amount,
            'outTradeNo': out_trade_no,
            'expireTime': expire_time
        }
        if business_params:
            data['businessParams'] = business_params

        return self._call_api('POST', '/api/v2/pay/trade', data=data)

    def query_trade(self, trade_no: str, include_third_pay_data: bool = False) -> Dict[str, Any]:
        """
        查询订单

        Args:
            trade_no: CBB系统订单号
            include_third_pay_data: 是否包含第三方支付数据

        Returns:
            订单信息
        """
        params = {}
        if include_third_pay_data:
            params['includeThirdPayData'] = 'true'

        return self._call_api('GET', f'/api/v2/pay/trade/{trade_no}', params=params)

    def query_trade_by_out_trade_no(self, out_trade_no: str, create_date: str) -> Dict[str, Any]:
        """
        根据业务订单号查询订单

        Args:
            out_trade_no: 业务订单号
            create_date: 订单创建日期，格式：yyyyMMdd

        Returns:
            订单信息
        """
        data = {
            'outTradeNo': out_trade_no,
            'createDate': create_date
        }
        return self._call_api('POST', '/api/v2/pay/trade/outTradeNo', data=data)

    # ==================== 退款接口 ====================

    def apply_refund(
        self,
        trade_no: str,
        refund_amount: str,
        out_request_no: str,
        refund_reason: str
    ) -> Dict[str, Any]:
        """
        申请退款

        Args:
            trade_no: CBB系统订单号
            refund_amount: 退款金额
            out_request_no: 退款请求号
            refund_reason: 退款原因

        Returns:
            退款申请结果
        """
        data = {
            'tradeNo': trade_no,
            'refundAmount': refund_amount,
            'outRequestNo': out_request_no,
            'refundReason': refund_reason
        }
        return self._call_api('POST', '/api/v2/pay/refund/apply', data=data)

    def query_refund(self, trade_no: str, out_request_no: str) -> Dict[str, Any]:
        """
        查询退款结果

        Args:
            trade_no: CBB系统订单号
            out_request_no: 退款请求号

        Returns:
            退款结果
        """
        return self._call_api('GET', f'/api/v2/pay/refund/query/{trade_no}/{out_request_no}')

    # ==================== 支付辅助接口 ====================

    def get_qr_code(self, trade_no: str, pay_third: str = 'WE_CHAT') -> Dict[str, Any]:
        """
        获取支付二维码

        Args:
            trade_no: CBB系统订单号
            pay_third: 第三方支付类型：WE_CHAT 或 ALIPAY

        Returns:
            二维码信息
        """
        return self._call_api('GET', f'/api/v2/pay/trade/qrCode/{pay_third}/{trade_no}')

    def get_channel(self, environment: str) -> Dict[str, Any]:
        """
        获取支付渠道列表

        Args:
            environment: 支付环境：PC, WAP, WE_CHAT_OFFICIAL, WE_CHAT_MINI_PROGRAM, APP

        Returns:
            支付渠道列表
        """
        return self._call_api('GET', f'/api/v2/pay/trade/channel/{environment}')

    def get_wx_mini_program_param(self, trade_no: str, open_id: str) -> Dict[str, Any]:
        """
        获取微信小程序支付参数

        Args:
            trade_no: CBB系统订单号
            open_id: 用户openId

        Returns:
            小程序支付参数
        """
        return self._call_api('GET', f'/api/v2/pay/trade/getWxMiniProgramParam/{trade_no}/{open_id}')

    # ==================== 页面服务 ====================

    def build_pc_pay_url(self, trade_no: str, turn_url: Optional[str] = None) -> str:
        """
        构建PC端支付页面URL

        Args:
            trade_no: CBB系统订单号
            turn_url: 支付成功跳转地址

        Returns:
            支付页面URL
        """
        if not self.private_key:
            raise ValueError('需要配置 private_key 才能使用页面服务')

        params = {
            'client_id': self.client_id,
            'tradeNo': trade_no,
            'nonceStr': uuid.uuid4().hex,
            'timeStamp': str(int(time.time() * 1000)),
            'charset': 'utf-8'
        }
        if turn_url:
            params['turnUrl'] = turn_url

        return self._build_page_url('/page/v2/pay/trade/pc/toPay', params)

    def build_wap_pay_url(
        self,
        trade_no: str,
        turn_url: Optional[str] = None,
        quit_url: Optional[str] = None
    ) -> str:
        """
        构建移动端H5支付页面URL

        Args:
            trade_no: CBB系统订单号
            turn_url: 支付成功跳转地址
            quit_url: 取消支付跳转地址

        Returns:
            支付页面URL
        """
        if not self.private_key:
            raise ValueError('需要配置 private_key 才能使用页面服务')

        params = {
            'client_id': self.client_id,
            'tradeNo': trade_no,
            'nonceStr': uuid.uuid4().hex,
            'timeStamp': str(int(time.time() * 1000)),
            'charset': 'utf-8'
        }
        if turn_url:
            params['turnUrl'] = turn_url
        if quit_url:
            params['quitUrl'] = quit_url

        return self._build_page_url('/page/v2/pay/trade/wap/toPay', params)

    def _build_page_url(self, path: str, params: Dict[str, str]) -> str:
        """构建带签名的页面URL"""
        # 计算签名
        sign = self._sign_params(params)

        # 构建 URL（双重 URL 编码）
        query_parts = []
        for k, v in sorted(params.items()):
            if k and v:
                encoded_value = urllib.parse.quote(urllib.parse.quote(str(v), safe=''), safe='')
                query_parts.append(f'{k}={encoded_value}')

        encoded_sign = urllib.parse.quote(urllib.parse.quote(sign, safe=''), safe='')
        query_parts.append(f'sign={encoded_sign}')

        return f'{self.gateway_url}{path}?{"&".join(query_parts)}'

    def _sign_params(self, params: Dict[str, str]) -> str:
        """对参数进行 RSA 签名"""
        try:
            from Crypto.PublicKey import RSA
            from Crypto.Signature import pkcs1_15
            from Crypto.Hash import SHA256
        except ImportError:
            raise ImportError('请安装 pycryptodome: pip install pycryptodome')

        # 构造签名内容
        sorted_params = sorted([(k, v) for k, v in params.items() if k and v], key=lambda x: x[0])
        content = '&'.join([f'{k}={v}' for k, v in sorted_params])

        # 加载私钥
        key_bytes = base64.b64decode(self.private_key)
        key = RSA.import_key(key_bytes)

        # 计算签名
        h = SHA256.new(content.encode('utf-8'))
        signature = pkcs1_15.new(key).sign(h)

        return base64.b64encode(signature).decode('ascii')

    # ==================== 回调验签 ====================

    def verify_callback(self, params: Dict[str, str]) -> bool:
        """
        验证回调签名

        Args:
            params: 回调参数字典（包含 sign 字段）

        Returns:
            验证是否通过
        """
        if not self.public_key:
            raise ValueError('需要配置 public_key 才能验证回调签名')

        try:
            from Crypto.PublicKey import RSA
            from Crypto.Signature import pkcs1_15
            from Crypto.Hash import SHA256
        except ImportError:
            raise ImportError('请安装 pycryptodome: pip install pycryptodome')

        # 取出签名
        params = dict(params)
        sign = params.pop('sign', None)
        if not sign:
            return False

        # 构造签名内容
        sorted_params = sorted([(k, v) for k, v in params.items() if k and v], key=lambda x: x[0])
        content = '&'.join([f'{k}={v}' for k, v in sorted_params])

        # 加载公钥
        key_bytes = base64.b64decode(self.public_key)
        key = RSA.import_key(key_bytes)

        # 验证签名
        h = SHA256.new(content.encode('utf-8'))
        try:
            pkcs1_15.new(key).verify(h, base64.b64decode(sign))
            return True
        except (ValueError, TypeError):
            return False


# ==================== 使用示例 ====================

if __name__ == '__main__':
    # 配置信息（请替换为实际值）
    CLIENT_ID = 'your_client_id'
    CLIENT_SECRET = 'your_client_secret'
    CUSTOMER_CODE = 'your_customer_code'
    PRIVATE_KEY = None  # 可选，页面服务需要
    PUBLIC_KEY = None   # 可选，回调验签需要

    # 创建客户端
    client = CBBPayClient(
        client_id=CLIENT_ID,
        client_secret=CLIENT_SECRET,
        customer_code=CUSTOMER_CODE,
        private_key=PRIVATE_KEY,
        public_key=PUBLIC_KEY
    )

    # 示例：创建订单
    from datetime import datetime, timedelta

    expire_time = (datetime.utcnow() + timedelta(hours=2)).strftime('%Y-%m-%dT%H:%M:%SZ')
    out_trade_no = f'test_{int(time.time())}'

    try:
        result = client.create_trade(
            good_name='测试商品',
            amount='0.01',
            out_trade_no=out_trade_no,
            expire_time=expire_time,
            business_params=json.dumps({'test': True})
        )
        print('创建订单结果:', json.dumps(result, indent=2, ensure_ascii=False))

        if result.get('success'):
            trade_no = result['data']['tradeNo']

            # 查询订单
            query_result = client.query_trade(trade_no)
            print('查询订单结果:', json.dumps(query_result, indent=2, ensure_ascii=False))

            # 获取二维码
            qr_result = client.get_qr_code(trade_no, 'WE_CHAT')
            print('二维码结果:', json.dumps(qr_result, indent=2, ensure_ascii=False))

    except Exception as e:
        print(f'操作失败: {e}')

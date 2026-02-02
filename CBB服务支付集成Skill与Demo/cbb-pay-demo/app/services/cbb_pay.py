"""
CBB 聚合支付服务客户端
基于 cbb-pay-integration Skill 模板，适配 FastAPI 项目
"""
import time
from typing import Dict, Optional, Any
import httpx
from ..config import settings
from .rsa_utils import build_page_url, verify_callback


class CBBPayClient:
    """CBB 聚合支付客户端（异步版本）"""

    def __init__(self):
        self.client_id = settings.CBB_CLIENT_ID
        self.client_secret = settings.CBB_CLIENT_SECRET
        self.customer_code = settings.CBB_CUSTOMER_CODE
        self.gateway_url = settings.CBB_GATEWAY_URL.rstrip('/')
        self.private_key = settings.CBB_PRIVATE_KEY or None
        self.public_key = settings.CBB_PUBLIC_KEY or None
        self._access_token: Optional[str] = None
        self._token_expires_at: float = 0

    async def get_access_token(self, force_refresh: bool = False) -> str:
        """获取访问令牌"""
        if not force_refresh and self._access_token and time.time() < self._token_expires_at:
            return self._access_token

        url = f'{self.gateway_url}/auth/v2/security/oauth/token'
        data = {
            'grant_type': 'client_credentials',
            'client_id': self.client_id,
            'client_secret': self.client_secret
        }
        async with httpx.AsyncClient() as client:
            response = await client.post(url, data=data)
            response.raise_for_status()
            result = response.json()

        self._access_token = result['access_token']
        self._token_expires_at = time.time() + result.get('expires_in', 7200) - 300
        return self._access_token

    async def _get_headers(self) -> Dict[str, str]:
        """获取 API 请求头"""
        return {
            'Authorization': f'Bearer {await self.get_access_token()}',
            'x-cbb-client-customer': self.customer_code,
            'x-cbb-client-type': 'api',
            'Content-Type': 'application/json'
        }

    async def _call_api(self, method: str, path: str, data: Optional[Dict] = None,
                        params: Optional[Dict] = None) -> Dict[str, Any]:
        """调用 API"""
        url = f'{self.gateway_url}{path}'
        headers = await self._get_headers()

        async with httpx.AsyncClient() as client:
            response = await client.request(method, url, headers=headers, json=data, params=params)
            if response.status_code == 401:
                await self.get_access_token(force_refresh=True)
                headers = await self._get_headers()
                response = await client.request(method, url, headers=headers, json=data, params=params)
            response.raise_for_status()
            return response.json()

    # ==================== 订单接口 ====================

    async def create_trade(self, good_name: str, amount: str, out_trade_no: str,
                           expire_time: str, business_params: Optional[str] = None) -> Dict[str, Any]:
        """创建订单"""
        data = {
            'goodName': good_name,
            'totalNumber': amount,
            'outTradeNo': out_trade_no,
            'expireTime': expire_time
        }
        if business_params:
            data['businessParams'] = business_params
        return await self._call_api('POST', '/api/v2/pay/trade', data=data)

    async def query_trade(self, trade_no: str, include_third: bool = False) -> Dict[str, Any]:
        """查询订单"""
        params = {'includeThirdPayData': 'true'} if include_third else None
        return await self._call_api('GET', f'/api/v2/pay/trade/{trade_no}', params=params)

    async def query_trade_by_out_trade_no(self, out_trade_no: str, create_date: str) -> Dict[str, Any]:
        """根据业务订单号查询订单"""
        data = {'outTradeNo': out_trade_no, 'createDate': create_date}
        return await self._call_api('POST', '/api/v2/pay/trade/outTradeNo', data=data)

    # ==================== 退款接口 ====================

    async def apply_refund(self, trade_no: str, refund_amount: str,
                           out_request_no: str, refund_reason: str) -> Dict[str, Any]:
        """申请退款"""
        data = {
            'tradeNo': trade_no,
            'refundAmount': refund_amount,
            'outRequestNo': out_request_no,
            'refundReason': refund_reason
        }
        return await self._call_api('POST', '/api/v2/pay/refund/apply', data=data)

    async def query_refund(self, trade_no: str, out_request_no: str) -> Dict[str, Any]:
        """查询退款结果"""
        return await self._call_api('GET', f'/api/v2/pay/refund/query/{trade_no}/{out_request_no}')

    # ==================== 支付辅助接口 ====================

    async def get_qr_code(self, trade_no: str, pay_third: str = 'WE_CHAT') -> Dict[str, Any]:
        """获取支付二维码"""
        return await self._call_api('GET', f'/api/v2/pay/trade/qrCode/{pay_third}/{trade_no}')

    async def get_channel(self, environment: str) -> Dict[str, Any]:
        """获取支付渠道列表"""
        return await self._call_api('GET', f'/api/v2/pay/trade/channel/{environment}')

    # ==================== 页面服务 ====================

    def build_pc_pay_url(self, trade_no: str, turn_url: Optional[str] = None) -> str:
        """构建PC端支付页面URL"""
        if not self.private_key:
            raise ValueError('需要配置 CBB_PRIVATE_KEY 才能使用页面服务')
        params = {'client_id': self.client_id, 'tradeNo': trade_no}
        if turn_url:
            params['turnUrl'] = turn_url
        return build_page_url(self.gateway_url, '/page/v2/pay/trade/pc/toPay', params, self.private_key)

    def build_wap_pay_url(self, trade_no: str, turn_url: Optional[str] = None,
                          quit_url: Optional[str] = None) -> str:
        """构建移动端H5支付页面URL"""
        if not self.private_key:
            raise ValueError('需要配置 CBB_PRIVATE_KEY 才能使用页面服务')
        params = {'client_id': self.client_id, 'tradeNo': trade_no}
        if turn_url:
            params['turnUrl'] = turn_url
        if quit_url:
            params['quitUrl'] = quit_url
        return build_page_url(self.gateway_url, '/page/v2/pay/trade/wap/toPay', params, self.private_key)

    # ==================== 回调验签 ====================

    def verify_callback_sign(self, params: Dict[str, str]) -> bool:
        """验证回调签名"""
        if not self.public_key:
            raise ValueError('需要配置 CBB_PUBLIC_KEY 才能验证回调签名')
        return verify_callback(params, self.public_key)


# 全局客户端实例
cbb_pay_client = CBBPayClient()

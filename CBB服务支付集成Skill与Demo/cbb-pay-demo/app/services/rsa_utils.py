"""
CBB 支付服务 RSA 签名/验签工具
基于 cbb-pay-integration Skill 模板适配
"""
import base64
import urllib.parse
import time
import uuid
from typing import Dict

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.backends import default_backend


def normalize_key(key_content: str) -> str:
    """标准化密钥格式：去除 PEM 头尾、换行符和空格"""
    if not key_content:
        return key_content
    # 去除 PEM 头尾标记
    for marker in ['-----BEGIN PRIVATE KEY-----', '-----END PRIVATE KEY-----',
                   '-----BEGIN PUBLIC KEY-----', '-----END PUBLIC KEY-----',
                   '-----BEGIN RSA PRIVATE KEY-----', '-----END RSA PRIVATE KEY-----']:
        key_content = key_content.replace(marker, '')
    # 去除换行和空格
    return key_content.replace('\n', '').replace('\r', '').replace(' ', '')


def get_sign_content(params: Dict[str, str]) -> str:
    """将参数按 key 字母序排序并拼接成签名字符串"""
    sorted_params = sorted(
        [(k, v) for k, v in params.items() if k and v],
        key=lambda x: x[0]
    )
    return '&'.join([f'{k}={v}' for k, v in sorted_params])


def sign_with_rsa(params: Dict[str, str], private_key_b64: str) -> str:
    """使用 RSA 私钥对参数进行 SHA256WithRSA 签名"""
    content = get_sign_content(params)
    key_bytes = base64.b64decode(normalize_key(private_key_b64))
    private_key = serialization.load_der_private_key(key_bytes, password=None, backend=default_backend())
    signature = private_key.sign(
        content.encode('utf-8'),
        padding.PKCS1v15(),
        hashes.SHA256()
    )
    return base64.b64encode(signature).decode('ascii')


def verify_with_rsa(params: Dict[str, str], public_key_b64: str, sign: str) -> bool:
    """使用 RSA 公钥验证签名"""
    content = get_sign_content(params)
    key_bytes = base64.b64decode(normalize_key(public_key_b64))
    public_key = serialization.load_der_public_key(key_bytes, backend=default_backend())
    try:
        public_key.verify(
            base64.b64decode(sign),
            content.encode('utf-8'),
            padding.PKCS1v15(),
            hashes.SHA256()
        )
        return True
    except Exception:
        return False


def build_page_url(base_url: str, path: str, params: Dict[str, str], private_key: str) -> str:
    """构建带签名的页面服务 URL（双重 URL 编码）"""
    params = dict(params)
    if 'nonceStr' not in params:
        params['nonceStr'] = uuid.uuid4().hex
    if 'timeStamp' not in params:
        params['timeStamp'] = str(int(time.time() * 1000))
    if 'charset' not in params:
        params['charset'] = 'utf-8'

    sign = sign_with_rsa(params, private_key)
    query_parts = []
    for k, v in sorted(params.items()):
        if k and v:
            encoded = urllib.parse.quote(urllib.parse.quote(str(v), safe=''), safe='')
            query_parts.append(f'{k}={encoded}')
    encoded_sign = urllib.parse.quote(urllib.parse.quote(sign, safe=''), safe='')
    query_parts.append(f'sign={encoded_sign}')
    return f'{base_url}{path}?{"&".join(query_parts)}'


def verify_callback(params: Dict[str, str], public_key: str) -> bool:
    """验证回调签名"""
    params = dict(params)
    sign = params.pop('sign', None)
    if not sign:
        return False
    return verify_with_rsa(params, public_key, sign)

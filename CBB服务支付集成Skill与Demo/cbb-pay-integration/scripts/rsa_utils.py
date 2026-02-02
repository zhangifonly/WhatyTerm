#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CBB 支付服务 RSA 签名/验签工具

用于页面服务签名和回调验签
"""

import base64
import hashlib
import urllib.parse
from typing import Dict, Optional


def get_sign_content(params: Dict[str, str]) -> str:
    """
    将参数按 key 字母序排序并拼接成签名字符串

    Args:
        params: 参数字典

    Returns:
        签名字符串，格式：key1=value1&key2=value2
    """
    # 过滤空值并排序
    sorted_params = sorted(
        [(k, v) for k, v in params.items() if k and v],
        key=lambda x: x[0]
    )
    # 拼接
    return '&'.join([f'{k}={v}' for k, v in sorted_params])


def sign_with_rsa(params: Dict[str, str], private_key: str, charset: str = 'utf-8') -> str:
    """
    使用 RSA 私钥对参数进行签名

    Args:
        params: 参数字典
        private_key: RSA 私钥（Base64编码，不含头尾标记）
        charset: 字符集，默认 utf-8

    Returns:
        Base64 编码的签名结果
    """
    try:
        from Crypto.PublicKey import RSA
        from Crypto.Signature import pkcs1_15
        from Crypto.Hash import SHA256
    except ImportError:
        raise ImportError("请安装 pycryptodome: pip install pycryptodome")

    # 构造签名内容
    content = get_sign_content(params)

    # 加载私钥
    key_bytes = base64.b64decode(private_key)
    key = RSA.import_key(key_bytes)

    # 计算签名
    h = SHA256.new(content.encode(charset))
    signature = pkcs1_15.new(key).sign(h)

    return base64.b64encode(signature).decode('ascii')


def verify_with_rsa(params: Dict[str, str], public_key: str, sign: str, charset: str = 'utf-8') -> bool:
    """
    使用 RSA 公钥验证签名

    Args:
        params: 参数字典（不含 sign 字段）
        public_key: RSA 公钥（Base64编码，不含头尾标记）
        sign: 待验证的签名（Base64编码）
        charset: 字符集，默认 utf-8

    Returns:
        验证是否通过
    """
    try:
        from Crypto.PublicKey import RSA
        from Crypto.Signature import pkcs1_15
        from Crypto.Hash import SHA256
    except ImportError:
        raise ImportError("请安装 pycryptodome: pip install pycryptodome")

    # 构造签名内容
    content = get_sign_content(params)

    # 加载公钥
    key_bytes = base64.b64decode(public_key)
    key = RSA.import_key(key_bytes)

    # 验证签名
    h = SHA256.new(content.encode(charset))
    try:
        pkcs1_15.new(key).verify(h, base64.b64decode(sign))
        return True
    except (ValueError, TypeError):
        return False


def build_page_url(base_url: str, params: Dict[str, str], private_key: str) -> str:
    """
    构建带签名的页面服务 URL

    Args:
        base_url: 基础 URL，如 https://api.webtrn.cn/page/v2/pay/trade/pc/toPay
        params: 参数字典
        private_key: RSA 私钥

    Returns:
        完整的带签名 URL
    """
    import time
    import uuid

    # 添加必要参数
    params = dict(params)
    if 'nonceStr' not in params:
        params['nonceStr'] = uuid.uuid4().hex
    if 'timeStamp' not in params:
        params['timeStamp'] = str(int(time.time() * 1000))
    if 'charset' not in params:
        params['charset'] = 'utf-8'

    # 计算签名
    sign = sign_with_rsa(params, private_key)

    # 构建 URL（双重 URL 编码）
    query_parts = []
    for k, v in sorted(params.items()):
        if k and v:
            encoded_value = urllib.parse.quote(urllib.parse.quote(str(v), safe=''), safe='')
            query_parts.append(f'{k}={encoded_value}')

    encoded_sign = urllib.parse.quote(urllib.parse.quote(sign, safe=''), safe='')
    query_parts.append(f'sign={encoded_sign}')

    return f'{base_url}?{"&".join(query_parts)}'


def verify_callback(params: Dict[str, str], public_key: str) -> bool:
    """
    验证回调签名

    Args:
        params: 回调参数字典（包含 sign 字段）
        public_key: RSA 公钥

    Returns:
        验证是否通过
    """
    # 取出签名
    sign = params.pop('sign', None)
    if not sign:
        return False

    return verify_with_rsa(params, public_key, sign)


# 示例用法
if __name__ == '__main__':
    # 示例私钥和公钥（请替换为实际的密钥）
    PRIVATE_KEY = 'YOUR_PRIVATE_KEY_BASE64'
    PUBLIC_KEY = 'YOUR_PUBLIC_KEY_BASE64'
    CLIENT_ID = 'YOUR_CLIENT_ID'

    # 构建页面 URL 示例
    params = {
        'client_id': CLIENT_ID,
        'tradeNo': '202508251430001234567890',
    }

    try:
        url = build_page_url(
            'https://api.webtrn.cn/page/v2/pay/trade/pc/toPay',
            params,
            PRIVATE_KEY
        )
        print(f'页面 URL: {url}')
    except Exception as e:
        print(f'构建 URL 失败: {e}')

    # 验证回调示例
    callback_params = {
        'tradeNo': '202508251430001234567890',
        'outTradeNo': '20250825001',
        'status': 'SUCCESS',
        'totalNumber': '100.01',
        'sign': 'CALLBACK_SIGN_VALUE'
    }

    try:
        is_valid = verify_callback(dict(callback_params), PUBLIC_KEY)
        print(f'回调验签结果: {is_valid}')
    except Exception as e:
        print(f'验签失败: {e}')

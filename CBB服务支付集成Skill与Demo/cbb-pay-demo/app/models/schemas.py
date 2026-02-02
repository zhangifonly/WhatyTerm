"""
CBB Pay Demo 数据模型
使用 Pydantic 定义请求/响应模型
"""
from pydantic import BaseModel
from typing import Optional
from enum import Enum
from datetime import datetime


class OrderStatus(str, Enum):
    """订单状态枚举"""
    CREATED = "created"           # 已创建
    PAYING = "paying"             # 支付中
    PAID = "paid"                 # 已支付
    REFUNDING = "refunding"       # 退款中
    REFUNDED = "refunded"         # 已退款
    CLOSED = "closed"             # 已关闭


class CreateOrderRequest(BaseModel):
    """创建订单请求"""
    good_name: str                # 商品名称
    amount: str                   # 金额（元）
    out_trade_no: Optional[str] = None  # 业务订单号（可选，自动生成）


class OrderResponse(BaseModel):
    """订单响应"""
    order_id: str                 # 本地订单ID
    trade_no: Optional[str]       # CBB 订单号
    out_trade_no: str             # 业务订单号
    good_name: str
    amount: str
    status: OrderStatus
    created_at: str
    pay_url: Optional[str] = None


class PaymentRequest(BaseModel):
    """发起支付请求"""
    order_id: str                 # 本地订单ID
    pay_type: str = "pc"          # 支付类型: pc, wap
    turn_url: Optional[str] = None  # 支付完成跳转地址


class RefundRequest(BaseModel):
    """退款请求"""
    order_id: str                 # 本地订单ID
    refund_amount: str            # 退款金额
    refund_reason: str = "用户申请退款"


class CallbackData(BaseModel):
    """回调数据模型"""
    trade_no: str
    out_trade_no: str
    status: str
    amount: Optional[str] = None
    sign: str

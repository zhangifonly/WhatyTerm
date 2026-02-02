"""
订单管理路由
处理订单创建、查询、支付跳转等功能
"""
import time
import uuid
import logging
from datetime import datetime, timedelta
from typing import Dict
from fastapi import APIRouter, HTTPException
from fastapi.responses import RedirectResponse

logger = logging.getLogger(__name__)

from ..models.schemas import CreateOrderRequest, OrderResponse, OrderStatus, PaymentRequest, RefundRequest
from ..services import cbb_pay_client
from ..config import settings

router = APIRouter(prefix="/orders", tags=["订单管理"])

# 内存订单存储（演示用，生产环境应使用数据库）
orders_db: Dict[str, dict] = {}


@router.post("/", response_model=OrderResponse)
async def create_order(request: CreateOrderRequest):
    """创建订单"""
    # 生成本地订单ID和业务订单号
    order_id = str(uuid.uuid4())[:8]
    out_trade_no = request.out_trade_no or f"demo_{int(time.time())}_{order_id}"

    # 计算过期时间（2小时后）
    expire_time = (datetime.utcnow() + timedelta(hours=2)).strftime('%Y-%m-%dT%H:%M:%SZ')

    try:
        # 调用 CBB 创建订单
        result = await cbb_pay_client.create_trade(
            good_name=request.good_name,
            amount=request.amount,
            out_trade_no=out_trade_no,
            expire_time=expire_time
        )

        if not result.get('success'):
            raise HTTPException(status_code=400, detail=result.get('errorMsg', '创建订单失败'))

        trade_no = result['data']['tradeNo']

        # 保存到本地存储
        order = {
            'order_id': order_id,
            'trade_no': trade_no,
            'out_trade_no': out_trade_no,
            'good_name': request.good_name,
            'amount': request.amount,
            'status': OrderStatus.CREATED,
            'created_at': datetime.now().isoformat()
        }
        orders_db[order_id] = order

        return OrderResponse(**order)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"创建订单异常: {str(e)}")


@router.get("/{order_id}", response_model=OrderResponse)
async def get_order(order_id: str):
    """查询订单"""
    if order_id not in orders_db:
        raise HTTPException(status_code=404, detail="订单不存在")
    return OrderResponse(**orders_db[order_id])


@router.get("/")
async def list_orders():
    """获取订单列表"""
    return {"orders": list(orders_db.values())}


@router.post("/{order_id}/pay")
async def pay_order(order_id: str, pay_type: str = "pc", turn_url: str = None):
    """获取支付页面URL"""
    if order_id not in orders_db:
        raise HTTPException(status_code=404, detail="订单不存在")

    order = orders_db[order_id]
    trade_no = order.get('trade_no')
    if not trade_no:
        raise HTTPException(status_code=400, detail="订单未创建成功")

    # 默认跳转地址
    if not turn_url:
        turn_url = f"{settings.CALLBACK_BASE_URL}/pages/result?order_id={order_id}"

    try:
        if pay_type == "pc":
            pay_url = cbb_pay_client.build_pc_pay_url(trade_no, turn_url)
        else:
            pay_url = cbb_pay_client.build_wap_pay_url(trade_no, turn_url)

        # 更新订单状态
        order['status'] = OrderStatus.PAYING
        order['pay_url'] = pay_url

        return {"pay_url": pay_url, "order_id": order_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"生成支付链接失败: {str(e)}")


@router.get("/{order_id}/pay/redirect")
async def redirect_to_pay(order_id: str, pay_type: str = "pc"):
    """直接跳转到支付页面"""
    result = await pay_order(order_id, pay_type)
    return RedirectResponse(url=result["pay_url"])


@router.post("/{order_id}/refund")
async def refund_order(order_id: str, request: RefundRequest):
    """申请退款"""
    if order_id not in orders_db:
        raise HTTPException(status_code=404, detail="订单不存在")

    order = orders_db[order_id]
    if order['status'] != OrderStatus.PAID:
        raise HTTPException(status_code=400, detail="订单状态不允许退款")

    out_request_no = f"refund_{int(time.time())}_{order_id}"

    try:
        result = await cbb_pay_client.apply_refund(
            trade_no=order['trade_no'],
            refund_amount=request.refund_amount,
            out_request_no=out_request_no,
            refund_reason=request.refund_reason
        )

        if result.get('success'):
            order['status'] = OrderStatus.REFUNDING
            return {"message": "退款申请已提交", "out_request_no": out_request_no}
        else:
            raise HTTPException(status_code=400, detail=result.get('errorMsg', '退款申请失败'))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"退款申请异常: {str(e)}")


@router.get("/{order_id}/sync")
async def sync_order_status(order_id: str):
    """从 CBB 同步订单状态"""
    if order_id not in orders_db:
        raise HTTPException(status_code=404, detail="订单不存在")

    order = orders_db[order_id]
    try:
        result = await cbb_pay_client.query_trade(order['trade_no'])
        logger.info(f"CBB 查询结果: {result}")

        if result.get('success'):
            # CBB 实际返回的状态字段是 payStatus，值为 PAYED/WAIT_PAY 等
            cbb_status = result['data'].get('payStatus')
            logger.info(f"CBB 状态: {cbb_status}, 当前本地状态: {order['status']}")

            # 映射 CBB 状态到本地状态
            status_map = {
                'WAIT_PAY': OrderStatus.CREATED,
                'PAYING': OrderStatus.PAYING,
                'PAYED': OrderStatus.PAID,  # CBB 返回 PAYED 表示已支付
                'SUCCESS': OrderStatus.PAID,  # 兼容文档中的 SUCCESS
                'REFUND': OrderStatus.REFUNDED,
                'CLOSED': OrderStatus.CLOSED
            }
            new_status = status_map.get(cbb_status, order['status'])
            order['status'] = new_status
            logger.info(f"更新后本地状态: {order['status']}")

            return {"order": order, "cbb_data": result['data']}
        else:
            raise HTTPException(status_code=400, detail=result.get('errorMsg'))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"同步状态异常: {e}")
        raise HTTPException(status_code=500, detail=f"同步状态异常: {str(e)}")

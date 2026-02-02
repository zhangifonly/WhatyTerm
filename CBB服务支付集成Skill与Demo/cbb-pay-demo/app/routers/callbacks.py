"""
回调处理路由
接收 CBB 支付/退款结果通知
"""
import logging
from fastapi import APIRouter, Request, Form
from fastapi.responses import PlainTextResponse

from ..services import cbb_pay_client
from ..models.schemas import OrderStatus

# 导入订单存储（与 orders.py 共享）
from .orders import orders_db

router = APIRouter(prefix="/callback", tags=["回调处理"])
logger = logging.getLogger(__name__)


@router.post("/pay", response_class=PlainTextResponse)
async def pay_callback(request: Request):
    """
    支付结果回调
    CBB 支付成功后会 POST 通知到此接口
    """
    try:
        # 获取回调参数
        form_data = await request.form()
        params = {k: v for k, v in form_data.items()}

        logger.info(f"收到支付回调: {params}")

        # 验证签名
        if not cbb_pay_client.verify_callback_sign(dict(params)):
            logger.warning("支付回调签名验证失败")
            return PlainTextResponse("FAIL", status_code=400)

        # 获取关键参数
        trade_no = params.get('tradeNo')
        out_trade_no = params.get('outTradeNo')
        status = params.get('status')

        logger.info(f"支付回调验签成功: tradeNo={trade_no}, status={status}")

        # 查找并更新本地订单
        for order_id, order in orders_db.items():
            if order.get('trade_no') == trade_no or order.get('out_trade_no') == out_trade_no:
                if status == 'SUCCESS':
                    order['status'] = OrderStatus.PAID
                    logger.info(f"订单 {order_id} 支付成功")
                elif status == 'CLOSED':
                    order['status'] = OrderStatus.CLOSED
                    logger.info(f"订单 {order_id} 已关闭")
                break

        # 返回成功响应，避免 CBB 重复推送
        return PlainTextResponse("SUCCESS")

    except Exception as e:
        logger.error(f"处理支付回调异常: {e}")
        return PlainTextResponse("FAIL", status_code=500)


@router.post("/refund", response_class=PlainTextResponse)
async def refund_callback(request: Request):
    """
    退款结果回调
    CBB 退款完成后会 POST 通知到此接口
    """
    try:
        form_data = await request.form()
        params = {k: v for k, v in form_data.items()}

        logger.info(f"收到退款回调: {params}")

        # 验证签名
        if not cbb_pay_client.verify_callback_sign(dict(params)):
            logger.warning("退款回调签名验证失败")
            return PlainTextResponse("FAIL", status_code=400)

        trade_no = params.get('tradeNo')
        refund_status = params.get('refundStatus')

        logger.info(f"退款回调验签成功: tradeNo={trade_no}, refundStatus={refund_status}")

        # 更新本地订单状态
        for order_id, order in orders_db.items():
            if order.get('trade_no') == trade_no:
                if refund_status == 'SUCCESS':
                    order['status'] = OrderStatus.REFUNDED
                    logger.info(f"订单 {order_id} 退款成功")
                break

        return PlainTextResponse("SUCCESS")

    except Exception as e:
        logger.error(f"处理退款回调异常: {e}")
        return PlainTextResponse("FAIL", status_code=500)


@router.get("/test")
async def test_callback():
    """测试回调接口是否可访问"""
    return {"status": "ok", "message": "回调接口正常"}

"""
CBB Pay Demo - FastAPI 应用入口
演示如何对接 CBB 聚合支付服务
"""
import logging
from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse
from pathlib import Path

from .config import settings
from .routers import orders_router, callbacks_router

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# 创建 FastAPI 应用
app = FastAPI(
    title="CBB Pay Demo",
    description="CBB 聚合支付服务对接演示项目",
    version="1.0.0"
)

# 注册路由
app.include_router(orders_router)
app.include_router(callbacks_router)

# 模板配置
templates_dir = Path(__file__).parent / "templates"
templates = Jinja2Templates(directory=str(templates_dir))


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    """首页"""
    return templates.TemplateResponse("index.html", {
        "request": request,
        "title": "CBB Pay Demo"
    })


@app.get("/pages/result", response_class=HTMLResponse)
async def payment_result(request: Request, order_id: str = None):
    """支付结果页"""
    return templates.TemplateResponse("result.html", {
        "request": request,
        "order_id": order_id
    })


@app.get("/health")
async def health_check():
    """健康检查"""
    errors = settings.validate()
    return {
        "status": "ok" if not errors else "warning",
        "config_errors": errors,
        "gateway_url": settings.CBB_GATEWAY_URL
    }


@app.on_event("startup")
async def startup_event():
    """应用启动事件"""
    errors = settings.validate()
    if errors:
        logger.warning(f"配置警告: {errors}")
    else:
        logger.info("CBB Pay Demo 启动成功")
        logger.info(f"网关地址: {settings.CBB_GATEWAY_URL}")
        logger.info(f"回调地址: {settings.CALLBACK_BASE_URL}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app.main:app",
        host=settings.APP_HOST,
        port=settings.APP_PORT,
        reload=settings.APP_DEBUG
    )

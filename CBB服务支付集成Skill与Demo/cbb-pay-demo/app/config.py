"""
CBB Pay Demo 配置管理模块
从环境变量加载 CBB 服务配置
"""
import os
from dotenv import load_dotenv

# 加载 .env 文件
load_dotenv()


class Settings:
    """应用配置类"""

    # CBB 网关配置
    CBB_GATEWAY_URL: str = os.getenv("CBB_GATEWAY_URL", "https://api.webtrn.cn")
    CBB_CLIENT_ID: str = os.getenv("CBB_CLIENT_ID", "")
    CBB_CLIENT_SECRET: str = os.getenv("CBB_CLIENT_SECRET", "")
    CBB_CUSTOMER_CODE: str = os.getenv("CBB_CUSTOMER_CODE", "")

    # RSA 密钥
    CBB_PRIVATE_KEY: str = os.getenv("CBB_PRIVATE_KEY", "")
    CBB_PUBLIC_KEY: str = os.getenv("CBB_PUBLIC_KEY", "")

    # 应用配置
    APP_HOST: str = os.getenv("APP_HOST", "0.0.0.0")
    APP_PORT: int = int(os.getenv("APP_PORT", "8000"))
    APP_DEBUG: bool = os.getenv("APP_DEBUG", "false").lower() == "true"

    # 回调地址
    CALLBACK_BASE_URL: str = os.getenv("CALLBACK_BASE_URL", "http://localhost:8000")

    def validate(self) -> list[str]:
        """验证必要配置是否已设置"""
        errors = []
        if not self.CBB_CLIENT_ID:
            errors.append("CBB_CLIENT_ID 未配置")
        if not self.CBB_CLIENT_SECRET:
            errors.append("CBB_CLIENT_SECRET 未配置")
        if not self.CBB_CUSTOMER_CODE:
            errors.append("CBB_CUSTOMER_CODE 未配置")
        return errors


settings = Settings()

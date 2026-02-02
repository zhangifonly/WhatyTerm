# CBB Pay Demo

CBB 聚合支付服务对接演示项目，基于 FastAPI 框架开发。

## 功能特性

- ✅ OAuth2 认证（自动获取和刷新 Token）
- ✅ 创建支付订单
- ✅ 查询订单状态
- ✅ PC/H5 支付页面跳转（RSA 签名）
- ✅ 支付结果回调接收（RSA 验签）
- ✅ 申请退款
- ✅ 退款结果回调

## 快速开始

### 1. 安装依赖

```bash
cd cbb-pay-demo
pip install -r requirements.txt
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env` 并填入实际配置：

```bash
cp .env.example .env
```

编辑 `.env` 文件：

```env
CBB_GATEWAY_URL=https://api.webtrn.cn
CBB_CLIENT_ID=your_client_id
CBB_CLIENT_SECRET=your_client_secret
CBB_CUSTOMER_CODE=your_customer_code
CBB_PRIVATE_KEY=your_private_key_base64
CBB_PUBLIC_KEY=your_public_key_base64
CALLBACK_BASE_URL=http://your-server.com:8000
```

### 3. 启动服务

```bash
# 开发模式
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# 生产模式
uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 4
```

### 4. 访问应用

- 首页：http://localhost:8000
- API 文档：http://localhost:8000/docs
- 健康检查：http://localhost:8000/health

## API 接口

| 方法 | 路径 | 说明 |
|-----|------|------|
| POST | /orders/ | 创建订单 |
| GET | /orders/ | 获取订单列表 |
| GET | /orders/{id} | 查询订单详情 |
| POST | /orders/{id}/pay | 获取支付页面URL |
| GET | /orders/{id}/pay/redirect | 跳转到支付页面 |
| POST | /orders/{id}/refund | 申请退款 |
| GET | /orders/{id}/sync | 同步订单状态 |
| POST | /callback/pay | 支付结果回调 |
| POST | /callback/refund | 退款结果回调 |

## 部署说明

### 公网部署要求

1. 服务器需要公网 IP 或域名
2. 开放 8000 端口（或配置 Nginx 反向代理）
3. 配置 `CALLBACK_BASE_URL` 为公网可访问地址
4. 建议配置 HTTPS

### Nginx 配置示例

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## 测试流程

1. 访问首页，创建测试订单（金额 0.01 元）
2. 点击"去支付"跳转到 CBB 支付页面
3. 使用微信/支付宝扫码支付
4. 支付成功后自动跳转回结果页
5. CBB 会异步推送支付结果到回调接口

## 项目结构

```
cbb-pay-demo/
├── app/
│   ├── __init__.py
│   ├── main.py              # FastAPI 应用入口
│   ├── config.py            # 配置管理
│   ├── models/
│   │   └── schemas.py       # Pydantic 数据模型
│   ├── routers/
│   │   ├── orders.py        # 订单路由
│   │   └── callbacks.py     # 回调路由
│   ├── services/
│   │   ├── cbb_pay.py       # CBB 支付客户端
│   │   └── rsa_utils.py     # RSA 签名工具
│   └── templates/
│       ├── index.html       # 首页
│       └── result.html      # 支付结果页
├── requirements.txt
├── .env.example
└── README.md
```

## 基于 cbb-pay-integration Skill 生成

本项目使用 Claude Code 的 `cbb-pay-integration` Skill 辅助生成，验证了 Skill 的实际效果。

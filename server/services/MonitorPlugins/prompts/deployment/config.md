# 部署运维 - 配置准备阶段

## 阶段目标
准备部署所需的配置文件和环境，确保部署过程顺利进行。

## 配置检查清单

### 环境变量配置
```bash
# .env.production 示例
NODE_ENV=production
PORT=3000
DATABASE_URL=postgresql://user:pass@host:5432/db
REDIS_URL=redis://localhost:6379
API_KEY=your-api-key
SECRET_KEY=your-secret-key
```

### 必须检查的配置项
| 配置项 | 说明 | 检查要点 |
|--------|------|---------|
| 数据库连接 | DATABASE_URL | 生产环境地址、用户名密码 |
| 缓存配置 | REDIS_URL | 生产环境地址 |
| API 密钥 | API_KEY | 使用生产环境密钥 |
| 日志级别 | LOG_LEVEL | 生产环境建议 warn 或 error |
| CORS 配置 | CORS_ORIGIN | 限制为生产域名 |

### Docker 配置
```dockerfile
# Dockerfile 示例
FROM node:20-alpine

WORKDIR /app

# 安装依赖
COPY package*.json ./
RUN npm ci --only=production

# 复制代码
COPY . .

# 构建
RUN npm run build

# 启动
EXPOSE 3000
CMD ["npm", "start"]
```

### docker-compose 配置
```yaml
# docker-compose.yml
version: '3.8'
services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
    depends_on:
      - db
      - redis
    restart: unless-stopped

  db:
    image: postgres:15
    volumes:
      - postgres_data:/var/lib/postgresql/data
    environment:
      - POSTGRES_PASSWORD=secret

  redis:
    image: redis:7-alpine
    volumes:
      - redis_data:/data

volumes:
  postgres_data:
  redis_data:
```

### Nginx 配置
```nginx
# nginx.conf
server {
    listen 80;
    server_name example.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name example.com;

    ssl_certificate /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## 安全检查

- [ ] 敏感信息未提交到代码仓库
- [ ] 使用环境变量管理密钥
- [ ] 数据库密码足够复杂
- [ ] SSL 证书已配置
- [ ] 防火墙规则已设置

## 检查清单

- [ ] 环境变量配置完整
- [ ] Docker 配置文件正确
- [ ] Nginx/反向代理配置正确
- [ ] SSL 证书已准备
- [ ] 数据库迁移脚本已准备
- [ ] 备份策略已制定

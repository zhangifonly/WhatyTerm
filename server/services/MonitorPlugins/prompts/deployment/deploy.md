# 部署运维 - 部署执行阶段

## 阶段目标
执行部署操作，将应用发布到生产环境。

## 部署流程

### 1. 预部署检查
```bash
# 检查代码状态
git status
git log -1

# 运行测试
npm test

# 构建检查
npm run build
```

### 2. 备份当前版本
```bash
# 备份数据库
pg_dump -h host -U user dbname > backup_$(date +%Y%m%d_%H%M%S).sql

# 备份应用
tar -czf app_backup_$(date +%Y%m%d_%H%M%S).tar.gz /path/to/app
```

### 3. 执行部署

#### Docker 部署
```bash
# 拉取最新代码
git pull origin main

# 构建镜像
docker compose build

# 停止旧容器
docker compose down

# 启动新容器
docker compose up -d

# 检查状态
docker compose ps
docker compose logs -f
```

#### 传统部署
```bash
# 拉取代码
git pull origin main

# 安装依赖
npm ci --only=production

# 构建
npm run build

# 重启服务
pm2 restart app
# 或
systemctl restart app
```

### 4. 数据库迁移
```bash
# Prisma
npx prisma migrate deploy

# Drizzle
npx drizzle-kit push

# 原生 SQL
psql -h host -U user -d dbname -f migrations/latest.sql
```

## 部署命令模板

### PM2 部署
```bash
# 启动
pm2 start ecosystem.config.js --env production

# 重启
pm2 restart app

# 查看状态
pm2 status

# 查看日志
pm2 logs app
```

### Systemd 服务
```bash
# 重启服务
sudo systemctl restart app

# 查看状态
sudo systemctl status app

# 查看日志
sudo journalctl -u app -f
```

## 回滚方案

### 快速回滚
```bash
# Docker 回滚
docker compose down
docker tag app:latest app:rollback
docker pull app:previous
docker compose up -d

# Git 回滚
git checkout HEAD~1
npm ci
npm run build
pm2 restart app
```

### 数据库回滚
```bash
# 恢复备份
psql -h host -U user -d dbname < backup_20240115.sql
```

## 检查清单

- [ ] 代码已合并到主分支
- [ ] 测试全部通过
- [ ] 已备份当前版本
- [ ] 已备份数据库
- [ ] 部署命令执行成功
- [ ] 数据库迁移完成
- [ ] 服务正常启动

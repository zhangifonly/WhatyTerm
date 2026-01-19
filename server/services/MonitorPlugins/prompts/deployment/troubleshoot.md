# 部署运维 - 故障排查阶段

## 阶段目标
快速定位和解决部署过程中遇到的问题。

## 排查流程

### 1. 收集信息
```bash
# 查看服务状态
systemctl status app
docker compose ps

# 查看最近日志
docker compose logs --tail=200
journalctl -u app -n 200

# 查看系统资源
free -h
df -h
top -bn1 | head -20
```

### 2. 分析错误

#### 常见错误类型
| 错误 | 可能原因 | 解决方案 |
|------|---------|---------|
| ECONNREFUSED | 服务未启动 | 启动服务或检查端口 |
| EADDRINUSE | 端口被占用 | 释放端口或更换端口 |
| ENOMEM | 内存不足 | 增加内存或优化代码 |
| EACCES | 权限不足 | 检查文件权限 |
| ENOENT | 文件不存在 | 检查路径配置 |

### 3. 网络问题排查
```bash
# 检查端口监听
netstat -tlnp | grep 3000
ss -tlnp | grep 3000

# 检查防火墙
ufw status
iptables -L -n

# 测试连接
curl -v http://localhost:3000
telnet localhost 3000
```

### 4. 数据库问题排查
```bash
# 检查连接
psql -h host -U user -d dbname -c "SELECT 1"

# 检查连接数
psql -c "SELECT count(*) FROM pg_stat_activity"

# 检查慢查询
psql -c "SELECT * FROM pg_stat_activity WHERE state = 'active'"
```

## 常见问题解决

### 应用无法启动
```bash
# 1. 检查日志
docker compose logs app

# 2. 检查配置
cat .env.production

# 3. 检查依赖
npm ls

# 4. 手动启动调试
node server.js
```

### 502 Bad Gateway
```bash
# 1. 检查应用是否运行
curl http://localhost:3000/health

# 2. 检查 Nginx 配置
nginx -t
cat /etc/nginx/sites-enabled/app

# 3. 检查 Nginx 日志
tail -f /var/log/nginx/error.log
```

### 内存不足
```bash
# 1. 查看内存使用
free -h
ps aux --sort=-%mem | head -10

# 2. 清理缓存
sync && echo 3 > /proc/sys/vm/drop_caches

# 3. 重启服务释放内存
docker compose restart
pm2 restart all
```

### 磁盘空间不足
```bash
# 1. 查看磁盘使用
df -h
du -sh /* 2>/dev/null | sort -h

# 2. 清理 Docker
docker system prune -a

# 3. 清理日志
truncate -s 0 /var/log/app/*.log
journalctl --vacuum-time=7d
```

## 回滚决策

### 何时回滚
- 核心功能不可用
- 错误率超过 10%
- 响应时间超过 5 秒
- 数据一致性问题

### 回滚步骤
```bash
# 1. 通知相关人员
# 2. 执行回滚
git checkout HEAD~1
docker compose down
docker compose up -d

# 3. 验证回滚成功
curl https://example.com/health

# 4. 记录问题
```

## 检查清单

- [ ] 已收集完整的错误信息
- [ ] 已分析错误原因
- [ ] 已尝试解决方案
- [ ] 问题已解决或已回滚
- [ ] 已记录问题和解决方案

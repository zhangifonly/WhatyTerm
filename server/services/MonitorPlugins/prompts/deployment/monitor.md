# 部署运维 - 监控验证阶段

## 阶段目标
验证部署成功，监控应用运行状态，确保服务正常。

## 验证步骤

### 1. 服务状态检查
```bash
# Docker 容器状态
docker compose ps
docker stats

# PM2 状态
pm2 status
pm2 monit

# Systemd 状态
systemctl status app
```

### 2. 健康检查
```bash
# HTTP 健康检查
curl -I https://example.com/health
curl -I https://example.com/api/health

# 预期响应
# HTTP/2 200
# content-type: application/json
```

### 3. 功能验证
| 功能 | 测试方法 | 预期结果 |
|------|---------|---------|
| 首页访问 | 浏览器访问 | 页面正常显示 |
| 用户登录 | 测试账号登录 | 登录成功 |
| API 接口 | curl 测试 | 返回正确数据 |
| 数据库连接 | 查询测试 | 查询成功 |

### 4. 日志检查
```bash
# Docker 日志
docker compose logs -f --tail=100

# PM2 日志
pm2 logs app --lines 100

# 系统日志
tail -f /var/log/app/app.log
journalctl -u app -f
```

## 监控指标

### 应用指标
| 指标 | 正常范围 | 告警阈值 |
|------|---------|---------|
| CPU 使用率 | < 70% | > 90% |
| 内存使用率 | < 80% | > 95% |
| 响应时间 | < 500ms | > 2000ms |
| 错误率 | < 1% | > 5% |

### 监控命令
```bash
# 实时资源监控
htop
docker stats

# 网络连接
netstat -tlnp
ss -tlnp

# 磁盘使用
df -h
du -sh /path/to/app
```

## 告警配置

### 常见告警规则
```yaml
# 示例：Prometheus 告警规则
groups:
  - name: app-alerts
    rules:
      - alert: HighErrorRate
        expr: rate(http_requests_total{status=~"5.."}[5m]) > 0.05
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "高错误率告警"

      - alert: HighResponseTime
        expr: histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m])) > 2
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "响应时间过长"
```

## 问题排查

### 常见问题
| 问题 | 可能原因 | 排查方法 |
|------|---------|---------|
| 502 Bad Gateway | 应用未启动 | 检查应用日志 |
| 503 Service Unavailable | 服务过载 | 检查资源使用 |
| 连接超时 | 网络问题 | 检查防火墙 |
| 数据库错误 | 连接池耗尽 | 检查连接数 |

## 检查清单

- [ ] 服务状态正常
- [ ] 健康检查通过
- [ ] 核心功能验证通过
- [ ] 日志无异常错误
- [ ] 资源使用正常
- [ ] 监控告警已配置

# App 开发 - 部署上线阶段

## 阶段目标
安全地将应用部署到生产环境。

## 部署流程

### 部署前检查
- [ ] 所有测试通过
- [ ] 构建成功
- [ ] 配置正确
- [ ] 回滚方案就绪

### 部署方式

#### Docker 部署
```bash
# 构建镜像
docker build -t app:v1.0.0 .

# 推送镜像
docker push registry/app:v1.0.0

# 部署
docker-compose up -d
```

#### Kubernetes 部署
```bash
# 应用配置
kubectl apply -f deployment.yaml

# 检查状态
kubectl rollout status deployment/app

# 回滚
kubectl rollout undo deployment/app
```

#### 传统部署
```bash
# 上传文件
rsync -avz dist/ server:/var/www/app/

# 重启服务
ssh server "systemctl restart app"
```

## 部署后验证

### 健康检查
```bash
# HTTP 健康检查
curl -f http://app/health

# 服务状态
systemctl status app
```

### 监控指标
- 响应时间
- 错误率
- CPU/内存使用
- 请求量

## 部署清单

- [ ] 服务正常启动
- [ ] 配置正确
- [ ] 健康检查通过
- [ ] 回滚方案就绪

# 部署运维 - 备份归档阶段

## 阶段目标
完成部署后的备份和文档归档工作，确保可追溯和可恢复。

## 备份策略

### 数据库备份
```bash
# PostgreSQL 完整备份
pg_dump -h host -U user -Fc dbname > backup_$(date +%Y%m%d_%H%M%S).dump

# PostgreSQL 仅数据
pg_dump -h host -U user --data-only dbname > data_$(date +%Y%m%d).sql

# MySQL 备份
mysqldump -h host -u user -p dbname > backup_$(date +%Y%m%d_%H%M%S).sql

# SQLite 备份
cp database.db database_$(date +%Y%m%d_%H%M%S).db
```

### 文件备份
```bash
# 应用代码备份
tar -czf app_$(date +%Y%m%d_%H%M%S).tar.gz /path/to/app

# 配置文件备份
tar -czf config_$(date +%Y%m%d_%H%M%S).tar.gz /etc/nginx /etc/app

# 上传文件备份
tar -czf uploads_$(date +%Y%m%d_%H%M%S).tar.gz /path/to/uploads
```

### 自动备份脚本
```bash
#!/bin/bash
# backup.sh

BACKUP_DIR="/backup"
DATE=$(date +%Y%m%d_%H%M%S)

# 数据库备份
pg_dump -h localhost -U app -Fc appdb > $BACKUP_DIR/db_$DATE.dump

# 文件备份
tar -czf $BACKUP_DIR/app_$DATE.tar.gz /var/www/app

# 清理 7 天前的备份
find $BACKUP_DIR -name "*.dump" -mtime +7 -delete
find $BACKUP_DIR -name "*.tar.gz" -mtime +7 -delete

echo "Backup completed: $DATE"
```

### 定时备份配置
```bash
# crontab -e
# 每天凌晨 3 点执行备份
0 3 * * * /path/to/backup.sh >> /var/log/backup.log 2>&1
```

## 部署记录

### 部署日志模板
```markdown
## 部署记录

### 基本信息
- 部署时间: 2024-01-15 14:30:00
- 部署人员: [姓名]
- 版本号: v1.2.3
- Git Commit: abc1234

### 部署内容
- [x] 新功能：用户管理模块
- [x] Bug 修复：登录超时问题
- [x] 性能优化：首页加载速度

### 配置变更
- 新增环境变量：FEATURE_FLAG_X=true
- 修改配置：增加数据库连接池大小

### 数据库变更
- 新增表：user_settings
- 修改字段：users.status 类型变更

### 验证结果
- [x] 健康检查通过
- [x] 核心功能验证通过
- [x] 性能指标正常

### 备份信息
- 数据库备份：db_20240115_143000.dump
- 代码备份：app_20240115_143000.tar.gz

### 问题记录
- 无
```

## 文档归档

### 需要归档的文档
- [ ] 部署记录
- [ ] 配置变更说明
- [ ] 数据库迁移脚本
- [ ] 回滚方案
- [ ] 问题处理记录

### 归档位置
```
docs/
├── deployments/
│   ├── 2024-01-15_v1.2.3.md
│   └── 2024-01-10_v1.2.2.md
├── migrations/
│   ├── 001_init.sql
│   └── 002_add_user_settings.sql
└── runbooks/
    ├── deployment.md
    └── rollback.md
```

## 检查清单

- [ ] 数据库已备份
- [ ] 代码已备份
- [ ] 配置文件已备份
- [ ] 部署记录已填写
- [ ] 文档已归档
- [ ] 自动备份已配置
- [ ] 备份已验证可恢复

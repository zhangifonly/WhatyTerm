#!/bin/bash
# WhatyTerm 订阅服务器数据库备份脚本
# 用法: ./scripts/backup.sh [备份目录]

set -e

# 配置
DB_PATH="/app/data/subscription.db"
BACKUP_DIR="${1:-/app/data/backups}"
RETENTION_DAYS=30
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="subscription_${DATE}.db"

# 创建备份目录
mkdir -p "$BACKUP_DIR"

# 检查数据库文件是否存在
if [ ! -f "$DB_PATH" ]; then
    echo "[备份] 错误: 数据库文件不存在: $DB_PATH"
    exit 1
fi

# 使用 SQLite 的 .backup 命令进行热备份（不锁定数据库）
echo "[备份] 开始备份数据库..."
sqlite3 "$DB_PATH" ".backup '$BACKUP_DIR/$BACKUP_FILE'"

# 压缩备份文件
echo "[备份] 压缩备份文件..."
gzip "$BACKUP_DIR/$BACKUP_FILE"

# 计算备份文件大小
BACKUP_SIZE=$(du -h "$BACKUP_DIR/${BACKUP_FILE}.gz" | cut -f1)
echo "[备份] 备份完成: ${BACKUP_FILE}.gz ($BACKUP_SIZE)"

# 清理旧备份（保留最近 N 天）
echo "[备份] 清理 ${RETENTION_DAYS} 天前的旧备份..."
find "$BACKUP_DIR" -name "subscription_*.db.gz" -mtime +$RETENTION_DAYS -delete

# 列出当前备份
echo "[备份] 当前备份列表:"
ls -lh "$BACKUP_DIR"/subscription_*.db.gz 2>/dev/null | tail -10

echo "[备份] 完成!"

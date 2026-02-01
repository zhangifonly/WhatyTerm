#!/bin/bash
# WhatyTerm 订阅服务器数据库恢复脚本
# 用法: ./scripts/restore.sh <备份文件>

set -e

# 配置
DB_PATH="/app/data/subscription.db"
BACKUP_FILE="$1"

# 检查参数
if [ -z "$BACKUP_FILE" ]; then
    echo "用法: $0 <备份文件>"
    echo "示例: $0 /app/data/backups/subscription_20260201_120000.db.gz"
    exit 1
fi

# 检查备份文件是否存在
if [ ! -f "$BACKUP_FILE" ]; then
    echo "[恢复] 错误: 备份文件不存在: $BACKUP_FILE"
    exit 1
fi

# 确认恢复操作
echo "警告: 此操作将覆盖当前数据库!"
echo "备份文件: $BACKUP_FILE"
read -p "确定要继续吗? (yes/no): " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
    echo "[恢复] 已取消"
    exit 0
fi

# 备份当前数据库
if [ -f "$DB_PATH" ]; then
    CURRENT_BACKUP="${DB_PATH}.before_restore_$(date +%Y%m%d_%H%M%S)"
    echo "[恢复] 备份当前数据库到: $CURRENT_BACKUP"
    cp "$DB_PATH" "$CURRENT_BACKUP"
fi

# 解压并恢复
echo "[恢复] 正在恢复数据库..."
if [[ "$BACKUP_FILE" == *.gz ]]; then
    gunzip -c "$BACKUP_FILE" > "$DB_PATH"
else
    cp "$BACKUP_FILE" "$DB_PATH"
fi

# 验证数据库完整性
echo "[恢复] 验证数据库完整性..."
sqlite3 "$DB_PATH" "PRAGMA integrity_check;" | head -1

echo "[恢复] 完成! 请重启服务以应用更改。"

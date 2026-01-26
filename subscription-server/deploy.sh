#!/bin/bash
# WhatyTerm 订阅服务器部署脚本

set -e

SERVER="us-lax02"
REMOTE_DIR="/root/whatyterm-subscription"
LOCAL_DIR="$(dirname "$0")"

echo "=========================================="
echo "WhatyTerm 订阅服务器部署"
echo "=========================================="

# 1. 同步文件到服务器
echo ""
echo "[1/4] 同步文件到服务器..."
rsync -avz --exclude 'node_modules' --exclude 'data/*.db' --exclude '.git' \
    "$LOCAL_DIR/" "$SERVER:$REMOTE_DIR/"

# 2. 在服务器上构建和启动
echo ""
echo "[2/4] 构建 Docker 镜像..."
ssh "$SERVER" "cd $REMOTE_DIR && docker compose build"

# 3. 启动服务
echo ""
echo "[3/4] 启动服务..."
ssh "$SERVER" "cd $REMOTE_DIR && docker compose down && docker compose up -d"

# 4. 检查状态
echo ""
echo "[4/4] 检查服务状态..."
sleep 3
ssh "$SERVER" "docker ps | grep whatyterm-subscription"
ssh "$SERVER" "curl -s http://localhost:3100/api/plans | head -c 200"

echo ""
echo "=========================================="
echo "部署完成！"
echo "服务地址: https://term.whaty.org"
echo "=========================================="

#!/bin/bash
# deploy-release.sh - 发版部署脚本
# 用法: ./scripts/deploy-release.sh
# 功能: 上传安装包 + zip + manifest 到服务器，更新自动升级源

set -e

VERSION=$(node -e "console.log(require('./package.json').version)")
echo "🚀 部署版本 v${VERSION}"

# ── 检查必要文件 ──────────────────────────────────────────
DMG_X64="release/WhatyTerm-${VERSION}.dmg"
DMG_ARM64="release/WhatyTerm-${VERSION}-arm64.dmg"
ZIP_X64="release/WhatyTerm-${VERSION}-mac.zip"
ZIP_ARM64="release/WhatyTerm-${VERSION}-arm64-mac.zip"
EXE="release/WhatyTerm Setup ${VERSION}.exe"
MAC_YML="release/latest-mac.yml"
WIN_YML="release/latest.yml"

for f in "$DMG_X64" "$DMG_ARM64" "$ZIP_X64" "$ZIP_ARM64" "$EXE" "$MAC_YML" "$WIN_YML"; do
  if [ ! -f "$f" ]; then
    echo "❌ 缺少文件: $f"
    exit 1
  fi
done
echo "✅ 所有安装包文件就绪"

# ── 上传版本目录（安装包）────────────────────────────────
echo "📦 上传安装包到 /var/www/downloads/whatyterm/v${VERSION}/"
ssh us-lax02 "mkdir -p /var/www/downloads/whatyterm/v${VERSION}"
scp "$DMG_X64" "$DMG_ARM64" "$EXE" \
    us-lax02:"/var/www/downloads/whatyterm/v${VERSION}/"

# ── 上传 zip（自动更新用）────────────────────────────────
echo "📦 上传 zip 到 /var/www/downloads/releases/"
ssh us-lax02 "mkdir -p /var/www/downloads/releases"
scp "$ZIP_X64" "$ZIP_ARM64" "$EXE" \
    us-lax02:"/var/www/downloads/releases/"

# ── 上传 manifest（自动更新 yml）─────────────────────────
echo "📋 更新自动升级 manifest"
scp "$MAC_YML" "$WIN_YML" \
    us-lax02:"/var/www/downloads/releases/"

# ── 更新下载页面版本号 ────────────────────────────────────
echo "🌐 更新 term.whaty.org 下载页面"
sed -i '' "s/1\.[0-9]*\.[0-9]*/${VERSION}/g" subscription-server/public/index.html
scp subscription-server/public/index.html us-lax02:/tmp/index.html
ssh us-lax02 "docker cp /tmp/index.html whatyterm-subscription:/app/public/index.html"

# ── 验证 ──────────────────────────────────────────────────
echo ""
echo "✅ 部署完成！验证："
ssh us-lax02 "ls -lh /var/www/downloads/whatyterm/v${VERSION}/ && echo '' && ls -lh /var/www/downloads/releases/*.yml /var/www/downloads/releases/*.zip /var/www/downloads/releases/*.exe 2>/dev/null | tail -10"
echo ""
echo "🔗 自动更新地址: https://term.whaty.org/releases/latest-mac.yml"
curl -s "https://term.whaty.org/releases/latest-mac.yml" | grep "^version:" || echo "⚠️  manifest 访问失败"

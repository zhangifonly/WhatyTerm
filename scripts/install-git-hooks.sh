#!/bin/bash
# 安装版本化 git hooks 到 .git/hooks/（.git/hooks 不随仓库版本控制，故需手动安装）
# 用法：bash scripts/install-git-hooks.sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/scripts/git-hooks"
DST="$ROOT/.git/hooks"

if [ ! -d "$DST" ]; then
  echo "❌ 未找到 $DST （不是 git 仓库根目录？）"
  exit 1
fi

for hook in "$SRC"/*; do
  name="$(basename "$hook")"
  cp "$hook" "$DST/$name"
  chmod +x "$DST/$name"
  echo "✅ 已安装 hook: $name"
done

echo "完成。pre-push 将拦截向公开主仓推送 master/main，防止泄露闭源核心。"

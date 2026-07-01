#!/bin/sh
# 自动恢复 Ralph 付费闭源核心（gitignored，切分支时易丢失）。
# 由 .git/hooks/post-checkout / post-merge 调用：若核心缺失，从私有库还原。
# 私有库是核心的权威副本，见 WhatyTerm-Ralph-Private/。

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PRIV="$ROOT/../WhatyTerm-Ralph-Private"

# 仅当核心缺失时才动作（避免覆盖正在编辑的版本）
missing=0
for f in server/services/RalphEngine.js server/services/ralph/prompts.js; do
  [ -f "$ROOT/$f" ] || missing=1
done
[ "$missing" -eq 0 ] && exit 0

if [ ! -d "$PRIV" ]; then
  echo "[ralph-core] ⚠ 核心缺失，但私有库 $PRIV 不存在，无法自动恢复" >&2
  exit 0
fi

for f in server/services/RalphEngine.js server/services/ralph/prompts.js; do
  if [ -f "$PRIV/$f" ] && [ ! -f "$ROOT/$f" ]; then
    mkdir -p "$ROOT/$(dirname "$f")"
    cp "$PRIV/$f" "$ROOT/$f"
    echo "[ralph-core] 已从私有库恢复: $f"
  fi
done
exit 0

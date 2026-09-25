#!/bin/bash
# WebTmux 服务交给 macOS launchd 守护：登录时自动启动；异常退出（崩溃 / 被 SIGKILL / OOM）约 10 秒后自动拉起。
#
# 为什么：进程救不了自己，只能靠父进程重拉。打包版由 Electron 负责（electron/respawnPolicy.cjs）；
# 直接跑 `node server/index.js` 的开发机以前没有任何守护 —— 2026-09-26 服务随 Claude 会话 /exit 被连带杀掉，
# 同日整机重启后也没人拉起。launchd 起的进程不属于任何终端/会话，不会被连坐。
#
# 前提：「系统设置 → 隐私与安全性 → 完全磁盘访问」里加上 /bin/zsh。项目都在 ~/Documents 下，
# launchd 起的进程没有终端 App 的「文稿」授权，会被 TCC 拦住（2026-09-26 实测：getcwd Operation not permitted，服务卡死）。
# ⚠ zsh 不 exec 成 node：TCC 按「负责进程」判定，保持 zsh 为父进程，node 与它拉起的 tmux/claude 都由 zsh 的授权覆盖。
#
# 环境经 `zsh -lic` 加载 ~/.zshrc，与终端里手动启动一致（代理、CLI 路径、各 CLI 的 key）。
# 重启后 tmux 服务由本服务拉起，会话里的 claude 继承的就是这份环境，所以必须是完整的登录环境。
# 配置文件里不写任何环境变量 —— 照抄当前进程环境会把密钥明文写进 ~/Library/LaunchAgents。
#
# 用法：scripts/webtmux-service.sh preflight | install [--force] | uninstall | restart | status | plist <输出路径>
set -euo pipefail

LABEL=com.whaty.webtmux
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOG=/private/tmp/webtmux-server.log
PORT=3928
DOMAIN="gui/$(id -u)"

[ "$(uname)" = Darwin ] || { echo "只支持 macOS（Linux 请用 systemd，Windows 用打包版）"; exit 1; }
case "$REPO" in *"'"*) echo "项目路径含单引号，无法安全写入启动命令：${REPO}"; exit 1;; esac

port_pid() { lsof -ti:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true; }

# zsh 里跑的启动脚本：node 作子进程，收到停止信号转发给它，退出码原样交给 launchd
# （node 收到 SIGTERM 正常退出 = 0 → launchd 不重拉；被杀 / 崩溃 = 非 0 → 重拉）
run_script() {
  cat <<EOF
cd '${REPO}' || exit 78
node server/index.js &
pid=\$!
trap 'kill -TERM \$pid 2>/dev/null' TERM INT HUP
wait \$pid; rc=\$?
while kill -0 \$pid 2>/dev/null; do wait \$pid; rc=\$?; done
exit \$rc
EOF
}

xml_escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

write_plist() {  # $1=输出路径 $2=label $3=启动脚本 $4=日志 $5=是否常驻(true/false)
  local keep=""
  [ "$5" = true ] && keep="<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>"
  mkdir -p "$(dirname "$1")"
  cat > "$1" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$2</string>
  <key>ProgramArguments</key>
  <array><string>/bin/zsh</string><string>-lic</string><string>$(printf '%s' "$3" | xml_escape)</string></array>
  <key>WorkingDirectory</key><string>/tmp</string>
  <key>RunAtLoad</key><true/>
  ${keep}
  <!-- 不用 Background：后台类型会被系统限速，监控轮询与终端响应都会变慢 -->
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$4</string>
  <key>StandardErrorPath</key><string>$4</string>
</dict>
</plist>
EOF
  plutil -lint "$1" >/dev/null
}

wait_port() {  # $1=up|down  $2=秒  $3=（up 时）必须不是这个 pid
  for _ in $(seq 1 "$2"); do
    local p; p=$(port_pid)
    if [ "$1" = up ] && [ -n "$p" ] && [ "$p" != "${3:-}" ]; then return 0; fi
    if [ "$1" = down ] && [ -z "$p" ]; then return 0; fi
    sleep 1
  done
  return 1
}

# 不经 launchd、脱离当前终端/会话把服务拉起来（回滚与卸载后用，保证任何时候都有服务在跑）
start_manual() {
  ( cd "$REPO" && perl -MPOSIX -e 'fork and exit; setsid(); fork and exit; open STDIN, "<", "/dev/null";
      open STDOUT, ">>", $ARGV[0]; open STDERR, ">&STDOUT"; exec "node", "server/index.js" or die' "$LOG" )
  wait_port up 60
}

# 用一个临时 launchd 任务确认：launchd 起的 zsh 能进项目目录、能跑 node。
# 通过了才动正在运行的服务。被 TCC 拦住时要么报 Operation not permitted，要么卡在授权弹窗 → 超时
cmd_preflight() {
  local label="${LABEL}.preflight" out; out=$(mktemp /tmp/webtmux-preflight.XXXXXX)
  local tmp; tmp=$(mktemp /tmp/webtmux-preflight-plist.XXXXXX).plist
  write_plist "$tmp" "$label" "cd '${REPO}' && ls package.json >/dev/null && node -e 'process.exit(0)' && echo PREFLIGHT_OK" "$out" false
  launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$tmp"
  local ok=1
  for _ in $(seq 1 25); do
    if grep -q PREFLIGHT_OK "$out"; then ok=0; break; fi
    grep -qi "not permitted" "$out" && break
    sleep 1
  done
  launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
  if [ $ok -ne 0 ]; then
    echo "预检未通过：launchd 起的 zsh 进不了项目目录（macOS 隐私保护拦截）。输出："
    grep -v "配置已加载" "$out" | tail -5 | sed 's/^/  /'
    echo "请到「系统设置 → 隐私与安全性 → 完全磁盘访问」点 +，按 ⌘⇧G 输入 /bin/zsh 添加并打开开关，再重试。"
  else
    echo "预检通过：launchd 起的 zsh 能访问项目目录并运行 node"
  fi
  rm -f "$out" "$tmp"
  return $ok
}

cmd_install() {
  local force="${1:-}" p
  cmd_preflight || exit 1
  p=$(port_pid)
  if [ -n "$p" ]; then
    # 占着端口的必须是本项目的服务（打包版 WhatyTerm 自己管自己，别去动它）
    local cwd; cwd=$(lsof -a -p "$p" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
    [ "$cwd" = "$REPO" ] || { echo "${PORT} 端口被别的程序占用（pid ${p}，目录 ${cwd:-未知}），不动它"; exit 1; }
    # 停服务会打断正在跑的长程执行者
    if [ "$force" != --force ] && ps -Ao ppid=,command= | awk -v p="$p" '$1==p' | grep -qE 'claude .*(-p|--print|stream-json)'; then
      echo "有长程执行者正在运行，现在切换会打断它。等它结束，或加 --force"; exit 1
    fi
  fi
  write_plist "$PLIST" "$LABEL" "$(run_script)" "$LOG" true
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  if [ -n "$p" ]; then
    echo "停止当前手动启动的服务（pid ${p}）…"
    kill -TERM "$p"
    wait_port down 30 || { echo "服务 30 秒内没退出，放弃切换（原服务仍在）"; exit 1; }
  fi
  launchctl bootstrap "$DOMAIN" "$PLIST"
  if wait_port up 90 "$p"; then
    p=$(port_pid)
    echo "已交给 launchd 守护：服务 pid ${p}，父进程 $(ps -o ppid= -p "$p" | tr -d ' ')（launchd 起的 zsh）"
  else
    # 回滚：绝不让机器处于没有服务的状态
    echo "90 秒内服务没起来，撤销 launchd 守护并按原方式拉回服务…"
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    start_manual && echo "已恢复：服务 pid $(port_pid)（未受 launchd 守护）。原因看日志：tail -50 ${LOG}" \
      || echo "回滚也没起来，请手动 npm start。日志：tail -50 ${LOG}"
    exit 1
  fi
}

cmd_restart() {
  local old; old=$(port_pid)
  launchctl kickstart -k "$DOMAIN/$LABEL"
  # 等端口换成新进程：刚 kickstart 时旧进程可能还占着端口，只等「端口在」会拿到旧 pid
  wait_port up 90 "$old" && echo "已重启：服务 pid $(port_pid)" || { echo "90 秒内没起来，看日志：tail -50 ${LOG}"; exit 1; }
}

case "${1:-}" in
  preflight) cmd_preflight ;;
  install) cmd_install "${2:-}" ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    wait_port down 30 || true
    start_manual && echo "已取消 launchd 守护；服务已按手动方式重新拉起（pid $(port_pid)）" ;;
  restart) cmd_restart ;;
  status)
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E '^\s*(state|pid|last exit code|runs) =' || echo "未安装 launchd 守护"
    echo "  端口 ${PORT}：$(port_pid || true)" ;;
  plist) write_plist "${2:?需要输出路径}" "$LABEL" "$(run_script)" "$LOG" true; echo "$2" ;;   # 只生成配置不安装（测试 / 检查用）
  *) echo "用法：$0 preflight | install [--force] | uninstall | restart | status | plist <输出路径>"; exit 1 ;;
esac

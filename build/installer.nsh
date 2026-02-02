; 自定义 NSIS 安装脚本 - 安装前强制关闭运行中的程序

; 覆盖默认的应用运行检测
; 定义此宏会完全替代默认的 _CHECK_APP_RUNNING 宏
; 我们先尝试关闭进程，然后直接继续安装（不检测是否成功）
!macro customCheckAppRunning
  ; 强制终止所有相关进程（忽略错误）
  nsExec::ExecToStack 'taskkill /F /T /IM WhatyTerm.exe'
  Pop $0
  Pop $1
  nsExec::ExecToStack 'taskkill /F /IM frpc.exe'
  Pop $0
  Pop $1
  nsExec::ExecToStack 'taskkill /F /IM cloudflared.exe'
  Pop $0
  Pop $1
  nsExec::ExecToStack 'taskkill /F /IM node.exe'
  Pop $0
  Pop $1

  ; 等待进程退出
  Sleep 2000

  ; 不做任何检测，直接继续安装
  ; 如果文件被锁定，NSIS 会在复制文件时处理
!macroend

!macro customInit
  ; 安装初始化时也尝试关闭
  nsExec::ExecToStack 'taskkill /F /T /IM WhatyTerm.exe'
  Pop $0
  Pop $1
  nsExec::ExecToStack 'taskkill /F /IM frpc.exe'
  Pop $0
  Pop $1
  nsExec::ExecToStack 'taskkill /F /IM cloudflared.exe'
  Pop $0
  Pop $1
  nsExec::ExecToStack 'taskkill /F /IM node.exe'
  Pop $0
  Pop $1
  Sleep 1000
!macroend

!macro customUnInit
  ; 卸载前关闭所有相关进程
  nsExec::ExecToStack 'taskkill /F /T /IM WhatyTerm.exe'
  Pop $0
  Pop $1
  nsExec::ExecToStack 'taskkill /F /IM frpc.exe'
  Pop $0
  Pop $1
  nsExec::ExecToStack 'taskkill /F /IM cloudflared.exe'
  Pop $0
  Pop $1
  nsExec::ExecToStack 'taskkill /F /IM node.exe'
  Pop $0
  Pop $1
  Sleep 2000
!macroend

; 自定义 NSIS 安装脚本 - 安装前强制关闭运行中的程序

; 覆盖默认的应用运行检测，强制关闭而不是提示用户
!macro customCheckAppRunning
  ; 强制终止所有相关进程
  nsExec::ExecToStack 'taskkill /F /T /IM WhatyTerm.exe'
  nsExec::ExecToStack 'taskkill /F /T /IM "WhatyTerm.exe"'
  nsExec::ExecToStack 'taskkill /F /IM frpc.exe'
  nsExec::ExecToStack 'taskkill /F /IM cloudflared.exe'
  nsExec::ExecToStack 'taskkill /F /IM node.exe'

  ; 等待进程完全退出
  Sleep 3000

  ; 再次尝试，确保进程已终止
  nsExec::ExecToStack 'taskkill /F /T /IM WhatyTerm.exe'
  Sleep 1000
!macroend

!macro customInit
  ; 安装初始化时也尝试关闭
  nsExec::ExecToStack 'taskkill /F /T /IM WhatyTerm.exe'
  nsExec::ExecToStack 'taskkill /F /IM frpc.exe'
  nsExec::ExecToStack 'taskkill /F /IM cloudflared.exe'
  nsExec::ExecToStack 'taskkill /F /IM node.exe'
  Sleep 2000
!macroend

!macro customUnInit
  ; 卸载前关闭所有相关进程
  nsExec::ExecToStack 'taskkill /F /T /IM WhatyTerm.exe'
  nsExec::ExecToStack 'taskkill /F /IM frpc.exe'
  nsExec::ExecToStack 'taskkill /F /IM cloudflared.exe'
  nsExec::ExecToStack 'taskkill /F /IM node.exe'
  Sleep 3000

  ; 再次尝试
  nsExec::ExecToStack 'taskkill /F /T /IM WhatyTerm.exe'
  Sleep 1000
!macroend

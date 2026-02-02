; 自定义 NSIS 安装脚本 - 安装前强制关闭运行中的程序

!macro customInit
  ; 尝试多次终止进程，确保完全关闭
  ; 使用 /F 强制终止，/T 终止子进程树
  nsExec::ExecToLog 'taskkill /F /T /IM WhatyTerm.exe'
  nsExec::ExecToLog 'taskkill /F /T /IM "WhatyTerm.exe"'
  nsExec::ExecToLog 'taskkill /F /IM frpc.exe'
  nsExec::ExecToLog 'taskkill /F /IM cloudflared.exe'
  nsExec::ExecToLog 'taskkill /F /IM node.exe'

  ; 等待进程完全退出
  Sleep 2000

  ; 再次尝试，确保进程已终止
  nsExec::ExecToLog 'taskkill /F /T /IM WhatyTerm.exe'
  Sleep 500
!macroend

!macro customUnInit
  ; 卸载前关闭所有相关进程
  nsExec::ExecToLog 'taskkill /F /T /IM WhatyTerm.exe'
  nsExec::ExecToLog 'taskkill /F /IM frpc.exe'
  nsExec::ExecToLog 'taskkill /F /IM cloudflared.exe'
  nsExec::ExecToLog 'taskkill /F /IM node.exe'
  Sleep 2000
!macroend

; 自定义 NSIS 安装脚本 - 简化版，只终止进程，不检测旧版本

!macro customInit
  ; 终止所有相关进程，避免文件被锁定
  nsExec::ExecToLog 'taskkill /F /IM WhatyTerm.exe'
  nsExec::ExecToLog 'taskkill /F /IM frpc.exe'
  nsExec::ExecToLog 'taskkill /F /IM cloudflared.exe'
  Sleep 1000
!macroend

!macro customUnInit
  ; 卸载前关闭所有相关进程
  nsExec::ExecToLog 'taskkill /F /IM WhatyTerm.exe'
  nsExec::ExecToLog 'taskkill /F /IM frpc.exe'
  nsExec::ExecToLog 'taskkill /F /IM cloudflared.exe'
  Sleep 1000
!macroend

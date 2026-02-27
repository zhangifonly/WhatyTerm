; 自定义 NSIS 安装脚本 - 安装前强制关闭运行中的程序并卸载旧版本

; 覆盖默认的应用运行检测
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
  Sleep 2000
!macroend

!macro customInit
  ; 关闭运行中的程序
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

  ; 自动卸载旧版本 - 检查注册表中的卸载程序
  ; GUID 与 electron-builder.yml 中的 nsis.guid 一致
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\a1b2c3d4-e5f6-7890-abcd-ef1234567890" "QuietUninstallString"
  ${If} $R0 == ""
    ReadRegStr $R0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\a1b2c3d4-e5f6-7890-abcd-ef1234567890" "QuietUninstallString"
  ${EndIf}

  ${If} $R0 != ""
    MessageBox MB_YESNO|MB_ICONQUESTION "检测到已安装的旧版本 WhatyTerm，需要先卸载才能继续安装。$\n$\n是否自动卸载旧版本？" IDYES +2
    Abort
    ; 执行静默卸载（QuietUninstallString 已包含 /S 参数）
    ExecWait '$R0 --force-run'
    Sleep 3000
  ${EndIf}
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

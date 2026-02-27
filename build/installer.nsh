; 自定义 NSIS 安装脚本 - 安装前强制关闭运行中的程序并卸载旧版本

; 定义关闭进程的宏，可重复调用
!macro KillAllProcesses
  ; 使用多种方式确保进程被关闭
  ; 方式1: taskkill 强制关闭
  nsExec::ExecToStack 'taskkill /F /T /IM WhatyTerm.exe'
  Pop $0
  Pop $1
  nsExec::ExecToStack 'taskkill /F /IM node.exe'
  Pop $0
  Pop $1
  nsExec::ExecToStack 'taskkill /F /IM frpc.exe'
  Pop $0
  Pop $1
  nsExec::ExecToStack 'taskkill /F /IM cloudflared.exe'
  Pop $0
  Pop $1

  ; 方式2: wmic 作为备选
  nsExec::ExecToStack 'wmic process where "name=\'WhatyTerm.exe\'" delete'
  Pop $0
  Pop $1
  nsExec::ExecToStack 'wmic process where "name=\'node.exe\' and CommandLine like \'%WhatyTerm%\'" delete'
  Pop $0
  Pop $1

  Sleep 1500
!macroend

; 覆盖默认的应用运行检测 - 直接关闭进程，不弹窗询问
!macro customCheckAppRunning
  !insertmacro KillAllProcesses
  ; 再次尝试，确保关闭
  !insertmacro KillAllProcesses
!macroend

!macro customInit
  ; 首先关闭所有相关进程
  !insertmacro KillAllProcesses

  ; 检查是否有旧版本安装
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\a1b2c3d4-e5f6-7890-abcd-ef1234567890" "QuietUninstallString"
  ${If} $R0 == ""
    ReadRegStr $R0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\a1b2c3d4-e5f6-7890-abcd-ef1234567890" "QuietUninstallString"
  ${EndIf}

  ${If} $R0 != ""
    ; 卸载前再次关闭进程
    !insertmacro KillAllProcesses

    MessageBox MB_YESNO|MB_ICONQUESTION "检测到已安装的旧版本 WhatyTerm，需要先卸载才能继续。$\n$\n是否自动卸载旧版本？" IDYES +2
    Abort

    ; 卸载前最后一次关闭进程
    !insertmacro KillAllProcesses

    ; 执行静默卸载
    ExecWait '$R0 --force-run'

    ; 等待卸载完成并再次清理
    Sleep 3000
    !insertmacro KillAllProcesses
  ${EndIf}
!macroend

!macro customUnInit
  ; 卸载前关闭所有相关进程
  !insertmacro KillAllProcesses
  !insertmacro KillAllProcesses
!macroend

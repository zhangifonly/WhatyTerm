; 自定义 NSIS 安装脚本 - 安装前自动卸载旧版本

; 关闭相关进程
!macro KillProcesses
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
  Sleep 1500
!macroend

; 覆盖默认的应用运行检测 - 直接关闭进程，不弹窗
!macro customCheckAppRunning
  !insertmacro KillProcesses
!macroend

!macro customInit
  ; 先关闭所有相关进程
  !insertmacro KillProcesses

  ; electron-builder 注册表键有两种格式：带花括号和不带花括号
  ; 依次尝试 HKCU（用户级）和 HKLM（机器级），带/不带花括号

  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\{a1b2c3d4-e5f6-7890-abcd-ef1234567890}" "UninstallString"
  StrCmp $R0 "" +3 0
    nsExec::ExecToStack '$R0 /S'
    Goto wait_uninst

  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\a1b2c3d4-e5f6-7890-abcd-ef1234567890" "UninstallString"
  StrCmp $R0 "" +3 0
    nsExec::ExecToStack '$R0 /S'
    Goto wait_uninst

  ReadRegStr $R0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\{a1b2c3d4-e5f6-7890-abcd-ef1234567890}" "UninstallString"
  StrCmp $R0 "" +3 0
    nsExec::ExecToStack '$R0 /S'
    Goto wait_uninst

  ReadRegStr $R0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\a1b2c3d4-e5f6-7890-abcd-ef1234567890" "UninstallString"
  StrCmp $R0 "" done 0
    nsExec::ExecToStack '$R0 /S'
    Goto wait_uninst

  wait_uninst:
    Pop $R1  ; 弹出 nsExec 返回值
    Pop $R2  ; 弹出输出
    Sleep 3000  ; 等待卸载完成

  done:
!macroend

!macro customUnInit
  !insertmacro KillProcesses
!macroend

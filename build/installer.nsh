; 自定义 NSIS 安装脚本 - 自动卸载旧版本

!macro customInit
  ; 检查是否已安装旧版本
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\{${APP_GUID}}" "UninstallString"
  ${If} $0 != ""
    MessageBox MB_YESNO|MB_ICONQUESTION "检测到已安装的 WhatyTerm，是否先卸载旧版本？$\n$\n建议选择「是」以避免冲突。" IDYES uninst IDNO done
    uninst:
      ; 获取卸载程序路径
      ReadRegStr $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\{${APP_GUID}}" "InstallLocation"
      ${If} $1 != ""
        ; 静默卸载旧版本
        ExecWait '"$0" /S _?=$1'
        ; 删除残留目录
        RMDir /r "$1"
      ${EndIf}
    done:
  ${EndIf}
!macroend

!macro customUnInit
  ; 卸载前关闭正在运行的程序
  nsExec::ExecToLog 'taskkill /F /IM WhatyTerm.exe'
!macroend

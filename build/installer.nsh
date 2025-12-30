; 自定义 NSIS 安装脚本 - 自动卸载旧版本并杀掉相关进程

!macro customInit
  ; 首先杀掉所有相关进程，避免文件被锁定
  nsExec::ExecToLog 'taskkill /F /IM WhatyTerm.exe'
  nsExec::ExecToLog 'taskkill /F /IM frpc.exe'
  nsExec::ExecToLog 'taskkill /F /IM cloudflared.exe'

  ; 等待进程完全退出
  Sleep 1000

  ; 检查是否已安装旧版本
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\{${APP_GUID}}" "UninstallString"
  ${If} $0 != ""
    MessageBox MB_YESNO|MB_ICONQUESTION "检测到已安装的 WhatyTerm，是否先卸载旧版本？$\n$\n建议选择「是」以避免冲突。" IDYES uninst IDNO done
    uninst:
      ; 再次确保进程已关闭
      nsExec::ExecToLog 'taskkill /F /IM WhatyTerm.exe'
      nsExec::ExecToLog 'taskkill /F /IM frpc.exe'
      nsExec::ExecToLog 'taskkill /F /IM cloudflared.exe'
      Sleep 500

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
  ; 卸载前关闭所有相关进程
  nsExec::ExecToLog 'taskkill /F /IM WhatyTerm.exe'
  nsExec::ExecToLog 'taskkill /F /IM frpc.exe'
  nsExec::ExecToLog 'taskkill /F /IM cloudflared.exe'
  Sleep 1000
!macroend

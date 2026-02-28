; 自定义 NSIS 安装脚本 - 安装前自动卸载旧版本
; 参考: https://nsis.sourceforge.io/Auto-uninstall_old_before_installing_new

!include "FileFunc.nsh"

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
  Sleep 1000
!macroend

; 覆盖默认的应用运行检测 - 直接关闭进程，不弹窗
!macro customCheckAppRunning
  !insertmacro KillProcesses
!macroend

!macro customInit
  ; 先关闭所有相关进程
  !insertmacro KillProcesses

  ; 检查用户级安装的卸载程序
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\a1b2c3d4-e5f6-7890-abcd-ef1234567890" "UninstallString"
  StrCmp $R0 "" check_hklm found_uninst

  check_hklm:
    ; 检查机器级安装
    ReadRegStr $R0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\a1b2c3d4-e5f6-7890-abcd-ef1234567890" "UninstallString"
    StrCmp $R0 "" done found_uninst

  found_uninst:
    MessageBox MB_YESNO|MB_ICONQUESTION "检测到已安装的旧版本 WhatyTerm，需要先卸载才能继续。$\n$\n是否自动卸载旧版本？" IDYES do_uninst
    Abort

  do_uninst:
    ; 卸载前再次关闭进程
    !insertmacro KillProcesses

    ; 从 UninstallString 提取卸载程序路径（去掉引号）
    StrCpy $R1 $R0 1
    StrCmp $R1 '"' 0 +3
      StrCpy $R0 $R0 "" 1  ; 去掉开头引号
      StrCpy $R0 $R0 -1    ; 去掉结尾引号

    ; 获取安装目录（使用内置的 GetParent）
    ${GetParent} $R0 $R1

    ; 使用 _?= 参数同步执行卸载，等待完成
    ExecWait '"$R0" /S _?=$R1' $R2

    ; 检查卸载结果
    IntCmp $R2 0 uninst_ok
      MessageBox MB_YESNO|MB_ICONSTOP "卸载失败 (错误码: $R2)，是否继续安装？" IDYES done
      Abort

  uninst_ok:
    ; 卸载成功，删除卸载程序（因为 _?= 参数会保留它）
    Delete "$R0"
    RMDir "$R1"
    Sleep 1000

  done:
!macroend

!macro customUnInit
  !insertmacro KillProcesses
!macroend

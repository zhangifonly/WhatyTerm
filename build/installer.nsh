; 自定义 NSIS 安装脚本 - 简化版，只处理卸载旧版本

!macro customInit
  ; electron-builder 注册表键格式：带花括号
  ; 依次尝试 HKCU（用户级）和 HKLM（机器级）

  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\{a1b2c3d4-e5f6-7890-abcd-ef1234567890}" "UninstallString"
  StrCmp $R0 "" try_hkcu_no_brace 0
    nsExec::ExecToStack '$R0 /S'
    Pop $R1
    Pop $R2
    Sleep 3000
    Goto done

  try_hkcu_no_brace:
    ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\a1b2c3d4-e5f6-7890-abcd-ef1234567890" "UninstallString"
    StrCmp $R0 "" try_hklm 0
      nsExec::ExecToStack '$R0 /S'
      Pop $R1
      Pop $R2
      Sleep 3000
      Goto done

  try_hklm:
    ReadRegStr $R0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\{a1b2c3d4-e5f6-7890-abcd-ef1234567890}" "UninstallString"
    StrCmp $R0 "" try_hklm_no_brace 0
      nsExec::ExecToStack '$R0 /S'
      Pop $R1
      Pop $R2
      Sleep 3000
      Goto done

  try_hklm_no_brace:
    ReadRegStr $R0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\a1b2c3d4-e5f6-7890-abcd-ef1234567890" "UninstallString"
    StrCmp $R0 "" done 0
      nsExec::ExecToStack '$R0 /S'
      Pop $R1
      Pop $R2
      Sleep 3000

  done:
!macroend

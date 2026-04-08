; 自定义 NSIS 安装脚本

; 禁用 CRC 校验，解决 "无法关闭" 误报问题
; 参考: https://github.com/electron-userland/electron-builder/issues/6409
CRCCheck off

; 完全禁用应用运行检测（避免误报）
!macro customCheckAppRunning
  FileOpen $9 "$TEMP\whatyterm-install.log" a
  FileSeek $9 0 END
  FileWrite $9 "[CHECK_APP_RUNNING] skipped$\r$\n"
  FileClose $9
!macroend

!macro customInit
  ; 初始化日志
  FileOpen $9 "$TEMP\whatyterm-install.log" w
  FileWrite $9 "=== WhatyTerm Installer Log ===$\r$\n"
  FileWrite $9 "Install dir: $INSTDIR$\r$\n"
  FileClose $9

  ; 第一步：精细杀 WhatyTerm 主进程，**保留 mux-server 进程**
  ; 重要背景：
  ;   - mux-server 也叫 WhatyTerm.exe（用 process.execPath 启动）
  ;   - 但命令行包含 "mux-server" 路径，可以用此区分
  ;   - mux-server 持有所有 PTY 子进程，杀掉它就丢失所有会话
  ;   - 普通 taskkill /IM 会按名字杀光所有 WhatyTerm.exe，导致会话丢失
  ; 用 PowerShell 按 CommandLine 过滤，跳过 mux-server
  nsExec::ExecToStack 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"Name=''WhatyTerm.exe''\" | Where-Object { $_.CommandLine -notlike ''*mux-server*'' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"'
  Pop $R1
  Pop $R2
  FileOpen $9 "$TEMP\whatyterm-install.log" a
  FileSeek $9 0 END
  FileWrite $9 "[KILL] PS kill WhatyTerm (preserve mux-server): exit=$R1$\r$\n"
  FileClose $9

  ; 杀掉 Windows 终端 helper 进程（这些是文件锁的主要来源）
  ; OpenConsole / winpty-agent 是 WhatyTerm 主进程的 PTY helper，
  ; 不持有 mux-server / tmux 状态，杀掉是安全的
  nsExec::ExecToStack 'taskkill /F /IM "OpenConsole.exe"'
  Pop $R1
  Pop $R2
  FileOpen $9 "$TEMP\whatyterm-install.log" a
  FileSeek $9 0 END
  FileWrite $9 "[KILL] taskkill OpenConsole: exit=$R1$\r$\n"
  FileClose $9

  nsExec::ExecToStack 'taskkill /F /IM "winpty-agent.exe"'
  Pop $R1
  Pop $R2
  FileOpen $9 "$TEMP\whatyterm-install.log" a
  FileSeek $9 0 END
  FileWrite $9 "[KILL] taskkill winpty-agent: exit=$R1$\r$\n"
  FileClose $9

  ; 等待 OS 释放文件锁
  Sleep 3000

  ; 第二步：清理所有已知的旧版本注册表项和安装目录
  ; 旧 GUID (1.0.27及之前)
  ReadRegStr $R0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\8ea16e8d-e415-59b3-aa87-614fb8451e42" "UninstallString"
  StrCmp $R0 "" +4 0
    FileOpen $9 "$TEMP\whatyterm-install.log" a
    FileSeek $9 0 END
    FileWrite $9 "[CLEANUP] Deleting old GUID reg key: 8ea16e8d...$\r$\n"
    FileClose $9
    DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\8ea16e8d-e415-59b3-aa87-614fb8451e42"

  ; 当前 GUID - HKLM
  ReadRegStr $R0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\a1b2c3d4-e5f6-7890-abcd-ef1234567890" "UninstallString"
  StrCmp $R0 "" +4 0
    FileOpen $9 "$TEMP\whatyterm-install.log" a
    FileSeek $9 0 END
    FileWrite $9 "[CLEANUP] Deleting HKLM reg key: a1b2c3d4..., uninstall=$R0$\r$\n"
    FileClose $9
    DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\a1b2c3d4-e5f6-7890-abcd-ef1234567890"

  ; 当前 GUID - HKLM 带花括号
  ReadRegStr $R0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\{a1b2c3d4-e5f6-7890-abcd-ef1234567890}" "UninstallString"
  StrCmp $R0 "" +4 0
    FileOpen $9 "$TEMP\whatyterm-install.log" a
    FileSeek $9 0 END
    FileWrite $9 "[CLEANUP] Deleting HKLM reg key: {a1b2c3d4...}$\r$\n"
    FileClose $9
    DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\{a1b2c3d4-e5f6-7890-abcd-ef1234567890}"

  ; 当前 GUID - HKCU
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\a1b2c3d4-e5f6-7890-abcd-ef1234567890" "UninstallString"
  StrCmp $R0 "" +4 0
    FileOpen $9 "$TEMP\whatyterm-install.log" a
    FileSeek $9 0 END
    FileWrite $9 "[CLEANUP] Deleting HKCU reg key: a1b2c3d4...$\r$\n"
    FileClose $9
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\a1b2c3d4-e5f6-7890-abcd-ef1234567890"

  ; 当前 GUID - HKCU 带花括号
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\{a1b2c3d4-e5f6-7890-abcd-ef1234567890}" "UninstallString"
  StrCmp $R0 "" +4 0
    FileOpen $9 "$TEMP\whatyterm-install.log" a
    FileSeek $9 0 END
    FileWrite $9 "[CLEANUP] Deleting HKCU reg key: {a1b2c3d4...}$\r$\n"
    FileClose $9
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\{a1b2c3d4-e5f6-7890-abcd-ef1234567890}"

  ; 第三步：删除旧安装目录（使用 $INSTDIR，即用户选择的安装路径）
  IfFileExists "$INSTDIR\WhatyTerm.exe" 0 no_old_files
    FileOpen $9 "$TEMP\whatyterm-install.log" a
    FileSeek $9 0 END
    FileWrite $9 "[CLEANUP] Found old files at $INSTDIR, removing...$\r$\n"
    FileClose $9
    RMDir /r "$INSTDIR"
    Sleep 1000
    FileOpen $9 "$TEMP\whatyterm-install.log" a
    FileSeek $9 0 END
    FileWrite $9 "[CLEANUP] RMDir completed$\r$\n"
    FileClose $9
    Goto done

  no_old_files:
    FileOpen $9 "$TEMP\whatyterm-install.log" a
    FileSeek $9 0 END
    FileWrite $9 "[CLEANUP] No old files at $INSTDIR$\r$\n"
    FileClose $9

  done:
    FileOpen $9 "$TEMP\whatyterm-install.log" a
    FileSeek $9 0 END
    FileWrite $9 "[DONE] customInit completed.$\r$\n"
    FileClose $9
!macroend

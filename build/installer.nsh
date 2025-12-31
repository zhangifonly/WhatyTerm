; 自定义 NSIS 安装脚本 - 简化版，只终止进程，不检测旧版本
; 请求管理员权限
RequestExecutionLevel admin

!macro customInit
  ; 终止所有相关进程，避免文件被锁定
  nsExec::ExecToLog 'taskkill /F /IM WhatyTerm.exe'
  nsExec::ExecToLog 'taskkill /F /IM frpc.exe'
  nsExec::ExecToLog 'taskkill /F /IM cloudflared.exe'
  Sleep 1000
!macroend

!macro customInstall
  ; 配置 Windows Defender 排除项（需要管理员权限）
  DetailPrint "正在配置 Windows Defender 排除项..."

  ; 添加安装目录的 bin/windows 文件夹
  nsExec::ExecToLog 'powershell -ExecutionPolicy Bypass -Command "try { Add-MpPreference -ExclusionPath \"$INSTDIR\resources\server\bin\windows\\" -ErrorAction Stop; Write-Host \"已添加排除项: $INSTDIR\resources\server\bin\windows\\\" } catch { Write-Host \"添加排除项失败: $_\" }"'

  ; 添加用户目录的 .webtmux/bin 文件夹
  nsExec::ExecToLog 'powershell -ExecutionPolicy Bypass -Command "try { $$userPath = Join-Path $$env:USERPROFILE \".webtmux\bin\\\"; Add-MpPreference -ExclusionPath $$userPath -ErrorAction Stop; Write-Host \"已添加排除项: $$userPath\" } catch { Write-Host \"添加排除项失败: $$_\" }"'

  DetailPrint "Windows Defender 配置完成"
  ; 注意：即使失败也不阻止安装
!macroend

!macro customUnInit
  ; 卸载前关闭所有相关进程
  nsExec::ExecToLog 'taskkill /F /IM WhatyTerm.exe'
  nsExec::ExecToLog 'taskkill /F /IM frpc.exe'
  nsExec::ExecToLog 'taskkill /F /IM cloudflared.exe'
  Sleep 1000
!macroend

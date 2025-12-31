# 添加 Windows Defender 排除项
param(
    [string]$InstallDir
)

try {
    # 添加安装目录的 bin/windows 文件夹
    $binPath = Join-Path $InstallDir "resources\server\bin\windows\"
    Add-MpPreference -ExclusionPath $binPath -ErrorAction Stop
    Write-Host "已添加排除项: $binPath"
} catch {
    Write-Host "添加安装目录排除项失败: $_"
}

try {
    # 添加用户目录的 .webtmux/bin 文件夹
    $userPath = Join-Path $env:USERPROFILE ".webtmux\bin\"
    Add-MpPreference -ExclusionPath $userPath -ErrorAction Stop
    Write-Host "已添加排除项: $userPath"
} catch {
    Write-Host "添加用户目录排除项失败: $_"
}

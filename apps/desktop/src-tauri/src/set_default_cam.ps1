# 暫時停用真實攝影機，讓所有 App 只看到 OBS Virtual Camera
# 用法：
#   -Action set    → 停用真實攝影機（儲存清單以便還原）
#   -Action restore → 還原被停用的攝影機
param([string]$Action = "set", [string]$SaveFile = "$env:TEMP\ai-avatar-disabled-cams.txt")

if ($Action -eq "set") {
    # 找出所有攝影機裝置（排除 OBS Virtual Camera）
    $cams = Get-PnpDevice -Class Camera -Status OK -ErrorAction SilentlyContinue |
        Where-Object { $_.FriendlyName -notmatch "OBS" }

    # 也檢查 Image 類別（有些攝影機在此類別下）
    $imgCams = Get-PnpDevice -Class Image -Status OK -ErrorAction SilentlyContinue |
        Where-Object { $_.FriendlyName -match "Camera|Webcam|cam" -and $_.FriendlyName -notmatch "OBS" }

    $allCams = @()
    if ($cams) { $allCams += $cams }
    if ($imgCams) { $allCams += $imgCams }

    if ($allCams.Count -eq 0) {
        Write-Host "NO_REAL_CAM"
        exit 0
    }

    # 儲存被停用的裝置 InstanceId（還原用）
    $ids = @()
    foreach ($cam in $allCams) {
        $ids += $cam.InstanceId
        Disable-PnpDevice -InstanceId $cam.InstanceId -Confirm:$false -ErrorAction SilentlyContinue
        Write-Host "DISABLED:$($cam.FriendlyName)"
    }
    Set-Content -Path $SaveFile -Value ($ids -join "`n") -NoNewline
    Write-Host "OK"

} elseif ($Action -eq "restore") {
    if (Test-Path $SaveFile) {
        $ids = Get-Content -Path $SaveFile
        foreach ($id in $ids) {
            if ($id.Trim()) {
                Enable-PnpDevice -InstanceId $id.Trim() -Confirm:$false -ErrorAction SilentlyContinue
                Write-Host "ENABLED:$id"
            }
        }
        Remove-Item $SaveFile -ErrorAction SilentlyContinue
        Write-Host "RESTORED"
    } else {
        Write-Host "NOSAVE"
    }
}

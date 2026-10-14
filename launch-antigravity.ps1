# Launch Antigravity with Remote Debugging Port enabled (default 9333)

param(
    [int]$Port = 9333,
    [switch]$UpdateShortcut
)

$exePath = "$env:LOCALAPPDATA\Programs\antigravity\Antigravity.exe"

if (-not (Test-Path $exePath)) {
    Write-Error "Could not find Antigravity at $exePath"
    exit 1
}

if ($UpdateShortcut) {
    $desktopShortcut = "$env:USERPROFILE\Desktop\Antigravity.lnk"
    $startMenuShortcut = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Antigravity.lnk"

    $wscript = New-Object -ComObject WScript.Shell
    foreach ($path in @($desktopShortcut, $startMenuShortcut)) {
        if (Test-Path $path) {
            $shortcut = $wscript.CreateShortcut($path)
            $shortcut.Arguments = "--remote-debugging-port=$Port"
            $shortcut.Save()
            Write-Host "Updated shortcut at: $path with --remote-debugging-port=$Port" -ForegroundColor Green
        }
    }
}

Write-Host "Starting Antigravity with --remote-debugging-port=$Port..." -ForegroundColor Cyan
Start-Process -FilePath $exePath -ArgumentList "--remote-debugging-port=$Port"
Write-Host "Antigravity launched. You can now run: npm start" -ForegroundColor Green

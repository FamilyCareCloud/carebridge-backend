$ErrorActionPreference = "Stop"
$backendRepo = Split-Path -Parent $PSScriptRoot
$manifest = Join-Path $backendRepo "data/carebridge-processes.json"
if (-not (Test-Path -LiteralPath $manifest)) { Write-Output "실행 기록이 없습니다."; return }
$entries = Get-Content -Raw -LiteralPath $manifest | ConvertFrom-Json
foreach ($entry in $entries) {
    $process = Get-Process -Id $entry.pid -ErrorAction SilentlyContinue
    if ($process -and $process.StartTime.ToUniversalTime().Ticks -eq ([DateTimeOffset]$entry.startedAt).UtcDateTime.Ticks) {
        & taskkill.exe /PID $entry.pid /T /F 2>$null | Out-Null
        Write-Output "$($entry.name) 종료"
    }
}
Remove-Item -LiteralPath $manifest

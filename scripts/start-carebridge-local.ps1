param(
    [string]$AiRepo = "",
    [string]$FrontendRepo = "",
    [string]$Python = "",
    [int]$AiPort = 8002,
    [int]$BackendPort = 3002,
    [int]$FrontendPort = 5174
)
$ErrorActionPreference = "Stop"
$backendRepo = Split-Path -Parent $PSScriptRoot
$siblings = Split-Path -Parent $backendRepo
if (-not $AiRepo) {
    $AiRepo = Join-Path $siblings "carebridge-ai"
    if (-not (Test-Path -LiteralPath $AiRepo)) { $AiRepo = Join-Path $siblings "fcc-ai" }
}
if (-not $FrontendRepo) { $FrontendRepo = Join-Path $siblings "fcc-frontend" }
if (-not $Python) { $Python = Join-Path $AiRepo ".venv/Scripts/python.exe" }
foreach ($path in @($AiRepo,$FrontendRepo,$Python)) {
    if (-not (Test-Path -LiteralPath $path)) { throw "필요한 경로가 없습니다: $path" }
}
foreach ($port in @($AiPort,$BackendPort,$FrontendPort)) {
    if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
        throw "$port 포트를 다른 프로세스가 사용 중입니다. 기존 서버를 확인한 뒤 실행하세요."
    }
}
$logDir = Join-Path $backendRepo "data"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$envFile = Join-Path $AiRepo ".env"
$values = if (Test-Path -LiteralPath $envFile) { Get-Content -LiteralPath $envFile } else { @() }
$keyLine = $values | Where-Object { $_ -match '^FCC_AI_API_KEY=.+$' } | Select-Object -First 1
if ($keyLine) { $serviceKey = $keyLine.Substring("FCC_AI_API_KEY=".Length).Trim() }
else {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes); $rng.Dispose()
    $serviceKey = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
    $newValues = @($values | Where-Object { $_ -notmatch '^FCC_AI_API_KEY=' }) + "FCC_AI_API_KEY=$serviceKey"
    [IO.File]::WriteAllLines($envFile,$newValues,(New-Object Text.UTF8Encoding($false)))
}
$env:FCC_AI_API_KEY = $serviceKey
$env:FCC_AI_CAREBRIDGE_BACKEND = "local"
$env:FCC_AI_CAREBRIDGE_PRELOAD = "true"
$env:FCC_AI_CAREBRIDGE_SEMANTIC_CHECK_ENABLED = "true"
$env:FCC_AI_CAREBRIDGE_TIMEOUT_SECONDS = "10"
$env:FCC_AI_STT_ENABLED = "true"
$env:CAREBRIDGE_SERVICE_URL = "http://127.0.0.1:$AiPort"
$env:CAREBRIDGE_SERVICE_API_KEY = $serviceKey
$env:PORT = "$BackendPort"
$env:DATA_FILE = Join-Path $logDir "carebridge-local.json"
$env:VITE_DEV_PROXY_TARGET = "http://127.0.0.1:$BackendPort"
$env:VITE_API_BASE_URL = "/"
$env:PYTHONIOENCODING = "utf-8"
$started = @()
function Start-ServiceProcess($name,$file,$arguments,$cwd) {
    $process = Start-Process -FilePath $file -ArgumentList $arguments -WorkingDirectory $cwd -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDir "$name.log") -RedirectStandardError (Join-Path $logDir "$name.err.log")
    return @{ name=$name; pid=$process.Id; startedAt=$process.StartTime.ToUniversalTime().ToString("o") }
}
function Wait-Service($url) {
    for ($attempt=0; $attempt -lt 45; $attempt++) {
        try { $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2; if ($response.StatusCode -eq 200) { return } } catch {}
        Start-Sleep -Milliseconds 1000
    }
    throw "서버가 준비되지 않았습니다: $url. data 폴더의 로그를 확인하세요."
}
try {
    $started += Start-ServiceProcess "carebridge-ai" $Python @("-m","uvicorn","app.main:app","--host","127.0.0.1","--port","$AiPort","--workers","1") $AiRepo
    Wait-Service "http://127.0.0.1:$AiPort/health"
    $aiHealth = Invoke-RestMethod -Uri "http://127.0.0.1:$AiPort/health" -TimeoutSec 5
    if ($aiHealth.carebridge_qa_revision -ne "carebridge.qa.v2") {
        throw "CareBridge AI qa.v2 is required. Update carebridge-ai before starting this backend."
    }
    $node = (Get-Command node -ErrorAction Stop).Source
    $started += Start-ServiceProcess "carebridge-backend" $node @("--env-file-if-exists=.env","src/server.js") $backendRepo
    Wait-Service "http://127.0.0.1:$BackendPort/health"
    $started += Start-ServiceProcess "carebridge-frontend" $node @("node_modules/vite/bin/vite.js","--host","127.0.0.1","--port","$FrontendPort","--strictPort") $FrontendRepo
    Wait-Service "http://127.0.0.1:$FrontendPort/"
    $started | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $logDir "carebridge-processes.json") -Encoding utf8
    Write-Output "케어브릿지 실행 완료: http://127.0.0.1:$FrontendPort"
    Write-Output "로그와 로컬 데이터: $logDir"
}
catch {
    foreach ($entry in $started) {
        $process = Get-Process -Id $entry.pid -ErrorAction SilentlyContinue
        if ($process -and $process.StartTime.ToUniversalTime().ToString("o") -eq $entry.startedAt) { & taskkill.exe /PID $entry.pid /T /F 2>$null | Out-Null }
    }
    throw
}

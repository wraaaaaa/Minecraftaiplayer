$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$entryPoint = Join-Path $projectRoot 'dist\src\webui\server.js'
$pidFile = Join-Path $projectRoot 'data\webui.pid.json'
$stdoutLog = Join-Path $projectRoot 'logs\webui.stdout.log'
$stderrLog = Join-Path $projectRoot 'logs\webui.stderr.log'
if (-not (Test-Path -LiteralPath $entryPoint)) { throw 'WebUI build output is missing. Run npm run build first.' }

function Test-ProjectProcess($record, [string]$marker) {
    if (-not $record -or -not $record.pid -or -not $record.executable) { return $false }
    $candidate = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
    if (-not $candidate -or $candidate.Path -ne $record.executable) { return $false }
    $details = Get-CimInstance Win32_Process -Filter "ProcessId=$($record.pid)" -ErrorAction SilentlyContinue
    return $details -and -not [string]::IsNullOrWhiteSpace($details.CommandLine) -and $details.CommandLine.IndexOf($marker, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

$webUiPort = 3210
if (-not [string]::IsNullOrWhiteSpace($env:MCAI_WEBUI_PORT)) {
    $parsedPort = 0
    if (-not [int]::TryParse($env:MCAI_WEBUI_PORT, [ref]$parsedPort) -or $parsedPort -lt 1 -or $parsedPort -gt 65535) { throw 'MCAI_WEBUI_PORT must be an integer from 1 to 65535.' }
    $webUiPort = $parsedPort
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $pidFile), (Split-Path -Parent $stdoutLog) | Out-Null
if (Test-Path -LiteralPath $pidFile) {
    $existing = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
    if (Test-ProjectProcess $existing $entryPoint) {
        Write-Output "WebUI is already running. PID=$($existing.pid)"
        exit 0
    }
    Remove-Item -LiteralPath $pidFile -Force
}

$listener = Get-NetTCPConnection -State Listen -LocalPort $webUiPort -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
    if ($owner -and -not [string]::IsNullOrWhiteSpace($owner.CommandLine) -and $owner.CommandLine.IndexOf($entryPoint, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        $nodeCommand = (Get-Process -Id $listener.OwningProcess -ErrorAction Stop).Path
        @{ pid = $listener.OwningProcess; executable = $nodeCommand; projectRoot = $projectRoot; entryPoint = $entryPoint; startedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding UTF8
        Write-Output "WebUI is already running. PID=$($listener.OwningProcess)"
        exit 0
    }
    throw "WebUI port $webUiPort is occupied by another process or project directory. Stop the old control center before opening this copy."
}

$nodeCommand = (Get-Command node -ErrorAction Stop).Source
$process = Start-Process -FilePath $nodeCommand -ArgumentList @('"' + $entryPoint + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
Start-Sleep -Milliseconds 1000
if ($process.HasExited) { throw "WebUI exited during startup. Check $stderrLog" }
@{ pid = $process.Id; executable = $nodeCommand; projectRoot = $projectRoot; entryPoint = $entryPoint; startedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding UTF8
Write-Output "WebUI started locally. PID=$($process.Id)"

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$entryPoint = Join-Path $projectRoot 'dist\src\webui\server.js'
$pidFile = Join-Path $projectRoot 'data\webui.pid.json'
$stdoutLog = Join-Path $projectRoot 'logs\webui.stdout.log'
$stderrLog = Join-Path $projectRoot 'logs\webui.stderr.log'
if (-not (Test-Path -LiteralPath $entryPoint)) { throw 'WebUI build output is missing. Run npm run build first.' }

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $pidFile), (Split-Path -Parent $stdoutLog) | Out-Null
if (Test-Path -LiteralPath $pidFile) {
    $existing = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
    $existingProcess = Get-Process -Id $existing.pid -ErrorAction SilentlyContinue
    if ($existingProcess -and $existingProcess.Path -eq $existing.executable) {
        Write-Output "WebUI is already running. PID=$($existing.pid)"
        exit 0
    }
}

$nodeCommand = (Get-Command node -ErrorAction Stop).Source
$process = Start-Process -FilePath $nodeCommand -ArgumentList @('"' + $entryPoint + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
Start-Sleep -Milliseconds 1000
if ($process.HasExited) { throw "WebUI exited during startup. Check $stderrLog" }
@{ pid = $process.Id; executable = $nodeCommand; startedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding UTF8
Write-Output "WebUI started locally. PID=$($process.Id)"

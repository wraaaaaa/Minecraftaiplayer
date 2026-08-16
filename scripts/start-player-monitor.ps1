$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$entryPoint = Join-Path $projectRoot 'dist\src\player-monitor.js'
$pidFile = Join-Path $projectRoot 'data\player-monitor.pid.json'
$stdoutLog = Join-Path $projectRoot 'logs\player-monitor.stdout.log'
$stderrLog = Join-Path $projectRoot 'logs\player-monitor.stderr.log'

if (-not (Test-Path -LiteralPath $entryPoint)) {
    throw 'Build output is missing. Run npm run build first.'
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $pidFile), (Split-Path -Parent $stdoutLog) | Out-Null
if (Test-Path -LiteralPath $pidFile) {
    $existing = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
    $existingProcess = Get-Process -Id $existing.pid -ErrorAction SilentlyContinue
    $existingDetails = Get-CimInstance Win32_Process -Filter "ProcessId=$($existing.pid)" -ErrorAction SilentlyContinue
    if ($existingProcess -and $existingProcess.Path -eq $existing.executable -and $existingDetails -and -not [string]::IsNullOrWhiteSpace($existingDetails.CommandLine) -and $existingDetails.CommandLine.IndexOf($entryPoint, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        Write-Output "Player monitor is already running in background. PID=$($existing.pid)"
        exit 0
    }
    Remove-Item -LiteralPath $pidFile -Force
}

$nodeCommand = (Get-Command node -ErrorAction Stop).Source
$quotedEntryPoint = '"' + $entryPoint + '"'
$process = Start-Process -FilePath $nodeCommand -ArgumentList @($quotedEntryPoint) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
Start-Sleep -Milliseconds 1500
if ($process.HasExited) {
    throw "Player monitor exited during startup. Check $stderrLog"
}
$record = [ordered]@{
    pid = $process.Id
    executable = $nodeCommand
    projectRoot = $projectRoot
    entryPoint = $entryPoint
    startedAt = (Get-Date).ToUniversalTime().ToString('o')
}
$record | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding UTF8
Write-Output "Player monitor started silently. PID=$($process.Id)"

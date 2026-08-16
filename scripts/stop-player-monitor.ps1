$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$entryPoint = Join-Path $projectRoot 'dist\src\player-monitor.js'
$userDataRoot = if ([string]::IsNullOrWhiteSpace($env:MCAI_USERDATA_DIR)) { Join-Path $projectRoot 'userdata' } else { $env:MCAI_USERDATA_DIR }
$pidFile = Join-Path $userDataRoot 'data\player-monitor.pid.json'

if (-not (Test-Path -LiteralPath $pidFile)) {
    Write-Output 'No player monitor PID file was found.'
    exit 0
}

$record = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
$process = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
if (-not $process) {
    Remove-Item -LiteralPath $pidFile -Force
    Write-Output 'The player monitor had already ended; the stale PID file was removed.'
    exit 0
}

if ($process.Path -ne $record.executable) {
    throw "PID $($record.pid) belongs to another executable; refusing to stop it."
}
$details = Get-CimInstance Win32_Process -Filter "ProcessId=$($record.pid)" -ErrorAction SilentlyContinue
if (-not $details -or [string]::IsNullOrWhiteSpace($details.CommandLine) -or $details.CommandLine.IndexOf($entryPoint, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
    throw "PID $($record.pid) belongs to another project directory; refusing to stop it."
}

Stop-Process -Id $record.pid
[void]$process.WaitForExit(10000)
Remove-Item -LiteralPath $pidFile -Force
Write-Output "Player monitor stopped. PID=$($record.pid)"

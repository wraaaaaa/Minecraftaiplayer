$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$entryPoint = Join-Path $projectRoot 'dist\src\webui\server.js'
$pidFile = Join-Path $projectRoot 'data\webui.pid.json'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Output 'No WebUI PID file was found.'; exit 0 }
$record = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
$process = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
if (-not $process) { Remove-Item -LiteralPath $pidFile -Force; Write-Output 'The WebUI had already stopped.'; exit 0 }
if ($process.Path -ne $record.executable) { throw "PID $($record.pid) belongs to another executable; refusing to stop it." }
$details = Get-CimInstance Win32_Process -Filter "ProcessId=$($record.pid)" -ErrorAction SilentlyContinue
if (-not $details -or [string]::IsNullOrWhiteSpace($details.CommandLine) -or $details.CommandLine.IndexOf($entryPoint, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
    throw "PID $($record.pid) belongs to another project directory; refusing to stop it."
}
Stop-Process -Id $record.pid
[void]$process.WaitForExit(10000)
Remove-Item -LiteralPath $pidFile -Force
Write-Output "WebUI stopped. PID=$($record.pid)"

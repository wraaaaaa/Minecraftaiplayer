$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $projectRoot 'data\webui.pid.json'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Output 'No WebUI PID file was found.'; exit 0 }
$record = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
$process = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
if (-not $process) { Remove-Item -LiteralPath $pidFile -Force; Write-Output 'The WebUI had already stopped.'; exit 0 }
if ($process.Path -ne $record.executable) { throw "PID $($record.pid) belongs to another executable; refusing to stop it." }
Stop-Process -Id $record.pid
[void]$process.WaitForExit(10000)
Remove-Item -LiteralPath $pidFile -Force
Write-Output "WebUI stopped. PID=$($record.pid)"

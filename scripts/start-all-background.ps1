$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$botWasRunning = $false
$botPidFile = Join-Path $projectRoot 'data\bot.pid.json'
if (Test-Path -LiteralPath $botPidFile) {
    try {
        $record = Get-Content -LiteralPath $botPidFile -Raw | ConvertFrom-Json
        $botWasRunning = [bool](Get-Process -Id $record.pid -ErrorAction SilentlyContinue)
    } catch { $botWasRunning = $false }
}

& (Join-Path $PSScriptRoot 'start-background.ps1')
try {
    & (Join-Path $PSScriptRoot 'start-headless-client.ps1')
} catch {
    if (-not $botWasRunning) { & (Join-Path $PSScriptRoot 'stop-background.ps1') }
    throw
}

Write-Output 'AI controller and Minecraft client are running silently.'

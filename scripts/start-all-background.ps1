$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$botWasRunning = $false
$botPidFile = Join-Path $projectRoot 'data\bot.pid.json'
$botEntryPoint = Join-Path $projectRoot 'dist\src\index.js'
if (Test-Path -LiteralPath $botPidFile) {
    try {
        $record = Get-Content -LiteralPath $botPidFile -Raw | ConvertFrom-Json
        $candidate = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
        $details = Get-CimInstance Win32_Process -Filter "ProcessId=$($record.pid)" -ErrorAction SilentlyContinue
        $botWasRunning = [bool]($candidate -and $details -and -not [string]::IsNullOrWhiteSpace($details.CommandLine) -and $details.CommandLine.IndexOf($botEntryPoint, [StringComparison]::OrdinalIgnoreCase) -ge 0)
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

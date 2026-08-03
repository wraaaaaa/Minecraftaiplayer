$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$entryPoint = Join-Path $projectRoot 'dist\src\index.js'
$pidFile = Join-Path $projectRoot 'data\bot.pid.json'
$stdoutLog = Join-Path $projectRoot 'logs\background.stdout.log'
$stderrLog = Join-Path $projectRoot 'logs\background.stderr.log'
$configFile = if ([string]::IsNullOrWhiteSpace($env:BOT_CONFIG)) {
    Join-Path $projectRoot 'config\bot.json'
} elseif ([System.IO.Path]::IsPathRooted($env:BOT_CONFIG)) {
    $env:BOT_CONFIG
} else {
    Join-Path $projectRoot $env:BOT_CONFIG
}

if (-not (Test-Path -LiteralPath $entryPoint)) {
    throw 'Build output is missing. Run npm run build first.'
}
if (-not (Test-Path -LiteralPath $configFile)) {
    throw 'Config is missing. Copy config/bot.example.json to config/bot.json first.'
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $pidFile), (Split-Path -Parent $stdoutLog) | Out-Null

if (Test-Path -LiteralPath $pidFile) {
    $existing = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
    $existingProcess = Get-Process -Id $existing.pid -ErrorAction SilentlyContinue
    if ($existingProcess -and $existingProcess.Path -eq $existing.executable) {
        Write-Output "AI controller is already running in background. PID=$($existing.pid)"
        exit 0
    }
}

$nodeCommand = (Get-Command node -ErrorAction Stop).Source
$quotedEntryPoint = '"' + $entryPoint + '"'
$process = Start-Process -FilePath $nodeCommand -ArgumentList @($quotedEntryPoint) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
Start-Sleep -Milliseconds 1500
if ($process.HasExited) {
    throw "AI controller exited during startup. Check $stderrLog"
}
$record = [ordered]@{
    pid = $process.Id
    executable = $nodeCommand
    startedAt = (Get-Date).ToUniversalTime().ToString('o')
}
$record | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding UTF8
Write-Output "AI controller started silently. PID=$($process.Id)"

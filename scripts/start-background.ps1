$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$entryPoint = Join-Path $projectRoot 'dist\src\index.js'
$userDataRoot = if ([string]::IsNullOrWhiteSpace($env:MCAI_USERDATA_DIR)) { Join-Path $projectRoot 'userdata' } else { $env:MCAI_USERDATA_DIR }
$pidFile = Join-Path $userDataRoot 'data\bot.pid.json'
$stdoutLog = Join-Path $projectRoot 'logs\background.stdout.log'
$stderrLog = Join-Path $projectRoot 'logs\background.stderr.log'
$configFile = if ([string]::IsNullOrWhiteSpace($env:BOT_CONFIG)) {
    Join-Path $userDataRoot 'config\bot.json'
} elseif ([System.IO.Path]::IsPathRooted($env:BOT_CONFIG)) {
    $env:BOT_CONFIG
} else {
    Join-Path $userDataRoot $env:BOT_CONFIG
}

if (-not (Test-Path -LiteralPath $entryPoint)) {
    throw 'Build output is missing. Run npm run build first.'
}
if (-not (Test-Path -LiteralPath $configFile)) {
    throw 'Config is missing. Copy config/bot.example.json to userdata/config/bot.json first.'
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $pidFile), (Split-Path -Parent $stdoutLog) | Out-Null
$bridgeTokenFile = Join-Path $userDataRoot 'data\bridge-token.txt'
if (-not (Test-Path -LiteralPath $bridgeTokenFile)) {
    $bridgeToken = ([Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N'))
    [IO.File]::WriteAllText($bridgeTokenFile, $bridgeToken, [Text.UTF8Encoding]::new($false))
}
$env:MCAI_BRIDGE_TOKEN = (Get-Content -LiteralPath $bridgeTokenFile -Raw -Encoding UTF8).Trim()
if ([string]::IsNullOrWhiteSpace($env:MCAI_BRIDGE_TOKEN)) { throw 'Bridge session token is empty.' }

if (Test-Path -LiteralPath $pidFile) {
    $existing = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
    $existingProcess = Get-Process -Id $existing.pid -ErrorAction SilentlyContinue
    $existingDetails = Get-CimInstance Win32_Process -Filter "ProcessId=$($existing.pid)" -ErrorAction SilentlyContinue
    if ($existingProcess -and $existingProcess.Path -eq $existing.executable -and $existingDetails -and -not [string]::IsNullOrWhiteSpace($existingDetails.CommandLine) -and $existingDetails.CommandLine.IndexOf($entryPoint, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        Write-Output "AI controller is already running in background. PID=$($existing.pid)"
        exit 0
    }
    Remove-Item -LiteralPath $pidFile -Force
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
    projectRoot = $projectRoot
    entryPoint = $entryPoint
    startedAt = (Get-Date).ToUniversalTime().ToString('o')
}
$record | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding UTF8
Write-Output "AI controller started silently. PID=$($process.Id)"

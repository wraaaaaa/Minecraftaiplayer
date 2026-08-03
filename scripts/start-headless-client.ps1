$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$headlessJar = Join-Path $projectRoot '.runtime\headlessmc\headlessmc-launcher-2.10.0.jar'
$gameDirectory = Join-Path $projectRoot '.runtime\minecraft'
$bridgeJar = Join-Path $gameDirectory 'mods\minecraft-ai-fabric-bridge-0.1.0.jar'
$pidFile = Join-Path $projectRoot 'data\minecraft-client.pid.json'
$stdoutLog = Join-Path $projectRoot 'logs\minecraft-client.stdout.log'
$stderrLog = Join-Path $projectRoot 'logs\minecraft-client.stderr.log'
$configFile = Join-Path $projectRoot 'config\bot.json'
if (-not (Test-Path -LiteralPath $configFile)) {
    $configFile = Join-Path $projectRoot 'config\bot.example.json'
}

foreach ($required in @($headlessJar, $bridgeJar, $configFile)) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "Required file is missing: $required"
    }
}

$config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
if ($config.server.adapter -ne 'fabric_bridge') {
    throw 'The headless Fabric client requires server.adapter=fabric_bridge.'
}

$minecraftHome = if ([string]::IsNullOrWhiteSpace($env:MCAI_MINECRAFT_HOME)) {
    Join-Path $env:APPDATA '.minecraft'
} else {
    $env:MCAI_MINECRAFT_HOME
}

$javaCandidates = @()
if (-not [string]::IsNullOrWhiteSpace($env:MCAI_JAVA_HOME)) {
    $javaCandidates += (Join-Path $env:MCAI_JAVA_HOME 'bin\java.exe')
}
$javaCandidates += (Join-Path $minecraftHome 'runtime\java-runtime-epsilon\bin\java.exe')
$pathJava = Get-Command java.exe -ErrorAction SilentlyContinue
if ($pathJava) { $javaCandidates += $pathJava.Source }
$javaCommand = $javaCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $javaCommand) {
    throw 'Java 25 was not found. Set MCAI_JAVA_HOME or install the Minecraft 26.2 Java runtime.'
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $pidFile), (Split-Path -Parent $stdoutLog) | Out-Null
if (Test-Path -LiteralPath $pidFile) {
    $existing = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
    $existingProcess = Get-Process -Id $existing.pid -ErrorAction SilentlyContinue
    if ($existingProcess -and $existingProcess.Path -eq $existing.executable) {
        Write-Output "Minecraft client is already running in background. PID=$($existing.pid)"
        exit 0
    }
}

$env:MCAI_SERVER_HOST = [string]$config.server.host
$env:MCAI_SERVER_PORT = [string]$config.server.port
$offline = $config.server.auth -eq 'offline'
if (-not $offline) {
    throw 'Microsoft authentication is not implemented for the headless Fabric launcher yet. Use auth=offline for this server.'
}
$offlineName = [string]$config.server.username
$arguments = @(
    "-Dhmc.mcdir=`"$minecraftHome`"",
    "-Dhmc.gamedir=`"$gameDirectory`"",
    "-Dhmc.offline=$($offline.ToString().ToLowerInvariant())",
    "-Dhmc.offline.username=$offlineName",
    '-Dhmc.assets.dummy=true',
    '-Dhmc.java.use.current=true',
    '-Dhmc.exit.on.failed.command=true',
    '-jar',
    "`"$headlessJar`"",
    '--command',
    "`"launch fabric:26.2 -lwjgl -offline`""
)

$process = Start-Process -FilePath $javaCommand -ArgumentList $arguments -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
Start-Sleep -Milliseconds 750
if ($process.HasExited) {
    throw "Minecraft client exited during startup. Check $stderrLog"
}
$record = [ordered]@{
    pid = $process.Id
    executable = $javaCommand
    gameDirectory = $gameDirectory
    startedAt = (Get-Date).ToUniversalTime().ToString('o')
}
$record | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding UTF8
Write-Output "Minecraft 26.2 client started silently. PID=$($process.Id)"

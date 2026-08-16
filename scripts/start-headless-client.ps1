$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$headlessJar = Join-Path $projectRoot '.runtime\headlessmc\headlessmc-launcher-2.10.0.jar'
$gameDirectory = Join-Path $projectRoot '.runtime\minecraft'
$bridgeJar = Join-Path $gameDirectory 'mods\minecraft-ai-fabric-bridge-1.0.0.jar'
$userDataRoot = if ([string]::IsNullOrWhiteSpace($env:MCAI_USERDATA_DIR)) { Join-Path $projectRoot 'userdata' } else { $env:MCAI_USERDATA_DIR }
$pidFile = Join-Path $userDataRoot 'data\minecraft-client.pid.json'
$stdoutLog = Join-Path $projectRoot 'logs\minecraft-client.stdout.log'
$stderrLog = Join-Path $projectRoot 'logs\minecraft-client.stderr.log'
$configFile = Join-Path $userDataRoot 'config\bot.json'
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

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $pidFile), (Split-Path -Parent $stdoutLog) | Out-Null
if (Test-Path -LiteralPath $pidFile) {
    $existing = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
    $existingProcess = Get-Process -Id $existing.pid -ErrorAction SilentlyContinue
    $existingDetails = Get-CimInstance Win32_Process -Filter "ProcessId=$($existing.pid)" -ErrorAction SilentlyContinue
    if ($existingProcess -and $existingProcess.Path -eq $existing.executable -and $existingDetails -and -not [string]::IsNullOrWhiteSpace($existingDetails.CommandLine) -and $existingDetails.CommandLine.IndexOf($headlessJar, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        Write-Output "Minecraft client is already running in background. PID=$($existing.pid)"
        exit 0
    }
    Remove-Item -LiteralPath $pidFile -Force
}

$envFile = Join-Path $userDataRoot '.env'
$envValues = @{}
if (Test-Path -LiteralPath $envFile) {
    foreach ($rawLine in (Get-Content -LiteralPath $envFile -Encoding UTF8)) {
        $line = $rawLine.Trim()
        if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith('#')) { continue }
        $separator = $line.IndexOf('=')
        if ($separator -le 0) { continue }
        $name = $line.Substring(0, $separator).Trim()
        $value = $line.Substring($separator + 1).Trim()
        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        $envValues[$name] = $value
    }
}
$passwordVariable = [string]$config.easyAuth.passwordEnv
$configuredPassword = [Environment]::GetEnvironmentVariable($passwordVariable, 'Process')
if ([string]::IsNullOrWhiteSpace($configuredPassword) -and $envValues.ContainsKey($passwordVariable)) {
    $configuredPassword = [string]$envValues[$passwordVariable]
}
if (-not [string]::IsNullOrWhiteSpace($configuredPassword)) {
    $env:MINECRAFT_LOGIN_PASSWORD = $configuredPassword
}

$modsConfigFile = Join-Path $userDataRoot 'config\mods.json'
$skipHandshakeVerification = $false
if (Test-Path -LiteralPath $modsConfigFile) {
    $modsConfig = Get-Content -LiteralPath $modsConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($modsConfig.syncOnClientStart -and -not [bool]$modsConfig.skipHandshakeVerification) {
        & node (Join-Path $projectRoot 'scripts\sync-client-mods.mjs')
        if ($LASTEXITCODE -ne 0) { throw 'Server mod synchronization failed.' }
    }
    $skipHandshakeVerification = [bool]$modsConfig.skipHandshakeVerification
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

$connectionHost = [string]$config.server.host
$connectionPort = [int]$config.server.port
if ($config.server.connectionMode -eq 'lan') {
    if ($config.server.auth -ne 'offline') {
        throw 'LAN compatibility mode requires server.auth=offline.'
    }
    $discoveryScript = Join-Path $projectRoot 'dist\src\network\lan-discovery.js'
    if (-not (Test-Path -LiteralPath $discoveryScript)) {
        throw 'LAN discovery program is missing. Run npm run build first.'
    }
    $discoveryOutput = & node $discoveryScript --timeout ([int]$config.server.lanDiscoveryTimeoutMs)
    if ($LASTEXITCODE -ne 0) { throw 'Minecraft LAN discovery failed.' }
    $discovery = $discoveryOutput | ConvertFrom-Json
    $selected = $discovery.servers | Select-Object -First 1
    if (-not $selected) {
        throw 'No Minecraft LAN world was found. Open the human player world to LAN, allow UDP 4445 through the firewall, then try again.'
    }
    $connectionHost = [string]$selected.host
    $connectionPort = [int]$selected.port
    Write-Output "Discovered LAN world '$($selected.motd)' at ${connectionHost}:${connectionPort}."
}
$env:MCAI_SERVER_HOST = $connectionHost
$env:MCAI_SERVER_PORT = [string]$connectionPort
$env:MCAI_BRIDGE_HOST = [string]$config.server.bridgeHost
$env:MCAI_BRIDGE_PORT = [string]$config.server.bridgePort
$env:MCAI_EASYAUTH_ENABLED = [string]$config.easyAuth.enabled
$env:MCAI_EASYAUTH_REGISTER_IF_NEEDED = [string]$config.easyAuth.registerIfNeeded
$env:MCAI_AUTO_RESPAWN_ENABLED = if ($null -eq $config.server.autoRespawn) { 'true' } else { ([bool]$config.server.autoRespawn).ToString().ToLowerInvariant() }
$env:MCAI_RESPAWN_DELAY_MS = if ($null -eq $config.server.respawnDelayMs) { '3000' } else { [string][int]$config.server.respawnDelayMs }
$env:MCAI_AUTONOMY_ENABLED = if ($null -eq $config.autonomy.enabled) { 'true' } else { ([bool]$config.autonomy.enabled).ToString().ToLowerInvariant() }
$env:MCAI_OWNER_NAME = if ([string]::IsNullOrWhiteSpace([string]$config.autonomy.ownerName)) { 'wraaaaaa' } else { [string]$config.autonomy.ownerName }
$env:MCAI_LOW_HEALTH_THRESHOLD = if ($null -eq $config.autonomy.lowHealthThreshold) { '10' } else { [string][double]$config.autonomy.lowHealthThreshold }
$env:MCAI_EAT_BELOW_FOOD = if ($null -eq $config.autonomy.eatBelowFood) { '20' } else { [string][int]$config.autonomy.eatBelowFood }
$env:MCAI_HOSTILE_SCAN_RADIUS = if ($null -eq $config.autonomy.hostileScanRadius) { '12' } else { [string][double]$config.autonomy.hostileScanRadius }
$env:MCAI_ALLOW_VERIFIED_WILDERNESS = if ($null -eq $config.autonomy.allowVerifiedWilderness) { 'true' } else { ([bool]$config.autonomy.allowVerifiedWilderness).ToString().ToLowerInvariant() }
$env:MCAI_TP_COMMAND_ENABLED = if ($null -eq $config.autonomy.allowTeleportCommand) { 'false' } else { ([bool]$config.autonomy.allowTeleportCommand).ToString().ToLowerInvariant() }
$env:MCAI_PROTECT_OWNER = if ($null -eq $config.autonomy.protectOwner) { 'true' } else { ([bool]$config.autonomy.protectOwner).ToString().ToLowerInvariant() }
$env:MCAI_WILDERNESS_MIN_PLAYER_DISTANCE = if ($null -eq $config.autonomy.wildernessMinPlayerDistance) { '48' } else { [string][double]$config.autonomy.wildernessMinPlayerDistance }
$env:MCAI_FIRST_HOME_ENABLED = if ($null -eq $config.autonomy.firstHome.enabled) { 'true' } else { ([bool]$config.autonomy.firstHome.enabled).ToString().ToLowerInvariant() }
$env:MCAI_FIRST_HOME_DIMENSION = if ([string]::IsNullOrWhiteSpace([string]$config.autonomy.firstHome.dimension)) { 'minecraft:overworld' } else { [string]$config.autonomy.firstHome.dimension }
$env:MCAI_FIRST_HOME_X = if ($null -eq $config.autonomy.firstHome.x) { '1226' } else { [string][double]$config.autonomy.firstHome.x }
$env:MCAI_FIRST_HOME_Y = if ($null -eq $config.autonomy.firstHome.y) { '65' } else { [string][double]$config.autonomy.firstHome.y }
$env:MCAI_FIRST_HOME_Z = if ($null -eq $config.autonomy.firstHome.z) { '199' } else { [string][double]$config.autonomy.firstHome.z }
$env:MCAI_FIRST_HOME_RADIUS = if ($null -eq $config.autonomy.firstHome.radius) { '10' } else { [string][double]$config.autonomy.firstHome.radius }
$autonomyStateRelative = if ([string]::IsNullOrWhiteSpace([string]$config.storage.autonomyFile)) { 'data\autonomy-state.json' } else { [string]$config.storage.autonomyFile }
$autonomyStatePath = [IO.Path]::GetFullPath((Join-Path $userDataRoot $autonomyStateRelative))
$allowedDataRoot = [IO.Path]::GetFullPath((Join-Path $userDataRoot 'data'))
if (-not $autonomyStatePath.StartsWith($allowedDataRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'storage.autonomyFile must stay inside the userdata/data directory.'
}
$env:MCAI_HOME_FILE = $autonomyStatePath
$ownedBlocksRelative = if ([string]::IsNullOrWhiteSpace([string]$config.storage.ownedBlocksFile)) { 'data\owned-blocks.json' } else { [string]$config.storage.ownedBlocksFile }
$ownedBlocksPath = [IO.Path]::GetFullPath((Join-Path $userDataRoot $ownedBlocksRelative))
if (-not $ownedBlocksPath.StartsWith($allowedDataRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'storage.ownedBlocksFile must stay inside the userdata/data directory.'
}
$env:MCAI_OWNED_BLOCKS_FILE = $ownedBlocksPath
$bridgeTokenFile = Join-Path $userDataRoot 'data\bridge-token.txt'
if (-not (Test-Path -LiteralPath $bridgeTokenFile)) {
    throw 'Bridge session token is missing. Start the AI controller first or use start-all-background.ps1.'
}
$env:MCAI_BRIDGE_TOKEN = (Get-Content -LiteralPath $bridgeTokenFile -Raw -Encoding UTF8).Trim()
if ([string]::IsNullOrWhiteSpace($env:MCAI_BRIDGE_TOKEN)) { throw 'Bridge session token is empty.' }

# The Minecraft JVM and every third-party client mod inherit this process environment.
# Remove model credentials before Start-Process; only the Node controller is allowed to hold them.
$modelSecretNames = @(
    'DEEPSEEK_API_KEY',
    'ARK_API_KEY',
    'OPENAI_API_KEY',
    'MIMO_API_KEY',
    'VOLCENGINE_TTS_APP_ID',
    'VOLCENGINE_TTS_ACCESS_TOKEN',
    'CUSTOM_TTS_API_KEY',
    [string]$config.model.apiKeyEnv,
    [string]$config.speech.apiKeyEnv,
    [string]$config.speech.volcengineAppIdEnv
) | Select-Object -Unique
foreach ($secretName in $modelSecretNames) {
    if (-not [string]::IsNullOrWhiteSpace($secretName)) {
        [Environment]::SetEnvironmentVariable($secretName, $null, 'Process')
    }
}
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
    '-Dhmc.exit.on.failed.command=true'
)
if ($skipHandshakeVerification) {
    $env:MCAI_SKIP_REGISTRY_SYNC = 'true'
    $arguments += '-Dmcai.skipRegistrySync=true'
}
$arguments += @(
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
    projectRoot = $projectRoot
    headlessJar = $headlessJar
    gameDirectory = $gameDirectory
    startedAt = (Get-Date).ToUniversalTime().ToString('o')
}
$record | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding UTF8
Write-Output "Minecraft 26.2 client started silently. PID=$($process.Id)"

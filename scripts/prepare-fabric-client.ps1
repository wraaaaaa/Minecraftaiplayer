param(
    [string]$FabricApiUrl = $env:MCAI_FABRIC_API_URL,
    [string]$AdditionalModsDirectory = ''
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$gameDirectory = Join-Path $projectRoot '.runtime\minecraft'
$modsDirectory = Join-Path $gameDirectory 'mods'
$bridgeSource = Join-Path $projectRoot 'fabric-bridge\build\libs\minecraft-ai-fabric-bridge-1.3.0-alpha.jar'
$bridgeTarget = Join-Path $modsDirectory 'minecraft-ai-fabric-bridge-1.3.0-alpha.jar'
$fabricApiTarget = Join-Path $modsDirectory 'fabric-api-0.156.0+26.2.jar'
$skinLoaderSource = Join-Path $projectRoot 'vendor\custom-skin-loader\CustomSkinLoader_Universal-15.0.1.jar'
$skinLoaderTarget = Join-Path $modsDirectory 'CustomSkinLoader_Universal-15.0.1.jar'
$skinLoaderSha256 = '026D8B38EA93EDCCD647F60568193E79801A377B7BD4E916DCFC0D5482B767FC'
$fabricApiSha256 = '8DE18D9F6A8A2A5B2120EF9E8BFFB79CC9B75989C0C022C39C9DFC1BC3A29A99'

if (-not (Test-Path -LiteralPath $bridgeSource)) {
    throw 'Fabric bridge output is missing. Build fabric-bridge first.'
}
if ([string]::IsNullOrWhiteSpace($FabricApiUrl)) {
    $FabricApiUrl = 'https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/0.156.0%2B26.2/fabric-api-0.156.0%2B26.2.jar'
}

New-Item -ItemType Directory -Force -Path $modsDirectory | Out-Null
Copy-Item -LiteralPath $bridgeSource -Destination $bridgeTarget -Force
if (Test-Path -LiteralPath $skinLoaderSource) {
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $skinLoaderSource).Hash -ne $skinLoaderSha256) { throw 'CustomSkinLoader SHA256 mismatch.' }
    Copy-Item -LiteralPath $skinLoaderSource -Destination $skinLoaderTarget -Force
}

$needsFabricApi = $true
if (Test-Path -LiteralPath $fabricApiTarget) {
    $needsFabricApi = (Get-FileHash -Algorithm SHA256 -LiteralPath $fabricApiTarget).Hash -ne $fabricApiSha256
}
if ($needsFabricApi) {
    $temporaryFile = "$fabricApiTarget.download"
    & curl.exe --silent --show-error --ssl-no-revoke --fail --location --retry 3 --connect-timeout 20 --output $temporaryFile $FabricApiUrl
    if ($LASTEXITCODE -ne 0) { throw 'Fabric API download failed. Set MCAI_FABRIC_API_URL to a reachable mirror.' }
    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $temporaryFile).Hash
    if ($actualHash -ne $fabricApiSha256) { throw "Fabric API SHA256 mismatch: $actualHash" }
    Move-Item -LiteralPath $temporaryFile -Destination $fabricApiTarget -Force
}

if (-not [string]::IsNullOrWhiteSpace($AdditionalModsDirectory)) {
    $resolvedMods = (Resolve-Path -LiteralPath $AdditionalModsDirectory).Path
    & node (Join-Path $projectRoot 'scripts\sync-client-mods.mjs') --source $resolvedMods
    if ($LASTEXITCODE -ne 0) { throw 'Server mod synchronization failed.' }
}

@(
    'pauseOnLostFocus:false',
    'onboardAccessibility:false'
) | Set-Content -LiteralPath (Join-Path $gameDirectory 'options.txt') -Encoding UTF8

Write-Output "Fabric client directory prepared: $gameDirectory"
Write-Output 'Copy the server-required client mods with -AdditionalModsDirectory before connecting.'

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $projectRoot '.runtime\skin-pack'
$staging = Join-Path $runtimeRoot 'staging'
$zip = Join-Path $runtimeRoot 'Minecraft-AI-Skin-Pack.zip'
$skinConfigFile = Join-Path $projectRoot 'config\skin.json'
$botConfigFile = Join-Path $projectRoot 'config\bot.json'
$loader = Join-Path $projectRoot 'vendor\custom-skin-loader\CustomSkinLoader_Universal-15.0.1.jar'
$loaderSha256 = '026D8B38EA93EDCCD647F60568193E79801A377B7BD4E916DCFC0D5482B767FC'

foreach ($required in @($skinConfigFile, $botConfigFile, $loader)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Required skin-pack file is missing: $required" }
}
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $loader).Hash -ne $loaderSha256) { throw 'CustomSkinLoader SHA256 mismatch.' }
$skinConfig = Get-Content -LiteralPath $skinConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
$botConfig = Get-Content -LiteralPath $botConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
$skinSource = [IO.Path]::GetFullPath((Join-Path $projectRoot ([string]$skinConfig.skinFile)))
$allowedSkinRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'data\skins'))
if (-not $skinSource.StartsWith($allowedSkinRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Skin file must stay inside data\skins.'
}
if (-not (Test-Path -LiteralPath $skinSource)) { throw 'Import a skin PNG before building the client pack.' }

New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
$resolvedRuntimeRoot = [IO.Path]::GetFullPath($runtimeRoot)
$resolvedStaging = [IO.Path]::GetFullPath($staging)
if (-not $resolvedStaging.StartsWith($resolvedRuntimeRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Unsafe skin-pack staging path.'
}
if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
$mods = Join-Path $staging 'mods'
$skins = Join-Path $staging 'CustomSkinLoader\LocalSkin\skins'
New-Item -ItemType Directory -Force -Path $mods, $skins | Out-Null
Copy-Item -LiteralPath $loader -Destination (Join-Path $mods (Split-Path -Leaf $loader)) -Force
Copy-Item -LiteralPath $skinSource -Destination (Join-Path $skins "$($botConfig.server.username).png") -Force
@"
Minecraft AI Bot shared skin pack

1. Stop Minecraft.
2. Copy the contents of this folder into the same Minecraft instance directory used by each human player.
3. Restart Minecraft and rejoin the world/server.

Bot name: $($botConfig.server.username)
Skin model: $($skinConfig.model)
Important: CustomSkinLoader LocalSkin is client-side. Every player who should see this skin must install this same pack. For automatic cross-device updates, upload the texture to the shared provider configured in config\skin.json instead.
"@ | Set-Content -LiteralPath (Join-Path $staging 'INSTALL.txt') -Encoding UTF8
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zip -Force
Write-Output "Skin pack created: $zip"

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot

& (Join-Path $PSScriptRoot 'start-background.ps1')
try {
    & (Join-Path $PSScriptRoot 'start-headless-client.ps1')
} catch {
    & (Join-Path $PSScriptRoot 'stop-background.ps1')
    throw
}

Write-Output 'AI controller and Minecraft client are running silently.'

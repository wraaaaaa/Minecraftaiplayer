$ErrorActionPreference = 'Continue'

& (Join-Path $PSScriptRoot 'stop-headless-client.ps1')
& (Join-Path $PSScriptRoot 'stop-background.ps1')

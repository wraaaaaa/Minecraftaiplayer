$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'start-webui-background.ps1')
Start-Process 'http://127.0.0.1:3210'

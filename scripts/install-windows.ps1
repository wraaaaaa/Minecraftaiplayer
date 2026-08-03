param(
    [string]$ModsDirectory = '',
    [switch]$SkipEnvironmentInstall,
    [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$logDirectory = Join-Path $projectRoot 'logs'
$logFile = Join-Path $logDirectory 'install-windows.log'
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
Start-Transcript -LiteralPath $logFile -Append | Out-Null

function Refresh-ProcessPath {
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machinePath;$userPath"
}

function Get-Java25Home {
    $candidates = @()
    if (-not [string]::IsNullOrWhiteSpace($env:MCAI_JAVA_HOME)) { $candidates += $env:MCAI_JAVA_HOME }
    if (-not [string]::IsNullOrWhiteSpace($env:JAVA_HOME)) { $candidates += $env:JAVA_HOME }
    $candidates += (Join-Path $env:APPDATA '.minecraft\runtime\java-runtime-epsilon')
    $adoptiumRoot = 'C:\Program Files\Eclipse Adoptium'
    if (Test-Path -LiteralPath $adoptiumRoot) {
        $candidates += Get-ChildItem -LiteralPath $adoptiumRoot -Directory -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | ForEach-Object { $_.FullName }
    }
    foreach ($candidate in $candidates) {
        $java = Join-Path $candidate 'bin\java.exe'
        if (-not (Test-Path -LiteralPath $java)) { continue }
        $previousErrorPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $version = & $java -version 2>&1 | Select-Object -First 1
        $ErrorActionPreference = $previousErrorPreference
        if ($version -match 'version "25(?:\.|\")') { return $candidate }
    }
    return $null
}

function Invoke-CheckedCommand {
    param([string]$FilePath, [string[]]$Arguments)
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$FilePath failed with exit code $LASTEXITCODE" }
}

try {
    if ($env:OS -ne 'Windows_NT') { throw 'This one-click installer currently supports Windows only.' }
    Write-Output 'Minecraft AI Player clean Windows installation started.'
    Refresh-ProcessPath

    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    $javaHome = Get-Java25Home
    if ((-not $node -or -not $javaHome) -and -not $SkipEnvironmentInstall) {
        $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
        if (-not $winget) { throw 'winget is unavailable. Install Node.js 22+ and Java 25 manually, then run this installer again.' }
        if (-not $node) {
            Write-Output 'Installing Node.js LTS...'
            Invoke-CheckedCommand $winget.Source @('install', '--id', 'OpenJS.NodeJS.LTS', '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements')
        }
        if (-not $javaHome) {
            Write-Output 'Installing Eclipse Temurin JDK 25...'
            Invoke-CheckedCommand $winget.Source @('install', '--id', 'EclipseAdoptium.Temurin.25.JDK', '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements')
        }
        Refresh-ProcessPath
        $node = Get-Command node.exe -ErrorAction SilentlyContinue
        $javaHome = Get-Java25Home
    }
    if (-not $node) { throw 'Node.js 22 or newer was not found.' }
    if (-not $javaHome) { throw 'Java 25 was not found.' }
    $nodeVersionText = (& $node.Source --version).Trim()
    $nodeMajor = [int]($nodeVersionText.TrimStart('v').Split('.')[0])
    if ($nodeMajor -lt 22) { throw 'Node.js 22 or newer is required.' }
    $env:JAVA_HOME = $javaHome
    $env:MCAI_JAVA_HOME = $javaHome
    $env:Path = "$javaHome\bin;$env:Path"

    $botConfig = Join-Path $projectRoot 'config\bot.json'
    $personaConfig = Join-Path $projectRoot 'config\persona.json'
    $modsConfig = Join-Path $projectRoot 'config\mods.json'
    $envFile = Join-Path $projectRoot '.env'
    if (-not (Test-Path -LiteralPath $botConfig)) { Copy-Item -LiteralPath (Join-Path $projectRoot 'config\bot.example.json') -Destination $botConfig }
    if (-not (Test-Path -LiteralPath $personaConfig)) { Copy-Item -LiteralPath (Join-Path $projectRoot 'config\persona.example.json') -Destination $personaConfig }
    if (-not (Test-Path -LiteralPath $modsConfig)) { Copy-Item -LiteralPath (Join-Path $projectRoot 'config\mods.example.json') -Destination $modsConfig }
    if (-not (Test-Path -LiteralPath $envFile)) { Copy-Item -LiteralPath (Join-Path $projectRoot '.env.example') -Destination $envFile }
    if (-not [string]::IsNullOrWhiteSpace($ModsDirectory)) {
        $resolvedMods = (Resolve-Path -LiteralPath $ModsDirectory).Path
        $mods = Get-Content -LiteralPath $modsConfig -Raw -Encoding UTF8 | ConvertFrom-Json
        $mods.sourceDirectory = $resolvedMods
        $mods | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $modsConfig -Encoding UTF8
    }

    Set-Location $projectRoot
    Write-Output 'Installing and building the AI controller...'
    Invoke-CheckedCommand 'npm.cmd' @('install')
    Invoke-CheckedCommand 'npm.cmd' @('run', 'check')
    Invoke-CheckedCommand 'npm.cmd' @('run', 'build')

    Write-Output 'Downloading verified Minecraft 26.2 resources...'
    Invoke-CheckedCommand 'npm.cmd' @('run', 'prefetch:minecraft')

    Write-Output 'Building the Fabric bridge...'
    Set-Location (Join-Path $projectRoot 'fabric-bridge')
    Invoke-CheckedCommand '.\gradlew.bat' @('build', '--no-daemon')
    Set-Location $projectRoot

    Write-Output 'Preparing the verified headless Minecraft client...'
    & (Join-Path $PSScriptRoot 'install-headlessmc.ps1')
    $modsSettings = Get-Content -LiteralPath $modsConfig -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not [string]::IsNullOrWhiteSpace($modsSettings.sourceDirectory)) {
        & (Join-Path $PSScriptRoot 'prepare-fabric-client.ps1') -AdditionalModsDirectory $modsSettings.sourceDirectory
    } else {
        & (Join-Path $PSScriptRoot 'prepare-fabric-client.ps1')
    }

    Write-Output 'Starting the local control center...'
    & (Join-Path $PSScriptRoot 'start-webui-background.ps1')
    if (-not $NoOpen) { Start-Process 'http://127.0.0.1:3210' }
    Write-Output 'Installation completed. Configure secrets in the control center before starting the Bot.'
} finally {
    Stop-Transcript | Out-Null
}

param(
    [string]$ModsDirectory = '',
    [switch]$SkipEnvironmentInstall,
    [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $projectRoot '.runtime'
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
    $candidates += (Join-Path $runtimeRoot 'jdk')
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

function Download-VerifiedFile {
    param([string[]]$Urls, [string]$Target, [string]$Sha256 = '')
    $temporary = "$Target.download"
    $downloaded = $false
    foreach ($url in $Urls) {
        Write-Output "  downloading $url"
        & curl.exe --silent --show-error --ssl-no-revoke --fail --location --retry 3 --connect-timeout 25 --output $temporary $url
        if ($LASTEXITCODE -eq 0) { $downloaded = $true; break }
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
    if (-not $downloaded) { throw "Download failed for $Target" }
    if ($Sha256) {
        $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $temporary).Hash
        if ($actual -ne $Sha256) { Remove-Item -LiteralPath $temporary -Force; throw "SHA256 mismatch for ${Target}: $actual" }
    }
    Move-Item -LiteralPath $temporary -Destination $Target -Force
}

function Install-NodePortable {
    $nodeHome = Join-Path $runtimeRoot 'node'
    if ((Test-Path -LiteralPath (Join-Path $nodeHome 'node.exe'))) { return $nodeHome }
    $version = '22.12.0'
    $zip = Join-Path $runtimeRoot "node-v$version-win-x64.zip"
    $urls = @(
        "https://npmmirror.com/mirrors/node/v$version/node-v$version-win-x64.zip",
        "https://cdn.npmmirror.com/binaries/node/v$version/node-v$version-win-x64.zip",
        "https://nodejs.org/dist/v$version/node-v$version-win-x64.zip"
    )
    New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
    Download-VerifiedFile -Urls $urls -Target $zip
    $extract = Join-Path $runtimeRoot 'node-extract'
    if (Test-Path -LiteralPath $extract) { Remove-Item -LiteralPath $extract -Recurse -Force }
    Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force
    $inner = Get-ChildItem -LiteralPath $extract -Directory | Select-Object -First 1
    Move-Item -LiteralPath $inner.FullName -Destination $nodeHome -Force
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $extract -Recurse -Force -ErrorAction SilentlyContinue
    return $nodeHome
}

function Install-JavaPortable {
    $javaHome = Join-Path $runtimeRoot 'jdk'
    if ((Test-Path -LiteralPath (Join-Path $javaHome 'bin\java.exe'))) { return $javaHome }
    $zip = Join-Path $runtimeRoot 'temurin-25-jdk.zip'
    $urls = @(
        'https://api.adoptium.net/v3/binary/latest/25/ga/windows/x64/jdk/hotspot/normal/eclipse',
        'https://mirrors.tuna.tsinghua.edu.cn/Adoptium/25/jdk/x64/windows/OpenJDK25U-jdk_x64_windows_hotspot_25.0.1_8.zip'
    )
    New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
    Download-VerifiedFile -Urls $urls -Target $zip
    $extract = Join-Path $runtimeRoot 'jdk-extract'
    if (Test-Path -LiteralPath $extract) { Remove-Item -LiteralPath $extract -Recurse -Force }
    Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force
    $inner = Get-ChildItem -LiteralPath $extract -Directory | Select-Object -First 1
    Move-Item -LiteralPath $inner.FullName -Destination $javaHome -Force
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $extract -Recurse -Force -ErrorAction SilentlyContinue
    return $javaHome
}

try {
    if ($env:OS -ne 'Windows_NT') { throw 'This one-click installer currently supports Windows only.' }
    Write-Output 'Minecraft AI Player one-click deployment started.'
    Refresh-ProcessPath

    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    $javaHome = Get-Java25Home
    if ((-not $node -or -not $javaHome) -and -not $SkipEnvironmentInstall) {
        $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
        if (-not $node) {
            if ($winget) {
                Write-Output 'Installing Node.js LTS via winget...'
                try { Invoke-CheckedCommand $winget.Source @('install', '--id', 'OpenJS.NodeJS.LTS', '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements') } catch { Write-Output ('winget Node install failed, falling back to portable: ' + $_.Exception.Message) }
            }
            Refresh-ProcessPath
            $node = Get-Command node.exe -ErrorAction SilentlyContinue
            if (-not $node) {
                Write-Output 'Downloading portable Node.js 22...'
                $nodeHome = Install-NodePortable
                $env:Path = "$nodeHome;$env:Path"
                $node = Get-Command node.exe -ErrorAction SilentlyContinue
            }
        }
        if (-not $javaHome) {
            if ($winget) {
                Write-Output 'Installing Eclipse Temurin JDK 25 via winget...'
                try { Invoke-CheckedCommand $winget.Source @('install', '--id', 'EclipseAdoptium.Temurin.25.JDK', '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements') } catch { Write-Output ('winget JDK install failed, falling back to portable: ' + $_.Exception.Message) }
            }
            Refresh-ProcessPath
            $javaHome = Get-Java25Home
            if (-not $javaHome) {
                Write-Output 'Downloading portable Temurin JDK 25...'
                $javaHome = Install-JavaPortable
            }
        }
    }
    if (-not $node) { throw 'Node.js 22 or newer was not found and could not be installed automatically.' }
    if (-not $javaHome) { throw 'Java 25 was not found and could not be installed automatically.' }
    $nodeVersionText = (& $node.Source --version).Trim()
    $nodeMajor = [int]($nodeVersionText.TrimStart('v').Split('.')[0])
    if ($nodeMajor -lt 22) { throw 'Node.js 22 or newer is required.' }
    $env:JAVA_HOME = $javaHome
    $env:MCAI_JAVA_HOME = $javaHome
    $env:Path = "$javaHome\bin;$env:Path"

    foreach ($pair in @(@('bot', 'bot'), @('persona', 'persona'), @('mods', 'mods'), @('prompts', 'prompts'), @('skin', 'skin'))) {
        $name = $pair[0]
        $target = Join-Path $projectRoot "config\$name.json"
        if (-not (Test-Path -LiteralPath $target)) { Copy-Item -LiteralPath (Join-Path $projectRoot "config\$name.example.json") -Destination $target }
    }
    $envFile = Join-Path $projectRoot '.env'
    if (-not (Test-Path -LiteralPath $envFile)) { Copy-Item -LiteralPath (Join-Path $projectRoot '.env.example') -Destination $envFile }
    $modsConfig = Join-Path $projectRoot 'config\mods.json'
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
    Write-Output 'Deployment completed. Configure secrets in the control center before starting the Bot.'
} finally {
    Stop-Transcript | Out-Null
}

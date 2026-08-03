param(
    [string]$DownloadUrl = $env:MCAI_HEADLESSMC_DOWNLOAD_URL
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$targetDirectory = Join-Path $projectRoot '.runtime\headlessmc'
$targetFile = Join-Path $targetDirectory 'headlessmc-launcher-2.10.0.jar'
$expectedSha256 = '52BD5006F478377B3893011D458562977D38C65EAD6D2B31089BEB4D614F13CD'

$officialUrl = 'https://github.com/headlesshq/headlessmc/releases/download/2.10.0/headlessmc-launcher-2.10.0.jar'
$downloadCandidates = if ([string]::IsNullOrWhiteSpace($DownloadUrl)) {
    @("https://gh-proxy.com/$officialUrl", $officialUrl)
} else {
    @($DownloadUrl)
}

New-Item -ItemType Directory -Force -Path $targetDirectory | Out-Null
if (Test-Path -LiteralPath $targetFile) {
    $currentHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $targetFile).Hash
    if ($currentHash -eq $expectedSha256) {
        Write-Output 'HeadlessMc 2.10.0 is already installed and verified.'
        exit 0
    }
}

$temporaryFile = "$targetFile.download"
$downloaded = $false
foreach ($candidate in $downloadCandidates) {
    & curl.exe --silent --show-error --ssl-no-revoke --fail --location --retry 3 --connect-timeout 20 --output $temporaryFile $candidate
    if ($LASTEXITCODE -eq 0) { $downloaded = $true; break }
    Remove-Item -LiteralPath $temporaryFile -Force -ErrorAction SilentlyContinue
}
if (-not $downloaded) { throw 'HeadlessMc download failed. Set MCAI_HEADLESSMC_DOWNLOAD_URL to a reachable mirror.' }
$actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $temporaryFile).Hash
if ($actualHash -ne $expectedSha256) { throw "HeadlessMc SHA256 mismatch: $actualHash" }
Move-Item -LiteralPath $temporaryFile -Destination $targetFile -Force
Write-Output 'HeadlessMc 2.10.0 was installed and verified.'

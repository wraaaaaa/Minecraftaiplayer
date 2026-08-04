$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$headlessJar = Join-Path $projectRoot '.runtime\headlessmc\headlessmc-launcher-2.10.0.jar'
$pidFile = Join-Path $projectRoot 'data\minecraft-client.pid.json'
if (-not (Test-Path -LiteralPath $pidFile)) {
    Write-Output 'No background Minecraft client PID file was found.'
    exit 0
}

$record = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
$rootProcess = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
if (-not $rootProcess) {
    Remove-Item -LiteralPath $pidFile -Force
    Write-Output 'The Minecraft client had already ended; the stale PID file was removed.'
    exit 0
}
if ($rootProcess.Path -ne $record.executable) {
    throw "PID $($record.pid) belongs to another executable; refusing to stop it."
}
$details = Get-CimInstance Win32_Process -Filter "ProcessId=$($record.pid)" -ErrorAction SilentlyContinue
if (-not $details -or [string]::IsNullOrWhiteSpace($details.CommandLine) -or $details.CommandLine.IndexOf($headlessJar, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
    throw "PID $($record.pid) belongs to another project directory; refusing to stop it."
}

$allProcesses = Get-CimInstance Win32_Process
$descendantIds = New-Object System.Collections.Generic.List[int]
$frontier = @([int]$record.pid)
while ($frontier.Count -gt 0) {
    $children = @($allProcesses | Where-Object { $_.ParentProcessId -in $frontier })
    $frontier = @($children | ForEach-Object { [int]$_.ProcessId })
    foreach ($childId in $frontier) { $descendantIds.Add($childId) }
}

foreach ($childId in @($descendantIds | Sort-Object -Descending)) {
    $child = $allProcesses | Where-Object ProcessId -eq $childId | Select-Object -First 1
    if ($child -and $child.CommandLine -like "*$($record.gameDirectory)*") {
        Stop-Process -Id $childId -Force -ErrorAction SilentlyContinue
    }
}
Stop-Process -Id $record.pid -Force
Remove-Item -LiteralPath $pidFile -Force
Write-Output "Minecraft client stopped. PID=$($record.pid)"

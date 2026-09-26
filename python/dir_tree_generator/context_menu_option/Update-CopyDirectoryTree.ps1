#requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sourceScript = Join-Path -Path $PSScriptRoot -ChildPath 'dir_tree.py'
if (-not (Test-Path -LiteralPath $sourceScript -PathType Leaf)) {
    throw "dir_tree.py was not found beside this updater: $sourceScript"
}

$pythonCommand = Get-Command 'py.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
$pythonArguments = @('-3')

if ($null -eq $pythonCommand) {
    $pythonCommand = Get-Command 'python.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    $pythonArguments = @()
}

if ($null -eq $pythonCommand) {
    throw 'Python was not found. Python 3.10 or later is required.'
}

$pythonPath = $pythonCommand.Source
$versionOutput = & $pythonPath @pythonArguments --version 2>&1
$pythonExitCode = $LASTEXITCODE
$versionText = ($versionOutput | Out-String).Trim()
$versionMatch = [regex]::Match($versionText, 'Python\s+(\d+\.\d+(?:\.\d+)?)')

if ($pythonExitCode -ne 0 -or -not $versionMatch.Success) {
    throw "Failed to run Python through: $pythonPath"
}

$pythonVersion = [Version]($versionMatch.Groups[1].Value)
if ($pythonVersion -lt [Version]'3.10') {
    throw "Python 3.10 or later is required. Found $pythonVersion at $pythonPath"
}

$validationOutput = & $pythonPath @pythonArguments -B $sourceScript --clipboard --help 2>&1
$validationExitCode = $LASTEXITCODE
if ($validationExitCode -ne 0) {
    $validationText = ($validationOutput | Out-String).Trim()
    if ($validationText) {
        throw "The replacement dir_tree.py failed Python validation.`n`n$validationText"
    }
    throw 'The replacement dir_tree.py failed Python validation.'
}

$installDirectory = Join-Path -Path $env:LOCALAPPDATA -ChildPath 'CopyDirectoryTree'
$installedScript = Join-Path -Path $installDirectory -ChildPath 'dir_tree.py'

if (-not (Test-Path -LiteralPath $installedScript -PathType Leaf)) {
    throw "The installed script was not found: $installedScript`nRun the full installer instead of this updater."
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupScript = Join-Path -Path $installDirectory -ChildPath "dir_tree.py.backup-$timestamp"
$tempScript = Join-Path -Path $installDirectory -ChildPath 'dir_tree.py.update-new'

Copy-Item -LiteralPath $installedScript -Destination $backupScript -Force
try {
    Copy-Item -LiteralPath $sourceScript -Destination $tempScript -Force
    Copy-Item -LiteralPath $tempScript -Destination $installedScript -Force
    Remove-Item -LiteralPath $tempScript -Force
}
catch {
    if (Test-Path -LiteralPath $tempScript) {
        Remove-Item -LiteralPath $tempScript -Force -ErrorAction SilentlyContinue
    }
    Copy-Item -LiteralPath $backupScript -Destination $installedScript -Force
    throw
}

$installedHash = (Get-FileHash -LiteralPath $installedScript -Algorithm SHA256).Hash
$sourceHash = (Get-FileHash -LiteralPath $sourceScript -Algorithm SHA256).Hash
if ($installedHash -ne $sourceHash) {
    Copy-Item -LiteralPath $backupScript -Destination $installedScript -Force
    throw 'Post-update verification failed. The previous script was restored.'
}

Write-Host ''
Write-Host 'Updated: Copy directory tree'
Write-Host "Script:  $installedScript"
Write-Host "Backup:  $backupScript"
Write-Host "SHA-256: $installedHash"
Write-Host ''
Write-Host 'The existing File Explorer menu registration and hidden launcher were left unchanged.'

#requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$registryKeys = @(
    'Registry::HKEY_CURRENT_USER\Software\Classes\Directory\shell\CopyDirectoryTree',
    'Registry::HKEY_CURRENT_USER\Software\Classes\Directory\Background\shell\CopyDirectoryTree'
)

foreach ($registryKey in $registryKeys) {
    if (Test-Path -Path $registryKey) {
        Remove-Item -Path $registryKey -Recurse -Force
    }
}

$installDirectory = Join-Path -Path $env:LOCALAPPDATA -ChildPath 'CopyDirectoryTree'
if (Test-Path -LiteralPath $installDirectory) {
    Remove-Item -LiteralPath $installDirectory -Recurse -Force
}

Write-Host ''
Write-Host 'Removed: Copy directory tree'

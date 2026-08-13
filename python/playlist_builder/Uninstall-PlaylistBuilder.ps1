#requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$registryKeys = @(
    'Registry::HKEY_CURRENT_USER\Software\Classes\Directory\shell\GenerateVideoPlaylists',
    'Registry::HKEY_CURRENT_USER\Software\Classes\Directory\Background\shell\GenerateVideoPlaylists'
)

foreach ($keyPath in $registryKeys) {
    if (Test-Path -LiteralPath $keyPath) {
        Remove-Item -LiteralPath $keyPath -Recurse -Force
    }
}

$installDirectory = Join-Path -Path $env:LOCALAPPDATA -ChildPath 'PlaylistBuilder'
if (Test-Path -LiteralPath $installDirectory) {
    Remove-Item -LiteralPath $installDirectory -Recurse -Force
}

Write-Host ''
Write-Host 'Uninstalled: Generate video playlists'
Write-Host 'Removed the current-user Explorer entries and installed script copy.'
Write-Host 'Generated playlists and per-folder cache files were not changed.'

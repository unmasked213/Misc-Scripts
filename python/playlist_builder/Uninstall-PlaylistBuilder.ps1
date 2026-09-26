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

$runKey = 'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run'
if (Test-Path -LiteralPath $runKey) {
    Remove-ItemProperty -Path $runKey -Name 'PlaylistBuilderAutomation' -ErrorAction SilentlyContinue
}

$installDirectory = Join-Path -Path $env:LOCALAPPDATA -ChildPath 'PlaylistBuilder'
$configDirectory = Join-Path -Path $env:APPDATA -ChildPath 'PlaylistBuilder'
$stopFile = Join-Path -Path $installDirectory -ChildPath 'automation.stop'
$pidFile = Join-Path -Path $installDirectory -ChildPath 'automation.pid'

function Get-PlaylistBuilderAutomationProcessId {
    if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf)) {
        return $null
    }

    $rawProcessId = Get-Content -LiteralPath $pidFile -Raw -ErrorAction SilentlyContinue
    if ([string]::IsNullOrWhiteSpace([string]$rawProcessId)) {
        return $null
    }

    $automationProcessId = 0
    if (-not [int]::TryParse(([string]$rawProcessId).Trim(), [ref]$automationProcessId)) {
        return $null
    }

    $process = Get-Process -Id $automationProcessId -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        return $null
    }

    try {
        $processRecord = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $automationProcessId" -ErrorAction Stop
        if ($null -ne $processRecord -and -not [string]::IsNullOrWhiteSpace([string]$processRecord.CommandLine)) {
            if (([string]$processRecord.CommandLine).IndexOf('playlist_automation.py', [StringComparison]::OrdinalIgnoreCase) -lt 0) {
                return $null
            }
        }
    } catch {
        # The PID still identifies a live process. Trust it when command-line inspection is unavailable.
    }

    return $automationProcessId
}

if (Test-Path -LiteralPath $installDirectory -PathType Container) {
    New-Item -ItemType File -Path $stopFile -Force | Out-Null
    $automationProcessId = Get-PlaylistBuilderAutomationProcessId

    if ($null -eq $automationProcessId) {
        Start-Sleep -Milliseconds 750
    } else {
        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        do {
            if ($null -eq (Get-Process -Id $automationProcessId -ErrorAction SilentlyContinue)) {
                break
            }

            Start-Sleep -Milliseconds 250
        } while ([DateTime]::UtcNow -lt $deadline)

        if ($null -ne (Get-Process -Id $automationProcessId -ErrorAction SilentlyContinue)) {
            throw 'The automation is still finishing a playlist update. It has been asked to stop; run Uninstall.cmd again after that update finishes.'
        }
    }

    Remove-Item -LiteralPath $installDirectory -Recurse -Force
}

Write-Host ''
Write-Host 'Uninstalled: Playlist Builder'
Write-Host 'Removed the Explorer entries, startup registration and installed program files.'
Write-Host "Preserved configuration: $configDirectory"
Write-Host 'Generated playlists and per-folder cache files were not changed.'

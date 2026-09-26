#requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sourceGenerator = Join-Path -Path $PSScriptRoot -ChildPath 'playlist_generator.py'
$sourceAutomation = Join-Path -Path $PSScriptRoot -ChildPath 'playlist_automation.py'
$sourceConfig = Join-Path -Path $PSScriptRoot -ChildPath 'playlist_builder.json'

$requiredFiles = @($sourceGenerator, $sourceAutomation, $sourceConfig)
foreach ($requiredFile in $requiredFiles) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Required file was not found beside this installer: $requiredFile"
    }
}

$pythonLauncher = Get-Command 'py.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
$pythonArguments = '-3'

if ($null -eq $pythonLauncher) {
    $pythonLauncher = Get-Command 'python.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    $pythonArguments = ''
}

if ($null -eq $pythonLauncher) {
    throw 'Python was not found. Install Python 3.10 or later, or add it to PATH.'
}

$pythonPath = $pythonLauncher.Source
if ($pythonArguments) {
    $versionOutput = & $pythonPath $pythonArguments --version 2>&1
} else {
    $versionOutput = & $pythonPath --version 2>&1
}
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

$validationScript = Join-Path -Path ([IO.Path]::GetTempPath()) -ChildPath (
    'PlaylistBuilder-validate-{0}.py' -f [Guid]::NewGuid().ToString('N')
)
$validationSource = @'
import pathlib
import sys

for filename in sys.argv[1:]:
    path = pathlib.Path(filename)
    compile(path.read_text(encoding="utf-8"), str(path), "exec")
'@

try {
    Set-Content -LiteralPath $validationScript -Value $validationSource -Encoding ASCII

    if ($pythonArguments) {
        & $pythonPath $pythonArguments $validationScript $sourceGenerator $sourceAutomation
    } else {
        & $pythonPath $validationScript $sourceGenerator $sourceAutomation
    }

    if ($LASTEXITCODE -ne 0) {
        throw 'Python validation failed for one or more Playlist Builder scripts.'
    }
} finally {
    Remove-Item -LiteralPath $validationScript -Force -ErrorAction SilentlyContinue
}

$installDirectory = Join-Path -Path $env:LOCALAPPDATA -ChildPath 'PlaylistBuilder'
$configDirectory = Join-Path -Path $env:APPDATA -ChildPath 'PlaylistBuilder'
$installedGenerator = Join-Path -Path $installDirectory -ChildPath 'playlist_generator.py'
$installedAutomation = Join-Path -Path $installDirectory -ChildPath 'playlist_automation.py'
$installedConfig = Join-Path -Path $configDirectory -ChildPath 'playlist_builder.json'
$contextWrapper = Join-Path -Path $installDirectory -ChildPath 'PlaylistBuilder.vbs'
$automationWrapper = Join-Path -Path $installDirectory -ChildPath 'PlaylistAutomation.vbs'
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

function Stop-PlaylistBuilderAutomation {
    if (-not (Test-Path -LiteralPath $installDirectory -PathType Container)) {
        return
    }

    New-Item -ItemType File -Path $stopFile -Force | Out-Null
    $automationProcessId = Get-PlaylistBuilderAutomationProcessId

    if ($null -eq $automationProcessId) {
        Start-Sleep -Milliseconds 750
        return
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        if ($null -eq (Get-Process -Id $automationProcessId -ErrorAction SilentlyContinue)) {
            return
        }

        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)

    if ($null -ne (Get-Process -Id $automationProcessId -ErrorAction SilentlyContinue)) {
        throw 'The automation is still finishing a playlist update. It has been asked to stop; run Install.cmd again after that update finishes.'
    }
}

Stop-PlaylistBuilderAutomation

New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $configDirectory -Force | Out-Null

Copy-Item -LiteralPath $sourceGenerator -Destination $installedGenerator -Force
Copy-Item -LiteralPath $sourceAutomation -Destination $installedAutomation -Force

$configCreated = $false
if (-not (Test-Path -LiteralPath $installedConfig -PathType Leaf)) {
    Copy-Item -LiteralPath $sourceConfig -Destination $installedConfig
    $configCreated = $true
}

$pythonForVbs = $pythonPath.Replace('"', '""')
$argumentsForVbs = $pythonArguments.Replace('"', '""')
$generatorForVbs = $installedGenerator.Replace('"', '""')
$automationForVbs = $installedAutomation.Replace('"', '""')
$configForVbs = $installedConfig.Replace('"', '""')

$contextWrapperContent = @"
Option Explicit

Dim shell, pythonPath, pythonArguments, scriptPath, targetPath, command

If WScript.Arguments.Count < 1 Then
    WScript.Quit 2
End If

Set shell = CreateObject("WScript.Shell")
pythonPath = "$pythonForVbs"
pythonArguments = "$argumentsForVbs"
scriptPath = "$generatorForVbs"
targetPath = WScript.Arguments(0)

command = Quote(pythonPath)
If Len(pythonArguments) > 0 Then
    command = command & " " & pythonArguments
End If
command = command & " " & Quote(scriptPath) & " --path " & Quote(targetPath)

shell.Run command, 1, False

Function Quote(value)
    Quote = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
"@

$automationWrapperContent = @"
Option Explicit

Dim shell, pythonPath, pythonArguments, scriptPath, configPath, command

Set shell = CreateObject("WScript.Shell")
pythonPath = "$pythonForVbs"
pythonArguments = "$argumentsForVbs"
scriptPath = "$automationForVbs"
configPath = "$configForVbs"

command = Quote(pythonPath)
If Len(pythonArguments) > 0 Then
    command = command & " " & pythonArguments
End If
command = command & " " & Quote(scriptPath) & " --config " & Quote(configPath)

shell.Run command, 0, False

Function Quote(value)
    Quote = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
"@

Set-Content -LiteralPath $contextWrapper -Value $contextWrapperContent -Encoding Unicode
Set-Content -LiteralPath $automationWrapper -Value $automationWrapperContent -Encoding Unicode

$entries = @(
    @{
        Path = 'Registry::HKEY_CURRENT_USER\Software\Classes\Directory\shell\GenerateVideoPlaylists'
        Argument = '%1'
    },
    @{
        Path = 'Registry::HKEY_CURRENT_USER\Software\Classes\Directory\Background\shell\GenerateVideoPlaylists'
        Argument = '%V'
    }
)

foreach ($entry in $entries) {
    $keyPath = $entry.Path
    $commandKeyPath = "$keyPath\command"
    $command = 'wscript.exe "' + $contextWrapper + '" "' + $entry.Argument + '"'

    New-Item -Path $keyPath -Force | Out-Null
    Set-Item -Path $keyPath -Value 'Generate video playlists'

    New-Item -Path $commandKeyPath -Force | Out-Null
    Set-Item -Path $commandKeyPath -Value $command
}

$runKey = 'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run'
$runCommand = 'wscript.exe "' + $automationWrapper + '"'
New-Item -Path $runKey -Force | Out-Null
New-ItemProperty -Path $runKey -Name 'PlaylistBuilderAutomation' -PropertyType String -Value $runCommand -Force | Out-Null

Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue

if ($pythonArguments) {
    & $pythonPath $pythonArguments $installedAutomation --config $installedConfig --validate-config
} else {
    & $pythonPath $installedAutomation --config $installedConfig --validate-config
}

if ($LASTEXITCODE -ne 0) {
    Write-Warning "The persistent configuration is invalid. It was preserved at: $installedConfig"
}

Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $automationWrapper + '"') -WindowStyle Hidden

$configStatus = if ($configCreated) { 'created' } else { 'preserved' }

Write-Host ''
Write-Host 'Installed: Playlist Builder'
Write-Host "Generator:  $installedGenerator"
Write-Host "Automation: $installedAutomation"
Write-Host "Config:     $installedConfig ($configStatus)"
Write-Host 'Scope:      current user only; no administrator rights required'
Write-Host 'Menus:      selected folders and folder backgrounds'
Write-Host 'Startup:    hidden automation registered for the current user'

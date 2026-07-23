#requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sourceScript = Join-Path -Path $PSScriptRoot -ChildPath 'dir_tree.py'
if (-not (Test-Path -LiteralPath $sourceScript -PathType Leaf)) {
    throw "dir_tree.py was not found beside this installer: $sourceScript"
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

$installDirectory = Join-Path -Path $env:LOCALAPPDATA -ChildPath 'CopyDirectoryTree'
$installedScript = Join-Path -Path $installDirectory -ChildPath 'dir_tree.py'
$wrapperPath = Join-Path -Path $installDirectory -ChildPath 'CopyDirectoryTree.vbs'

New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null
Copy-Item -LiteralPath $sourceScript -Destination $installedScript -Force

$pythonForVbs = $pythonPath.Replace('"', '""')
$argumentsForVbs = $pythonArguments.Replace('"', '""')
$scriptForVbs = $installedScript.Replace('"', '""')

$wrapper = @"
Option Explicit

Dim shell, pythonPath, pythonArguments, scriptPath, targetPath, command

If WScript.Arguments.Count < 1 Then
    WScript.Quit 2
End If

Set shell = CreateObject("WScript.Shell")
pythonPath = "$pythonForVbs"
pythonArguments = "$argumentsForVbs"
scriptPath = "$scriptForVbs"
targetPath = WScript.Arguments(0)

command = Quote(pythonPath)
If Len(pythonArguments) > 0 Then
    command = command & " " & pythonArguments
End If
command = command & " " & Quote(scriptPath) & " --clipboard --path " & Quote(targetPath)

shell.Run command, 0, False

Function Quote(value)
    Quote = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
"@

Set-Content -LiteralPath $wrapperPath -Value $wrapper -Encoding Unicode

$entries = @(
    @{
        Path = 'Registry::HKEY_CURRENT_USER\Software\Classes\Directory\shell\CopyDirectoryTree'
        Argument = '%1'
    },
    @{
        Path = 'Registry::HKEY_CURRENT_USER\Software\Classes\Directory\Background\shell\CopyDirectoryTree'
        Argument = '%V'
    }
)

foreach ($entry in $entries) {
    $keyPath = $entry.Path
    $commandKeyPath = "$keyPath\command"
    $command = 'wscript.exe "' + $wrapperPath + '" "' + $entry.Argument + '"'

    New-Item -Path $keyPath -Force | Out-Null
    Set-Item -Path $keyPath -Value 'Copy directory tree'

    New-Item -Path $commandKeyPath -Force | Out-Null
    Set-Item -Path $commandKeyPath -Value $command
}

Write-Host ''
Write-Host 'Installed: Copy directory tree'
Write-Host "Script:    $installedScript"
Write-Host 'Scope:     current user only; no administrator rights required'
Write-Host 'Menus:     selected folders and folder backgrounds'

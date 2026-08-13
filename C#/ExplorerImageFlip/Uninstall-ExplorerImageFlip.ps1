#requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$extensions = @(
    '.jpg',
    '.jpeg',
    '.jpe',
    '.jfif',
    '.png',
    '.bmp',
    '.dib',
    '.gif',
    '.tif',
    '.tiff'
)

$classesRoot = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey(
    'Software\Classes',
    [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree
)

if ($null -eq $classesRoot) {
    throw 'Could not open HKCU\Software\Classes for writing.'
}

try {
    foreach ($extension in $extensions) {
        $path = "SystemFileAssociations\$extension\shell\ExplorerImageFlip"

        try {
            $classesRoot.DeleteSubKeyTree($path, $false)
        }
        catch [System.ArgumentException] {
        }
    }

    try {
        $classesRoot.DeleteSubKeyTree('ExplorerImageFlip.ContextMenu', $false)
    }
    catch [System.ArgumentException] {
    }
}
finally {
    $classesRoot.Dispose()
}

if (-not ('ExplorerImageFlip.UninstallShellNotify' -as [type])) {
    Add-Type -Namespace ExplorerImageFlip -Name UninstallShellNotify -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("shell32.dll")]
public static extern void SHChangeNotify(
    uint eventId,
    uint flags,
    System.IntPtr item1,
    System.IntPtr item2);
'@
}

[ExplorerImageFlip.UninstallShellNotify]::SHChangeNotify(
    0x08000000,
    0,
    [IntPtr]::Zero,
    [IntPtr]::Zero
)

$installDirectory = Join-Path -Path $env:LOCALAPPDATA -ChildPath 'ExplorerImageFlip'

if (Test-Path -LiteralPath $installDirectory) {
    Remove-Item -LiteralPath $installDirectory -Recurse -Force
}

Write-Host ''
Write-Host 'Removed: Explorer Image Flip'

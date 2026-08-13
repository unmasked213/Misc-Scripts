#requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$version = '1.0.2'
$sourcePath = Join-Path -Path $PSScriptRoot -ChildPath 'ExplorerImageFlip.cs'

if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
    throw "ExplorerImageFlip.cs was not found beside this installer: $sourcePath"
}

$installDirectory = Join-Path -Path $env:LOCALAPPDATA -ChildPath 'ExplorerImageFlip'
$installedSource = Join-Path -Path $installDirectory -ChildPath 'ExplorerImageFlip.cs'
$installedExecutable = Join-Path -Path $installDirectory -ChildPath 'ExplorerImageFlip.exe'
$buildExecutable = Join-Path -Path $installDirectory -ChildPath (
    'ExplorerImageFlip.build-' + [Guid]::NewGuid().ToString('N') + '.exe'
)

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

$sharedMenuClass = 'ExplorerImageFlip.ContextMenu'
$horizontalCommand = '"' + $installedExecutable + '" horizontal --explorer-selection "%1"'
$verticalCommand = '"' + $installedExecutable + '" vertical --explorer-selection "%1"'

function Remove-SubKeyTree {
    param(
        [Parameter(Mandatory = $true)]
        [Microsoft.Win32.RegistryKey] $Root,

        [Parameter(Mandatory = $true)]
        [string] $Path
    )

    try {
        $Root.DeleteSubKeyTree($Path, $false)
    }
    catch [System.ArgumentException] {
        # The key disappeared between lookup and deletion.
    }
}

function Set-StringValue {
    param(
        [Parameter(Mandatory = $true)]
        [Microsoft.Win32.RegistryKey] $Key,

        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string] $Name,

        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string] $Value
    )

    $Key.SetValue(
        $Name,
        $Value,
        [Microsoft.Win32.RegistryValueKind]::String
    )
}

function Assert-RegistryString {
    param(
        [Parameter(Mandatory = $true)]
        [Microsoft.Win32.RegistryKey] $Root,

        [Parameter(Mandatory = $true)]
        [string] $Path,

        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string] $Name,

        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string] $Expected
    )

    $key = $Root.OpenSubKey($Path, $false)

    if ($null -eq $key) {
        throw "Registry verification failed because this key is missing: HKCU\Software\Classes\$Path"
    }

    try {
        $actual = [string] $key.GetValue($Name, $null)

        if ($actual -cne $Expected) {
            $displayName = if ($Name.Length -eq 0) { '(Default)' } else { $Name }
            throw (
                "Registry verification failed for HKCU\Software\Classes\$Path " +
                "value $displayName. Expected '$Expected'; found '$actual'."
            )
        }
    }
    finally {
        $key.Dispose()
    }
}

New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null
Copy-Item -LiteralPath $sourcePath -Destination $installedSource -Force

Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Xaml
Add-Type -AssemblyName Microsoft.CSharp

# BitmapMetadata implements System.Windows.Markup.IUriContext. The C# compiler
# therefore needs System.Xaml explicitly, although the imaging types themselves
# live in PresentationCore.
$referenceAssemblies = @(
    [System.Uri].Assembly.Location
    [System.Linq.Enumerable].Assembly.Location
    [Microsoft.CSharp.RuntimeBinder.Binder].Assembly.Location
    [System.Windows.DependencyObject].Assembly.Location
    [System.Xaml.XamlReader].Assembly.Location
    [System.Windows.Media.Imaging.BitmapDecoder].Assembly.Location
) | Select-Object -Unique

try {
    $compilerParameters = @{
        LiteralPath = $installedSource
        ReferencedAssemblies = $referenceAssemblies
        OutputAssembly = $buildExecutable
        OutputType = 'WindowsApplication'
    }

    Add-Type @compilerParameters

    if (-not (Test-Path -LiteralPath $buildExecutable -PathType Leaf)) {
        throw "The compiler did not create the expected executable: $buildExecutable"
    }

    # Start the newly built GUI executable with a valid command but no files.
    # A zero exit code proves Windows can load and run it before an existing
    # installation is replaced.
    $smokeTest = Start-Process `
        -FilePath $buildExecutable `
        -ArgumentList 'horizontal' `
        -PassThru `
        -Wait

    if ($smokeTest.ExitCode -ne 0) {
        throw "The compiled executable failed its launch test with exit code $($smokeTest.ExitCode)."
    }

    if (Test-Path -LiteralPath $installedExecutable) {
        Remove-Item -LiteralPath $installedExecutable -Force
    }

    Move-Item -LiteralPath $buildExecutable -Destination $installedExecutable -Force
}
finally {
    if (Test-Path -LiteralPath $buildExecutable) {
        Remove-Item -LiteralPath $buildExecutable -Force -ErrorAction SilentlyContinue
    }
}

$classesRoot = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey(
    'Software\Classes',
    [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree
)

if ($null -eq $classesRoot) {
    throw 'Could not open HKCU\Software\Classes for writing.'
}

try {
    # Remove both the previous inline-cascade registration and any earlier
    # shared-menu registration before writing the corrected layout.
    Remove-SubKeyTree -Root $classesRoot -Path $sharedMenuClass

    foreach ($extension in $extensions) {
        Remove-SubKeyTree `
            -Root $classesRoot `
            -Path "SystemFileAssociations\$extension\shell\ExplorerImageFlip"
    }

    # Create one shared submenu. Each supported extension points to this key
    # through an ExtendedSubCommandsKey REG_SZ value. This is deliberately not
    # an inline child key beneath the parent verb.
    $horizontalKey = $classesRoot.CreateSubKey(
        "$sharedMenuClass\shell\Horizontal",
        [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree
    )

    try {
        Set-StringValue -Key $horizontalKey -Name 'MUIVerb' -Value 'Flip horizontally'
        Set-StringValue -Key $horizontalKey -Name 'Icon' -Value ($installedExecutable + ',0')
        Set-StringValue -Key $horizontalKey -Name 'MultiSelectModel' -Value 'Player'

        $commandKey = $horizontalKey.CreateSubKey(
            'command',
            [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree
        )

        try {
            Set-StringValue -Key $commandKey -Name '' -Value $horizontalCommand
        }
        finally {
            $commandKey.Dispose()
        }
    }
    finally {
        $horizontalKey.Dispose()
    }

    $verticalKey = $classesRoot.CreateSubKey(
        "$sharedMenuClass\shell\Vertical",
        [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree
    )

    try {
        Set-StringValue -Key $verticalKey -Name 'MUIVerb' -Value 'Flip vertically'
        Set-StringValue -Key $verticalKey -Name 'Icon' -Value ($installedExecutable + ',0')
        Set-StringValue -Key $verticalKey -Name 'MultiSelectModel' -Value 'Player'

        $commandKey = $verticalKey.CreateSubKey(
            'command',
            [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree
        )

        try {
            Set-StringValue -Key $commandKey -Name '' -Value $verticalCommand
        }
        finally {
            $commandKey.Dispose()
        }
    }
    finally {
        $verticalKey.Dispose()
    }

    foreach ($extension in $extensions) {
        $parentPath = "SystemFileAssociations\$extension\shell\ExplorerImageFlip"
        $parentKey = $classesRoot.CreateSubKey(
            $parentPath,
            [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree
        )

        try {
            Set-StringValue -Key $parentKey -Name 'MUIVerb' -Value 'Flip image'
            Set-StringValue -Key $parentKey -Name 'Icon' -Value ($installedExecutable + ',0')
            Set-StringValue -Key $parentKey -Name 'MultiSelectModel' -Value 'Player'
            Set-StringValue `
                -Key $parentKey `
                -Name 'ExtendedSubCommandsKey' `
                -Value $sharedMenuClass
        }
        finally {
            $parentKey.Dispose()
        }
    }

    Assert-RegistryString `
        -Root $classesRoot `
        -Path "$sharedMenuClass\shell\Horizontal\command" `
        -Name '' `
        -Expected $horizontalCommand

    Assert-RegistryString `
        -Root $classesRoot `
        -Path "$sharedMenuClass\shell\Vertical\command" `
        -Name '' `
        -Expected $verticalCommand

    foreach ($extension in $extensions) {
        Assert-RegistryString `
            -Root $classesRoot `
            -Path "SystemFileAssociations\$extension\shell\ExplorerImageFlip" `
            -Name 'ExtendedSubCommandsKey' `
            -Expected $sharedMenuClass
    }
}
finally {
    $classesRoot.Dispose()
}

if (-not ('ExplorerImageFlip.InstallShellNotify' -as [type])) {
    Add-Type -Namespace ExplorerImageFlip -Name InstallShellNotify -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("shell32.dll")]
public static extern void SHChangeNotify(
    uint eventId,
    uint flags,
    System.IntPtr item1,
    System.IntPtr item2);
'@
}

[ExplorerImageFlip.InstallShellNotify]::SHChangeNotify(
    0x08000000,
    0,
    [IntPtr]::Zero,
    [IntPtr]::Zero
)

Write-Host ''
Write-Host "Installed: Explorer Image Flip $version"
Write-Host "Program:   $installedExecutable"
Write-Host 'Scope:     current user only; no administrator rights required'
Write-Host 'Menus:     Flip image > Flip horizontally / Flip vertically'
Write-Host 'Formats:   JPEG, PNG, BMP, GIF and TIFF'

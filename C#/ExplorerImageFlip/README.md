# Explorer Image Flip

Adds this per-user Windows File Explorer menu to supported image files:

```text
Flip image
├── Flip horizontally
└── Flip vertically
```

The selected files are modified in place. One image or a multi-selection can be
processed. Successful operations are silent; failures are collected into one
Windows error dialog and written to a local log.

## Version 1.0.2

This release changes the cascading-menu registration. Each supported file
extension now contains an `ExtendedSubCommandsKey` string value pointing to one
shared submenu class:

```text
HKCU\Software\Classes\ExplorerImageFlip.ContextMenu
```

The earlier package created `ExtendedSubCommandsKey` as an inline child beneath
each extension's verb. Explorer did not recognise that layout on the target
machine and invoked the parent as if it were an ordinary verb, producing the
"no app associated" dialog.

The installer also verifies every command value after registration and launch
tests the newly compiled executable before replacing an existing installation.

## Why this uses a small C# helper

The earlier Explorer image tool already contained the important part:
`JpegBitmapEncoder.FlipHorizontal`. This version adds `FlipVertical`, explicit
file arguments, context-menu activation, duplicate-invocation protection and a
safer install path.

JPEG files keep the WPF/WIC JPEG transform path instead of being sent through
FFmpeg. That avoids an ordinary decode-and-reencode generation. PNG, BMP, GIF
and TIFF are decoded, flipped and re-encoded with their corresponding WPF
lossless-format encoders.

The installer compiles the helper with Windows PowerShell 5.1 and the WPF
assemblies already present on Windows 10 and Windows 11, including the explicit
`System.Xaml` reference required by WPF bitmap metadata. Python, FFmpeg, the
.NET 8 SDK and administrator rights are not required.

## Supported formats

- JPEG: `.jpg`, `.jpeg`, `.jpe`, `.jfif`
- PNG: `.png`
- BMP: `.bmp`, `.dib`
- GIF: `.gif`
- TIFF: `.tif`, `.tiff`

WebP, AVIF and HEIC are deliberately not registered. They need a separate codec
path and cannot inherit the JPEG lossless-transform guarantee.

## Install or update

Run:

```text
Install.cmd
```

There is no need to uninstall an earlier package first. The installer removes
the earlier menu registration, compiles the helper, launch tests it, writes the
corrected shared submenu registration, verifies the registry values and
refreshes Explorer's association cache.

The executable and source are installed to:

```text
%LocalAppData%\ExplorerImageFlip
```

The installation is current-user only and requires no administrator rights.

## Behaviour and safety

- The operation replaces each original file.
- A unique temporary file is created beside the original.
- The temporary output is decoded and validated before replacement.
- Replacement uses `File.Replace` where supported.
- A rollback path is used when atomic replacement is unavailable.
- One failed file does not stop the remaining selected files.
- Read-only attributes are temporarily cleared and restored.
- Explorer is notified after each successful replacement so thumbnails refresh.
- Repeated shell activations for the same selection are de-duplicated.

The menu is registered with Windows' `Player` multi-selection model. Legacy
static verbs support selections of up to 100 items.

## Error log

Errors are appended to:

```text
%LocalAppData%\ExplorerImageFlip\ExplorerImageFlip.log
```

No log is written for successful operations.

## Uninstall

Run:

```text
Uninstall.cmd
```

This removes both the per-extension parent verbs and the shared submenu class,
then deletes the installed program directory.

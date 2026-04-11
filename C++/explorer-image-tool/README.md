# ExplorerImageTool

Rotate and flip images directly from Explorer selection via G Hub mouse buttons.
JPEG transforms are lossless — same WIC codepath Explorer uses internally.

## How It Works

G Hub button → launches EXE with arg → EXE queries foreground Explorer window
via Shell COM → gets selected files → applies transform → exits. No background
process, no hooks, no runtime dependency.

JPEG uses WPF's JpegBitmapEncoder which exposes Rotation and FlipHorizontal as
lossless transform properties. Internally these set WIC's BitmapTransform option,
which rearranges DCT blocks directly — no decode/reencode, zero quality loss.
PNG/BMP/TIFF use WPF's TransformedBitmap — inherently lossless formats.

## Setup

### 1. Install .NET 8 SDK

https://dotnet.microsoft.com/en-us/download/dotnet/8.0 (SDK, not runtime)

```
dotnet --version
```

### 2. Build

```
cd D:\scripts\ExplorerImageTool
dotnet publish -c Release
```

Output: `bin\Release\net8.0-windows\win-x64\publish\ExplorerImageTool.exe`

### 3. G Hub

G502 X Plus → profile → assignments:

**G-Shift + Scroll Tilt Left → Rotate 90° CW**
- System → Launch Application
- Path: `D:\scripts\ExplorerImageTool\bin\Release\net8.0-windows\win-x64\publish\ExplorerImageTool.exe`
- Arguments: `rotate`

**G-Shift + Scroll Tilt Right → Flip Horizontal**
- Same path, arguments: `flip`

## Usage

Select image(s) in Explorer → G-Shift + tilt left (rotate) or right (flip).

## Notes

- JPEG: Lossless. DCT block transform. No quality loss, unlimited repeat use.
- PNG/BMP/TIFF/GIF: Decode/transform/reencode — lossless formats, no loss.
- WEBP: Not supported (no built-in WPF encoder).
- Batch: All selected images transform. Non-image files silently skipped.
- No window: WinExe output — no console flash on execution.
- Explorer only: Non-Explorer foreground window → nothing happens.
- Single file: ~65 MB self-contained (includes .NET + WPF runtime).

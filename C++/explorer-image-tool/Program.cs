using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Media;
using System.Windows.Media.Imaging;

class Program
{
    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();

    static readonly HashSet<string> JpegExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".jpg", ".jpeg"
    };

    static readonly HashSet<string> OtherImageExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".png", ".bmp", ".gif", ".tiff", ".tif"
    };

    [STAThread]
    static void Main(string[] args)
    {
        if (args.Length == 0) return;

        string mode = args[0].ToLower();
        if (mode != "rotate" && mode != "flip") return;

        var files = GetSelectedExplorerFiles();
        if (files.Count == 0) return;

        foreach (string file in files)
        {
            string ext = Path.GetExtension(file);
            if (!File.Exists(file)) continue;

            try
            {
                if (JpegExtensions.Contains(ext))
                    TransformJpegLossless(file, mode);
                else if (OtherImageExtensions.Contains(ext))
                    TransformOther(file, mode);
            }
            catch
            {
                // Silent fail per file — one bad file doesn't block the batch
            }
        }
    }

    /// <summary>
    /// Lossless JPEG transform via WPF's JpegBitmapEncoder.
    /// Sets Rotation or FlipHorizontal on the encoder, which writes the
    /// BitmapTransform property to WIC's IPropertyBag2. WIC rearranges
    /// DCT blocks directly — no decode/reencode, zero quality loss.
    /// </summary>
    static void TransformJpegLossless(string path, string mode)
    {
        string tempPath = path + ".tmp";

        try
        {
            // Decode — OnLoad caches everything in memory so we can release the file
            BitmapFrame sourceFrame;
            using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                var decoder = BitmapDecoder.Create(
                    fs,
                    BitmapCreateOptions.PreservePixelFormat,
                    BitmapCacheOption.OnLoad);
                sourceFrame = decoder.Frames[0];
            }

            // Encode with lossless transform
            var encoder = new JpegBitmapEncoder();

            if (mode == "rotate")
                encoder.Rotation = Rotation.Rotate90;
            else
                encoder.FlipHorizontal = true;

            // QualityLevel is intentionally left at default — the lossless
            // transform operates on DCT blocks and doesn't re-encode pixels

            encoder.Frames.Add(BitmapFrame.Create(sourceFrame));

            using (var fs = new FileStream(tempPath, FileMode.Create, FileAccess.Write))
            {
                encoder.Save(fs);
            }

            // Atomic replace — single NTFS operation, no gap where file is missing
            File.Replace(tempPath, path, null);
        }
        catch
        {
            try { if (File.Exists(tempPath)) File.Delete(tempPath); } catch { }
            throw;
        }
    }

    /// <summary>
    /// Non-JPEG transform via WPF decode → TransformedBitmap → encode.
    /// PNG, BMP, TIFF are lossless formats so re-encoding preserves quality.
    /// </summary>
    static void TransformOther(string path, string mode)
    {
        string tempPath = path + ".tmp";

        try
        {
            BitmapDecoder sourceDecoder;
            using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                sourceDecoder = BitmapDecoder.Create(
                    fs,
                    BitmapCreateOptions.PreservePixelFormat,
                    BitmapCacheOption.OnLoad);
            }

            Transform transform = mode == "rotate"
                ? new RotateTransform(90)
                : new ScaleTransform(-1, 1);

            BitmapEncoder encoder = Path.GetExtension(path).ToLower() switch
            {
                ".png" => new PngBitmapEncoder(),
                ".bmp" => new BmpBitmapEncoder(),
                ".tiff" or ".tif" => new TiffBitmapEncoder(),
                ".gif" => new GifBitmapEncoder(),
                _ => new PngBitmapEncoder()
            };

            // Process all frames — preserves animated GIFs and multi-page TIFFs
            foreach (var frame in sourceDecoder.Frames)
            {
                var transformed = new TransformedBitmap(frame, transform);
                encoder.Frames.Add(BitmapFrame.Create(transformed));
            }

            using (var fs = new FileStream(tempPath, FileMode.Create, FileAccess.Write))
            {
                encoder.Save(fs);
            }

            File.Replace(tempPath, path, null);
        }
        catch
        {
            try { if (File.Exists(tempPath)) File.Delete(tempPath); } catch { }
            throw;
        }
    }

    /// <summary>
    /// Queries the foreground Explorer window for its current file selection
    /// via Shell.Application COM automation. Returns full paths of selected items.
    /// </summary>
    static List<string> GetSelectedExplorerFiles()
    {
        var result = new List<string>();
        dynamic? shell = null;
        dynamic? windows = null;

        try
        {
            Type? shellType = Type.GetTypeFromProgID("Shell.Application");
            if (shellType == null) return result;

            shell = Activator.CreateInstance(shellType);
            windows = shell!.Windows();
            IntPtr foreground = GetForegroundWindow();

            for (int i = 0; i < windows.Count; i++)
            {
                try
                {
                    dynamic? window = windows.Item(i);
                    if (window == null) continue;

                    if (new IntPtr(Convert.ToInt64(window.HWND)) != foreground) continue;

                    dynamic doc = window.Document;
                    dynamic selected = doc.SelectedItems();

                    for (int j = 0; j < selected.Count; j++)
                    {
                        result.Add((string)selected.Item(j).Path);
                    }

                    break;
                }
                catch { continue; }
            }
        }
        catch { }
        finally
        {
            if (windows != null) Marshal.ReleaseComObject(windows);
            if (shell != null) Marshal.ReleaseComObject(shell);
        }

        return result;
    }
}

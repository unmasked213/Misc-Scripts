using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Media;
using System.Windows.Media.Imaging;

internal enum FlipDirection
{
    Horizontal,
    Vertical
}

internal sealed class TransformFailure
{
    internal TransformFailure(string path, Exception exception)
    {
        Path = path;
        Exception = exception;
    }

    internal string Path { get; private set; }
    internal Exception Exception { get; private set; }
}

internal static class Program
{
    private const uint SHCNE_UPDATEITEM = 0x00002000;
    private const uint SHCNF_PATHW = 0x0005;
    private const uint MB_OK = 0x00000000;
    private const uint MB_ICONERROR = 0x00000010;
    private const int DuplicateWindowMilliseconds = 2000;

    private static readonly HashSet<string> JpegExtensions =
        new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            ".jpg", ".jpeg", ".jpe", ".jfif"
        };

    private static readonly HashSet<string> OtherImageExtensions =
        new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            ".png", ".bmp", ".dib", ".gif", ".tif", ".tiff"
        };

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBoxW(
        IntPtr hWnd,
        string text,
        string caption,
        uint type);

    [DllImport("shell32.dll")]
    private static extern void SHChangeNotify(
        uint eventId,
        uint flags,
        IntPtr item1,
        IntPtr item2);

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            return Run(args);
        }
        catch (Exception exception)
        {
            string logPath = WriteFatalLog(exception);
            ShowError(
                "Flip image failed before the selected files could be processed."
                + Environment.NewLine + Environment.NewLine
                + exception.Message
                + LogLocationSuffix(logPath));
            return 1;
        }
    }

    private static int Run(string[] args)
    {
        FlipDirection direction;
        bool includeExplorerSelection;
        List<string> suppliedPaths;

        if (!TryParseArguments(
            args,
            out direction,
            out includeExplorerSelection,
            out suppliedPaths))
        {
            return 2;
        }

        List<string> files = NormalizeSupportedPaths(suppliedPaths);

        if (includeExplorerSelection)
        {
            List<string> explorerFiles = NormalizeSupportedPaths(
                GetSelectedExplorerFiles());

            if (files.Count == 0 || HaveCommonPath(files, explorerFiles))
            {
                files.AddRange(explorerFiles);
                files = NormalizeSupportedPaths(files);
            }
        }
        if (files.Count == 0)
        {
            return 0;
        }

        if (IsDuplicateShellInvocation(direction, files))
        {
            return 0;
        }

        List<TransformFailure> failures = new List<TransformFailure>();

        foreach (string file in files)
        {
            try
            {
                TransformImage(file, direction);
                NotifyExplorer(file);
            }
            catch (Exception exception)
            {
                failures.Add(new TransformFailure(file, exception));
            }
        }

        if (failures.Count == 0)
        {
            return 0;
        }

        string failureLog = WriteFailureLog(direction, failures);
        ShowError(BuildFailureMessage(files.Count, failures, failureLog));
        return 1;
    }

    private static bool TryParseArguments(
        string[] args,
        out FlipDirection direction,
        out bool includeExplorerSelection,
        out List<string> paths)
    {
        direction = FlipDirection.Horizontal;
        includeExplorerSelection = false;
        paths = new List<string>();

        if (args == null || args.Length == 0)
        {
            return false;
        }

        string mode = args[0].Trim().ToLowerInvariant();
        if (mode == "horizontal" || mode == "flip-horizontal" || mode == "h")
        {
            direction = FlipDirection.Horizontal;
        }
        else if (mode == "vertical" || mode == "flip-vertical" || mode == "v")
        {
            direction = FlipDirection.Vertical;
        }
        else
        {
            return false;
        }

        for (int index = 1; index < args.Length; index++)
        {
            string argument = args[index];
            if (string.Equals(
                argument,
                "--explorer-selection",
                StringComparison.OrdinalIgnoreCase))
            {
                includeExplorerSelection = true;
                continue;
            }

            if (!string.IsNullOrWhiteSpace(argument))
            {
                paths.Add(argument);
            }
        }

        return true;
    }

    private static List<string> NormalizeSupportedPaths(IEnumerable<string> paths)
    {
        List<string> result = new List<string>();
        HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (string suppliedPath in paths)
        {
            if (string.IsNullOrWhiteSpace(suppliedPath))
            {
                continue;
            }

            string fullPath;
            try
            {
                fullPath = Path.GetFullPath(suppliedPath.Trim());
            }
            catch
            {
                continue;
            }

            if (!File.Exists(fullPath))
            {
                continue;
            }

            string extension = Path.GetExtension(fullPath);
            if (!JpegExtensions.Contains(extension)
                && !OtherImageExtensions.Contains(extension))
            {
                continue;
            }

            if (seen.Add(fullPath))
            {
                result.Add(fullPath);
            }
        }

        return result;
    }

    private static bool HaveCommonPath(
        IEnumerable<string> first,
        IEnumerable<string> second)
    {
        HashSet<string> paths = new HashSet<string>(
            first,
            StringComparer.OrdinalIgnoreCase);

        foreach (string candidate in second)
        {
            if (paths.Contains(candidate))
            {
                return true;
            }
        }

        return false;
    }

    private static void TransformImage(string path, FlipDirection direction)
    {
        string extension = Path.GetExtension(path);

        if (JpegExtensions.Contains(extension))
        {
            TransformJpegLossless(path, direction);
            return;
        }

        TransformOtherImage(path, direction);
    }

    private static void TransformJpegLossless(
        string path,
        FlipDirection direction)
    {
        string temporaryPath = CreateTemporaryPath(path);

        try
        {
            BitmapFrame sourceFrame;
            using (FileStream input = new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read))
            {
                BitmapDecoder decoder = BitmapDecoder.Create(
                    input,
                    BitmapCreateOptions.PreservePixelFormat,
                    BitmapCacheOption.OnLoad);

                if (decoder.Frames.Count == 0)
                {
                    throw new InvalidDataException("The JPEG contains no image frame.");
                }

                sourceFrame = decoder.Frames[0];
            }

            JpegBitmapEncoder encoder = new JpegBitmapEncoder();
            encoder.FlipHorizontal = direction == FlipDirection.Horizontal;
            encoder.FlipVertical = direction == FlipDirection.Vertical;
            // Keep the exact cached source frame. This preserves the original
            // WIC JPEG transform path instead of introducing a pixel transform.
            encoder.Frames.Add(BitmapFrame.Create(sourceFrame));

            using (FileStream output = new FileStream(
                temporaryPath,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None))
            {
                encoder.Save(output);
                output.Flush();
            }

            ValidateImage(temporaryPath);
            ReplaceOriginal(temporaryPath, path);
        }
        catch
        {
            DeleteIfPresent(temporaryPath);
            throw;
        }
    }

    private static void TransformOtherImage(
        string path,
        FlipDirection direction)
    {
        string temporaryPath = CreateTemporaryPath(path);

        try
        {
            BitmapDecoder decoder;
            using (FileStream input = new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read))
            {
                decoder = BitmapDecoder.Create(
                    input,
                    BitmapCreateOptions.PreservePixelFormat,
                    BitmapCacheOption.OnLoad);
            }

            if (decoder.Frames.Count == 0)
            {
                throw new InvalidDataException("The image contains no frame.");
            }

            BitmapEncoder encoder = CreateEncoder(Path.GetExtension(path));
            TryCopyGlobalMetadata(decoder, encoder);

            Transform transform = direction == FlipDirection.Horizontal
                ? (Transform)new ScaleTransform(-1, 1)
                : new ScaleTransform(1, -1);

            foreach (BitmapFrame sourceFrame in decoder.Frames)
            {
                TransformedBitmap transformed =
                    new TransformedBitmap(sourceFrame, transform);

                encoder.Frames.Add(
                    CreateOutputFrame(transformed, sourceFrame));
            }

            using (FileStream output = new FileStream(
                temporaryPath,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None))
            {
                encoder.Save(output);
                output.Flush();
            }

            ValidateImage(temporaryPath);
            ReplaceOriginal(temporaryPath, path);
        }
        catch
        {
            DeleteIfPresent(temporaryPath);
            throw;
        }
    }

    private static BitmapEncoder CreateEncoder(string extension)
    {
        if (string.Equals(extension, ".png", StringComparison.OrdinalIgnoreCase))
        {
            return new PngBitmapEncoder();
        }

        if (string.Equals(extension, ".bmp", StringComparison.OrdinalIgnoreCase)
            || string.Equals(extension, ".dib", StringComparison.OrdinalIgnoreCase))
        {
            return new BmpBitmapEncoder();
        }

        if (string.Equals(extension, ".gif", StringComparison.OrdinalIgnoreCase))
        {
            return new GifBitmapEncoder();
        }

        if (string.Equals(extension, ".tif", StringComparison.OrdinalIgnoreCase)
            || string.Equals(extension, ".tiff", StringComparison.OrdinalIgnoreCase))
        {
            TiffBitmapEncoder tiffEncoder = new TiffBitmapEncoder();
            tiffEncoder.Compression = TiffCompressOption.Zip;
            return tiffEncoder;
        }

        throw new NotSupportedException(
            "Unsupported image format: " + extension);
    }

    private static BitmapFrame CreateOutputFrame(
        BitmapSource transformedSource,
        BitmapFrame originalFrame)
    {
        BitmapMetadata metadata = CloneMetadata(
            originalFrame.Metadata as BitmapMetadata);

        ReadOnlyCollection<ColorContext> colorContexts = null;
        try
        {
            colorContexts = originalFrame.ColorContexts;
        }
        catch
        {
            colorContexts = null;
        }

        try
        {
            return BitmapFrame.Create(
                transformedSource,
                null,
                metadata,
                colorContexts);
        }
        catch
        {
            return BitmapFrame.Create(transformedSource);
        }
    }

    private static BitmapMetadata CloneMetadata(BitmapMetadata metadata)
    {
        if (metadata == null)
        {
            return null;
        }

        try
        {
            return metadata.Clone() as BitmapMetadata;
        }
        catch
        {
            return null;
        }
    }

    private static void TryCopyGlobalMetadata(
        BitmapDecoder decoder,
        BitmapEncoder encoder)
    {
        try
        {
            BitmapMetadata metadata = CloneMetadata(
                decoder.Metadata as BitmapMetadata);

            if (metadata != null)
            {
                encoder.Metadata = metadata;
            }
        }
        catch
        {
            // Frame metadata is still copied where the codec supports it.
        }
    }

    private static void ValidateImage(string path)
    {
        using (FileStream stream = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read))
        {
            BitmapDecoder decoder = BitmapDecoder.Create(
                stream,
                BitmapCreateOptions.PreservePixelFormat,
                BitmapCacheOption.OnLoad);

            if (decoder.Frames.Count == 0
                || decoder.Frames[0].PixelWidth <= 0
                || decoder.Frames[0].PixelHeight <= 0)
            {
                throw new InvalidDataException(
                    "The transformed output could not be validated.");
            }
        }
    }

    private static string CreateTemporaryPath(string originalPath)
    {
        string directory = Path.GetDirectoryName(originalPath);
        string fileName = Path.GetFileName(originalPath);

        return Path.Combine(
            directory,
            "." + fileName + ".flip-" + Guid.NewGuid().ToString("N") + ".tmp");
    }

    private static void ReplaceOriginal(
        string temporaryPath,
        string originalPath)
    {
        FileAttributes originalAttributes = File.GetAttributes(originalPath);
        bool clearedReadOnly =
            (originalAttributes & FileAttributes.ReadOnly) != 0;

        if (clearedReadOnly)
        {
            File.SetAttributes(
                originalPath,
                originalAttributes & ~FileAttributes.ReadOnly);
        }

        try
        {
            try
            {
                File.Replace(temporaryPath, originalPath, null);
            }
            catch (PlatformNotSupportedException)
            {
                ReplaceWithRollback(temporaryPath, originalPath);
            }
            catch (IOException)
            {
                ReplaceWithRollback(temporaryPath, originalPath);
            }
        }
        finally
        {
            if (File.Exists(originalPath))
            {
                try
                {
                    File.SetAttributes(originalPath, originalAttributes);
                }
                catch
                {
                    // The transformed file is valid; attribute restoration is best effort.
                }
            }
        }
    }

    private static void ReplaceWithRollback(
        string temporaryPath,
        string originalPath)
    {
        string backupPath =
            originalPath + ".flip-backup-" + Guid.NewGuid().ToString("N");

        File.Move(originalPath, backupPath);

        try
        {
            File.Move(temporaryPath, originalPath);
        }
        catch
        {
            try
            {
                if (File.Exists(originalPath))
                {
                    File.Delete(originalPath);
                }
            }
            catch
            {
            }

            File.Move(backupPath, originalPath);
            throw;
        }

        try
        {
            File.Delete(backupPath);
        }
        catch
        {
            // Do not roll back a valid transform because backup cleanup failed.
        }
    }

    private static void DeleteIfPresent(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch
        {
        }
    }

    private static List<string> GetSelectedExplorerFiles()
    {
        List<string> result = new List<string>();
        object shellObject = null;
        object windowsObject = null;

        try
        {
            Type shellType = Type.GetTypeFromProgID("Shell.Application");
            if (shellType == null)
            {
                return result;
            }

            shellObject = Activator.CreateInstance(shellType);
            dynamic shell = shellObject;
            dynamic windows = shell.Windows();
            windowsObject = windows;

            IntPtr foregroundWindow = GetForegroundWindow();

            for (int index = 0; index < windows.Count; index++)
            {
                object windowObject = null;
                object documentObject = null;
                object selectedObject = null;

                try
                {
                    dynamic window = windows.Item(index);
                    windowObject = window;

                    if (window == null)
                    {
                        continue;
                    }

                    IntPtr explorerWindow =
                        new IntPtr(Convert.ToInt64(window.HWND));

                    if (explorerWindow != foregroundWindow)
                    {
                        continue;
                    }

                    dynamic document = window.Document;
                    documentObject = document;

                    dynamic selectedItems = document.SelectedItems();
                    selectedObject = selectedItems;

                    for (int selectedIndex = 0;
                        selectedIndex < selectedItems.Count;
                        selectedIndex++)
                    {
                        dynamic selectedItem =
                            selectedItems.Item(selectedIndex);

                        try
                        {
                            result.Add((string)selectedItem.Path);
                        }
                        finally
                        {
                            ReleaseComObject(selectedItem);
                        }
                    }

                    break;
                }
                catch
                {
                    continue;
                }
                finally
                {
                    ReleaseComObject(selectedObject);
                    ReleaseComObject(documentObject);
                    ReleaseComObject(windowObject);
                }
            }
        }
        catch
        {
        }
        finally
        {
            ReleaseComObject(windowsObject);
            ReleaseComObject(shellObject);
        }

        return result;
    }

    private static void ReleaseComObject(object value)
    {
        if (value == null)
        {
            return;
        }

        try
        {
            if (Marshal.IsComObject(value))
            {
                Marshal.FinalReleaseComObject(value);
            }
        }
        catch
        {
        }
    }

    private static bool IsDuplicateShellInvocation(
        FlipDirection direction,
        IList<string> files)
    {
        bool lockTaken = false;

        using (Mutex mutex = new Mutex(
            false,
            @"Local\ExplorerImageFlip.InvocationGuard"))
        {
            try
            {
                try
                {
                    lockTaken = mutex.WaitOne(TimeSpan.FromSeconds(5));
                }
                catch (AbandonedMutexException)
                {
                    lockTaken = true;
                }

                if (!lockTaken)
                {
                    return true;
                }

                string signature = BuildInvocationSignature(direction, files);
                string statePath = Path.Combine(
                    Path.GetTempPath(),
                    "ExplorerImageFlip-last-invocation.txt");

                DateTime now = DateTime.UtcNow;

                try
                {
                    if (File.Exists(statePath))
                    {
                        string state = File.ReadAllText(statePath, Encoding.ASCII);
                        int separator = state.IndexOf('|');

                        if (separator > 0)
                        {
                            long ticks;
                            string ticksText = state.Substring(0, separator);
                            string previousSignature =
                                state.Substring(separator + 1);

                            if (long.TryParse(ticksText, out ticks)
                                && string.Equals(
                                    signature,
                                    previousSignature,
                                    StringComparison.Ordinal)
                                && now.Ticks >= ticks
                                && now.Ticks - ticks
                                    <= TimeSpan.FromMilliseconds(
                                        DuplicateWindowMilliseconds).Ticks)
                            {
                                return true;
                            }
                        }
                    }

                    File.WriteAllText(
                        statePath,
                        now.Ticks.ToString() + "|" + signature,
                        Encoding.ASCII);
                }
                catch
                {
                    // A failed guard file must not block the requested transform.
                }

                return false;
            }
            finally
            {
                if (lockTaken)
                {
                    mutex.ReleaseMutex();
                }
            }
        }
    }

    private static string BuildInvocationSignature(
        FlipDirection direction,
        IList<string> files)
    {
        List<string> sortedFiles = new List<string>(files);
        sortedFiles.Sort(StringComparer.OrdinalIgnoreCase);

        StringBuilder input = new StringBuilder();
        input.Append(direction.ToString());

        foreach (string file in sortedFiles)
        {
            input.Append('\0');
            input.Append(file.ToUpperInvariant());
        }

        using (SHA256 sha256 = SHA256.Create())
        {
            byte[] digest = sha256.ComputeHash(
                Encoding.UTF8.GetBytes(input.ToString()));

            StringBuilder output = new StringBuilder(digest.Length * 2);
            foreach (byte value in digest)
            {
                output.Append(value.ToString("x2"));
            }

            return output.ToString();
        }
    }

    private static void NotifyExplorer(string path)
    {
        IntPtr pathPointer = IntPtr.Zero;

        try
        {
            pathPointer = Marshal.StringToHGlobalUni(path);
            SHChangeNotify(
                SHCNE_UPDATEITEM,
                SHCNF_PATHW,
                pathPointer,
                IntPtr.Zero);
        }
        catch
        {
        }
        finally
        {
            if (pathPointer != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(pathPointer);
            }
        }
    }

    private static string BuildFailureMessage(
        int requestedCount,
        IList<TransformFailure> failures,
        string logPath)
    {
        StringBuilder message = new StringBuilder();

        message.Append("Could not flip ");
        message.Append(failures.Count);
        message.Append(" of ");
        message.Append(requestedCount);
        message.Append(" selected image");
        message.Append(requestedCount == 1 ? "." : "s.");
        message.AppendLine();
        message.AppendLine();

        int shown = Math.Min(failures.Count, 8);
        for (int index = 0; index < shown; index++)
        {
            TransformFailure failure = failures[index];
            message.Append(Path.GetFileName(failure.Path));
            message.Append(": ");
            message.AppendLine(failure.Exception.Message);
        }

        if (failures.Count > shown)
        {
            message.AppendLine();
            message.Append("Plus ");
            message.Append(failures.Count - shown);
            message.AppendLine(" more.");
        }

        message.Append(LogLocationSuffix(logPath));
        return message.ToString();
    }

    private static string WriteFailureLog(
        FlipDirection direction,
        IEnumerable<TransformFailure> failures)
    {
        string logPath = GetLogPath();

        try
        {
            StringBuilder entry = new StringBuilder();
            entry.AppendLine();
            entry.AppendLine("[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "]");
            entry.AppendLine("Direction: " + direction.ToString());

            foreach (TransformFailure failure in failures)
            {
                entry.AppendLine("File: " + failure.Path);
                entry.AppendLine(failure.Exception.ToString());
            }

            File.AppendAllText(logPath, entry.ToString(), Encoding.UTF8);
            return logPath;
        }
        catch
        {
            return null;
        }
    }

    private static string WriteFatalLog(Exception exception)
    {
        string logPath = GetLogPath();

        try
        {
            StringBuilder entry = new StringBuilder();
            entry.AppendLine();
            entry.AppendLine("[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "]");
            entry.AppendLine("Fatal error");
            entry.AppendLine(exception.ToString());

            File.AppendAllText(logPath, entry.ToString(), Encoding.UTF8);
            return logPath;
        }
        catch
        {
            return null;
        }
    }

    private static string GetLogPath()
    {
        string executablePath = Assembly.GetExecutingAssembly().Location;
        string directory = Path.GetDirectoryName(executablePath);

        if (string.IsNullOrEmpty(directory))
        {
            directory = Path.GetTempPath();
        }

        Directory.CreateDirectory(directory);
        return Path.Combine(directory, "ExplorerImageFlip.log");
    }

    private static string LogLocationSuffix(string logPath)
    {
        if (string.IsNullOrEmpty(logPath))
        {
            return string.Empty;
        }

        return Environment.NewLine
            + Environment.NewLine
            + "Full details were written to:"
            + Environment.NewLine
            + logPath;
    }

    private static void ShowError(string message)
    {
        try
        {
            MessageBoxW(
                IntPtr.Zero,
                message,
                "Flip image",
                MB_OK | MB_ICONERROR);
        }
        catch
        {
        }
    }
}

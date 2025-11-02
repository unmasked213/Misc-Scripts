param (
[string]$partialWindowTitle
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinAPI {
[DllImport("user32.dll", SetLastError = true)]
public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
[DllImport("user32.dll", SetLastError = true)]
public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
[DllImport("user32.dll", SetLastError = true)]
[return: MarshalAs(UnmanagedType.Bool)]
public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern int GetWindowTextLength(IntPtr hWnd);
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
[DllImport("user32.dll", SetLastError = true)]
public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

public static bool EnumTheWindows(IntPtr hWnd, IntPtr lParam) {
    int size = GetWindowTextLength(hWnd);
    if(size++ > 0 && IsWindowVisible(hWnd)) {
        StringBuilder sb = new StringBuilder(size);
        GetWindowText(hWnd, sb, size);
        if(sb.ToString().Contains((string)GCHandle.FromIntPtr(lParam).Target)) {
            ShowWindow(hWnd, 6); // Minimize the window
            return false; // Stop enumerating
        }
    }
    return true; // Continue enumerating
}
}
"@

$gch = [GCHandle]::Alloc($partialWindowTitle)
try {
[WinAPI]::EnumWindows([WinAPI+EnumWindowsProc]@{ Invoke = [WinAPI]::EnumTheWindows }, [GCHandle]::ToIntPtr($gch))
} finally {
$gch.Free()
}
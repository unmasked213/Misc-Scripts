// rotate-display.cs
// Readable source for the base64-encoded C# in rotate-display.bat.
// This file is NOT executed directly - it exists for auditability.
// The .bat embeds this as base64 so PowerShell can compile it at runtime
// without needing a separate .cs file or C# compiler in PATH.

using System;
using System.Runtime.InteropServices;

public class DR {
    // DEVMODE structure - matches the Win32 DEVMODEA layout
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    public struct DM {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dn;  // dmDeviceName
        public short sv;    // dmSpecVersion
        public short dv;    // dmDriverVersion
        public short sz;    // dmSize
        public short de;    // dmDriverExtra
        public int fl;      // dmFields
        public int px;      // dmPosition.x
        public int py;      // dmPosition.y
        public int orient;  // dmDisplayOrientation (0=landscape, 1=portrait, 2=landscape flipped, 3=portrait flipped)
        public int dfo;     // dmDisplayFixedOutput
        public short co;    // dmColor
        public short du;    // dmDuplex
        public short yr;    // dmYResolution
        public short tt;    // dmTTOption
        public short cl;    // dmCollate
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string fn;  // dmFormName
        public short lp;    // dmLogPixels
        public int bp;      // dmBitsPerPel
        public int pw;      // dmPelsWidth
        public int ph;      // dmPelsHeight
        public int df;      // dmDisplayFlags
        public int freq;    // dmDisplayFrequency
        public int im;      // dmICMMethod
        public int ii;      // dmICMIntent
        public int mt;      // dmMediaType
        public int dt;      // dmDitherType
        public int r1;      // dmReserved1
        public int r2;      // dmReserved2
        public int panw;    // dmPanningWidth
        public int panh;    // dmPanningHeight
    }

    [DllImport("user32.dll", CharSet = CharSet.Ansi)]
    public static extern int EnumDisplaySettings(string d, int m, ref DM dm);

    [DllImport("user32.dll", CharSet = CharSet.Ansi)]
    public static extern int ChangeDisplaySettingsEx(string d, ref DM dm, IntPtr h, int f, IntPtr l);

    public static void Toggle(int n) {
        string dev = "\\\\.\\DISPLAY" + n;
        DM dm = new DM();
        dm.sz = (short)Marshal.SizeOf(typeof(DM));

        // Read current display settings
        if (EnumDisplaySettings(dev, -1, ref dm) == 0) {
            Console.WriteLine("ERROR: Cannot read display " + n);
            return;
        }

        // Toggle: landscape (0) -> portrait flipped (3), or anything else -> landscape (0)
        int tgt = dm.orient == 0 ? 3 : 0;

        // Swap width/height if changing between landscape and portrait
        if ((dm.orient % 2) != (tgt % 2)) {
            int t = dm.pw;
            dm.pw = dm.ph;
            dm.ph = t;
        }

        dm.orient = tgt;
        // dmFields flags: DM_DISPLAYORIENTATION | DM_PELSWIDTH | DM_PELSHEIGHT
        dm.fl = 0x80 | 0x80000 | 0x100000;

        // Apply with CDS_TEST=0 would test; CDS_UPDATEREGISTRY=1 persists the change
        int r = ChangeDisplaySettingsEx(dev, ref dm, IntPtr.Zero, 1, IntPtr.Zero);
        Console.WriteLine(r == 0 ? (tgt == 0 ? "Landscape" : "Portrait") : "ERROR: " + r);
    }
}

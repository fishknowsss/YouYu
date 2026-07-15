using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class Program
{
    private const int GWL_STYLE = -16;
    private const int GWL_EXSTYLE = -20;
    private const long WS_CHILD = 0x40000000L;
    private const long WS_CAPTION = 0x00C00000L;
    private const long WS_EX_TRANSPARENT = 0x00000020L;
    private const long WS_EX_TOOLWINDOW = 0x00000080L;
    private const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    private const int DWMWA_CLOAKED = 14;
    private const uint MONITOR_DEFAULTTONEAREST = 2;
    private const int BoundsTolerance = 3;
    private static readonly IntPtr DpiAwarenessContextPerMonitorAwareV2 = new IntPtr(-4);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    private struct MONITORINFO
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }

    private delegate bool EnumWindowsProc(IntPtr window, IntPtr data);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr data);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool IsZoomed(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr window, out RECT rect);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);

    [DllImport("user32.dll")]
    private static extern IntPtr GetShellWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr window, StringBuilder className, int maxCount);

    [DllImport("user32.dll")]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
    private static extern int GetWindowLong32(IntPtr window, int index);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    private static extern IntPtr GetWindowLongPtr64(IntPtr window, int index);

    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")]
    private static extern int DwmGetWindowAttributeRect(IntPtr window, int attribute, out RECT value, int size);

    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")]
    private static extern int DwmGetWindowAttributeInt(IntPtr window, int attribute, out int value, int size);

    private static int Main(string[] args)
    {
        long petWindowValue;
        int parentProcessId;
        int pollIntervalMs;
        int maxSamples = 0;
        if (args.Length < 3
            || !long.TryParse(args[0], out petWindowValue)
            || petWindowValue < 0
            || !int.TryParse(args[1], out parentProcessId)
            || parentProcessId <= 0
            || !int.TryParse(args[2], out pollIntervalMs)
            || pollIntervalMs < 250
            || (args.Length >= 4 && (!int.TryParse(args[3], out maxSamples) || maxSamples <= 0)))
        {
            return 2;
        }

        TryEnablePerMonitorDpiAwareness();
        IntPtr petWindow = new IntPtr(petWindowValue);
        Process parentProcess;
        try
        {
            parentProcess = Process.GetProcessById(parentProcessId);
        }
        catch (ArgumentException)
        {
            return 0;
        }

        using (parentProcess)
        {
            int sampleCount = 0;
            while (IsProcessAlive(parentProcess))
            {
                Console.WriteLine(IsFullscreenOnPetMonitor(petWindow) ? "1" : "0");
                Console.Out.Flush();
                sampleCount += 1;
                if (maxSamples > 0 && sampleCount >= maxSamples) break;
                Thread.Sleep(pollIntervalMs);
            }
        }
        return 0;
    }

    private static void TryEnablePerMonitorDpiAwareness()
    {
        try
        {
            SetThreadDpiAwarenessContext(DpiAwarenessContextPerMonitorAwareV2);
        }
        catch (EntryPointNotFoundException)
        {
            // Older Windows versions continue with their process coordinate space.
        }
    }

    private static bool IsProcessAlive(Process process)
    {
        try
        {
            return !process.HasExited;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
    }

    private static long GetWindowLongValue(IntPtr window, int index)
    {
        return Environment.Is64BitProcess
            ? GetWindowLongPtr64(window, index).ToInt64()
            : GetWindowLong32(window, index);
    }

    private static bool IsShellClass(IntPtr window)
    {
        StringBuilder className = new StringBuilder(256);
        if (GetClassName(window, className, className.Capacity) <= 0) return false;
        string value = className.ToString();
        return value.Equals("Progman", StringComparison.OrdinalIgnoreCase)
            || value.Equals("WorkerW", StringComparison.OrdinalIgnoreCase)
            || value.Equals("Shell_TrayWnd", StringComparison.OrdinalIgnoreCase)
            || value.Equals("Shell_SecondaryTrayWnd", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsCloaked(IntPtr window)
    {
        int cloaked;
        return DwmGetWindowAttributeInt(window, DWMWA_CLOAKED, out cloaked, sizeof(int)) == 0 && cloaked != 0;
    }

    private static bool TryGetVisibleBounds(IntPtr window, out RECT bounds)
    {
        if (DwmGetWindowAttributeRect(window, DWMWA_EXTENDED_FRAME_BOUNDS, out bounds, Marshal.SizeOf(typeof(RECT))) == 0)
        {
            return bounds.Right > bounds.Left && bounds.Bottom > bounds.Top;
        }

        return GetWindowRect(window, out bounds) && bounds.Right > bounds.Left && bounds.Bottom > bounds.Top;
    }

    private static bool MatchesMonitorBounds(RECT windowBounds, RECT monitorBounds)
    {
        return Math.Abs(windowBounds.Left - monitorBounds.Left) <= BoundsTolerance
            && Math.Abs(windowBounds.Top - monitorBounds.Top) <= BoundsTolerance
            && Math.Abs(windowBounds.Right - monitorBounds.Right) <= BoundsTolerance
            && Math.Abs(windowBounds.Bottom - monitorBounds.Bottom) <= BoundsTolerance;
    }

    private static bool IsFullscreenOnPetMonitor(IntPtr petWindow)
    {
        if (petWindow == IntPtr.Zero) return false;
        IntPtr petMonitor = MonitorFromWindow(petWindow, MONITOR_DEFAULTTONEAREST);
        if (petMonitor == IntPtr.Zero) return false;

        bool detected = false;
        bool candidateFound = false;
        IntPtr shellWindow = GetShellWindow();
        EnumWindows(delegate(IntPtr candidate, IntPtr ignored)
        {
            if (candidate == petWindow
                || candidate == shellWindow
                || !IsWindowVisible(candidate)
                || IsIconic(candidate)
                || IsCloaked(candidate)
                || IsShellClass(candidate))
            {
                return true;
            }

            long style = GetWindowLongValue(candidate, GWL_STYLE);
            long extendedStyle = GetWindowLongValue(candidate, GWL_EXSTYLE);
            if ((style & WS_CHILD) != 0
                || (extendedStyle & WS_EX_TOOLWINDOW) != 0
                || (extendedStyle & WS_EX_TRANSPARENT) != 0)
            {
                return true;
            }

            IntPtr candidateMonitor = MonitorFromWindow(candidate, 0);
            if (candidateMonitor == IntPtr.Zero || candidateMonitor != petMonitor) return true;

            candidateFound = true;
            MONITORINFO monitorInfo = new MONITORINFO();
            monitorInfo.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
            RECT windowBounds;
            if (!GetMonitorInfo(candidateMonitor, ref monitorInfo) || !TryGetVisibleBounds(candidate, out windowBounds))
            {
                return false;
            }

            bool isSystemMaximized = IsZoomed(candidate) && (style & WS_CAPTION) != 0;
            detected = !isSystemMaximized && MatchesMonitorBounds(windowBounds, monitorInfo.rcMonitor);
            return false;
        }, IntPtr.Zero);

        return candidateFound && detected;
    }
}

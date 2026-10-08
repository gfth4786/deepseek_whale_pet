<#
.SYNOPSIS
  Read-only snapshot of what the user is doing, for the whale-pet DSH plugin.

.DESCRIPTION
  Reads one JSON object from stdin (any content is ignored) and writes exactly one
  JSON envelope to stdout:

    {}
      -> {"ok":true,"value":{
            "activeWindowTitle":"Program Manager","activeProcessName":"explorer",
            "cursorX":960,"cursorY":540,"screenWidth":2560,"screenHeight":1440,
            "volume":42,"muted":false,"idleSeconds":7,
            "time":"2026-10-08T00:31:02.1234567+08:00"}}

  Nothing is ever changed: the script only reads the foreground window, the
  pointer, the screen metrics, the last input time and the default audio endpoint.
  Any individual reading that is unavailable becomes null instead of failing the
  whole call.

  The script never throws: every failure becomes {"ok":false,...}, and the exit
  code stays 0 in both cases.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Read-PetInput {
    <#
    .SYNOPSIS
      Read all of stdin as raw bytes and decode it as UTF-8 JSON.

    .DESCRIPTION
      [Console]::In decodes through the console input code page, which turns
      non-ASCII into '?' under Windows PowerShell 5.1. Reading the standard input
      stream directly keeps non-ASCII intact under both Windows PowerShell 5.1 and
      PowerShell 7. Empty input becomes an empty object.
    #>
    $stream = [Console]::OpenStandardInput()
    $buffer = New-Object System.IO.MemoryStream
    try {
        $stream.CopyTo($buffer)
    } finally {
        $buffer.Dispose()
    }
    $text = [System.Text.Encoding]::UTF8.GetString($buffer.ToArray())
    if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
    if ([string]::IsNullOrWhiteSpace($text)) { return [pscustomobject]@{} }
    return ($text | ConvertFrom-Json)
}

function Write-PetEnvelope {
    <#
    .SYNOPSIS
      Emit the single allowed stdout line.

    .DESCRIPTION
      Only the last dictionary carrying an `ok` key is serialized, so a stray
      value that escaped into the pipeline can never turn stdout into two lines or
      an array.
    #>
    param($Envelope)
    $selected = $null
    foreach ($item in @($Envelope)) {
        if ($item -is [System.Collections.IDictionary] -and $item.Contains('ok')) { $selected = $item }
    }
    if ($null -eq $selected) {
        $selected = @{ ok = $false; error = 'the helper produced no envelope'; code = 'INTERNAL' }
    }
    Write-Output (ConvertTo-Json -InputObject $selected -Compress -Depth 12)
}

# --------------------------------------------------------------- interop ----
$script:ContextSource = @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace WhalePetContext
{
    public static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        public struct POINT
        {
            public int X;
            public int Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct LASTINPUTINFO
        {
            public uint cbSize;
            public uint dwTime;
        }

        private const int SM_CXSCREEN = 0;
        private const int SM_CYSCREEN = 1;

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool GetCursorPos(out POINT lpPoint);

        [DllImport("user32.dll")]
        private static extern int GetSystemMetrics(int nIndex);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

        /// <summary>Title of the foreground window, or null when there is none.</summary>
        public static string ForegroundTitle()
        {
            try
            {
                IntPtr hwnd = GetForegroundWindow();
                if (hwnd == IntPtr.Zero) { return null; }
                StringBuilder buffer = new StringBuilder(1024);
                int copied = GetWindowText(hwnd, buffer, buffer.Capacity);
                if (copied <= 0) { return null; }
                string title = buffer.ToString();
                return title.Length == 0 ? null : title;
            }
            catch
            {
                return null;
            }
        }

        /// <summary>Process name owning the foreground window, or null.</summary>
        public static string ForegroundProcessName()
        {
            try
            {
                IntPtr hwnd = GetForegroundWindow();
                if (hwnd == IntPtr.Zero) { return null; }
                uint pid;
                GetWindowThreadProcessId(hwnd, out pid);
                if (pid == 0) { return null; }
                using (Process process = Process.GetProcessById((int)pid))
                {
                    return process.ProcessName;
                }
            }
            catch
            {
                return null;
            }
        }

        public static bool TryGetCursor(out int x, out int y)
        {
            x = 0;
            y = 0;
            try
            {
                POINT point;
                if (!GetCursorPos(out point)) { return false; }
                x = point.X;
                y = point.Y;
                return true;
            }
            catch
            {
                return false;
            }
        }

        public static int ScreenWidth() { return GetSystemMetrics(SM_CXSCREEN); }

        public static int ScreenHeight() { return GetSystemMetrics(SM_CYSCREEN); }

        /// <summary>Seconds since the last keyboard or mouse input, or -1.</summary>
        public static int IdleSeconds()
        {
            try
            {
                LASTINPUTINFO info = new LASTINPUTINFO();
                info.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
                if (!GetLastInputInfo(ref info)) { return -1; }
                // Unsigned subtraction keeps the result correct across the 49-day
                // tick counter wrap that Environment.TickCount exposes as negative.
                uint now = unchecked((uint)Environment.TickCount);
                uint idle = unchecked(now - info.dwTime) / 1000u;
                return (int)idle;
            }
            catch
            {
                return -1;
            }
        }
    }

    public static class CoreAudioReader
    {
        [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
        public class MMDeviceEnumerator
        {
        }

        [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        public interface IMMDeviceEnumerator
        {
            int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
            int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
            int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
            int RegisterEndpointNotificationCallback(IntPtr client);
            int UnregisterEndpointNotificationCallback(IntPtr client);
        }

        [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        public interface IMMDevice
        {
            int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams,
                         [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
            int OpenPropertyStore(int stgmAccess, out IntPtr properties);
            int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
            int GetState(out int state);
        }

        [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        public interface IAudioEndpointVolume
        {
            int RegisterControlChangeNotify(IntPtr pNotify);
            int UnregisterControlChangeNotify(IntPtr pNotify);
            int GetChannelCount(out uint pnChannelCount);
            int SetMasterVolumeLevel(float fLevelDB, IntPtr pguidEventContext);
            int SetMasterVolumeLevelScalar(float fLevel, IntPtr pguidEventContext);
            int GetMasterVolumeLevel(out float pfLevelDB);
            int GetMasterVolumeLevelScalar(out float pfLevel);
            int SetChannelVolumeLevel(uint nChannel, float fLevelDB, IntPtr pguidEventContext);
            int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, IntPtr pguidEventContext);
            int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
            int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
            int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, IntPtr pguidEventContext);
            int GetMute([MarshalAs(UnmanagedType.Bool)] out bool pbMute);
            int GetVolumeStepInfo(out uint pnStep, out uint pnStepCount);
            int VolumeStepUp(IntPtr pguidEventContext);
            int VolumeStepDown(IntPtr pguidEventContext);
            int QueryHardwareSupport(out uint pdwHardwareSupportMask);
            int GetVolumeRange(out float pflVolumeMindB, out float pflVolumeMaxdB, out float pflVolumeIncrementdB);
        }

        private static IAudioEndpointVolume Open()
        {
            IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
            IMMDevice device;
            int hr = enumerator.GetDefaultAudioEndpoint(0, 1, out device);
            if (hr != 0) { Marshal.ThrowExceptionForHR(hr); }
            Guid iid = typeof(IAudioEndpointVolume).GUID;
            object volume;
            hr = device.Activate(ref iid, 23, IntPtr.Zero, out volume);
            if (hr != 0) { Marshal.ThrowExceptionForHR(hr); }
            return (IAudioEndpointVolume)volume;
        }

        public static bool TryGetVolume(out int percent)
        {
            percent = 0;
            try
            {
                float scalar;
                if (Open().GetMasterVolumeLevelScalar(out scalar) != 0) { return false; }
                percent = (int)Math.Round(scalar * 100.0f);
                if (percent < 0) { percent = 0; }
                if (percent > 100) { percent = 100; }
                return true;
            }
            catch
            {
                return false;
            }
        }

        public static bool TryGetMute(out bool muted)
        {
            muted = false;
            try
            {
                bool value;
                if (Open().GetMute(out value) != 0) { return false; }
                muted = value;
                return true;
            }
            catch
            {
                return false;
            }
        }
    }
}
'@

function Initialize-Context {
    <#
    .SYNOPSIS
      Compile the read-only Win32 / Core Audio interop once per process.
    #>
    if ($script:ContextReady) { return $true }
    try {
        Add-Type -TypeDefinition $script:ContextSource -Language CSharp -ErrorAction Stop
        $script:ContextReady = $true
        return $true
    } catch {
        $script:ContextError = $_.Exception.Message
        return $false
    }
}

function Get-PetSnapshot {
    <#
    .SYNOPSIS
      Assemble the snapshot; unreadable fields stay null.
    #>
    if (-not (Initialize-Context)) {
        return @{ ok = $false; error = "cannot load the Win32 interop: $($script:ContextError)"; code = 'INTEROP_FAILED' }
    }

    $cursorX = $null
    $cursorY = $null
    $x = 0
    $y = 0
    if ([WhalePetContext.Native]::TryGetCursor([ref]$x, [ref]$y)) {
        $cursorX = [int]$x
        $cursorY = [int]$y
    }

    $screenWidth = $null
    $screenHeight = $null
    try { $screenWidth = [int][WhalePetContext.Native]::ScreenWidth() } catch { $screenWidth = $null }
    try { $screenHeight = [int][WhalePetContext.Native]::ScreenHeight() } catch { $screenHeight = $null }

    $idleSeconds = $null
    try {
        $idle = [int][WhalePetContext.Native]::IdleSeconds()
        if ($idle -ge 0) { $idleSeconds = $idle }
    } catch {
        $idleSeconds = $null
    }

    $volume = $null
    $probeVolume = 0
    if ([WhalePetContext.CoreAudioReader]::TryGetVolume([ref]$probeVolume)) { $volume = [int]$probeVolume }

    $muted = $null
    $probeMuted = $false
    if ([WhalePetContext.CoreAudioReader]::TryGetMute([ref]$probeMuted)) { $muted = [bool]$probeMuted }

    $time = ''
    try { $time = (Get-Date).ToString('o') } catch { $time = '' }

    return @{
        ok    = $true
        value = @{
            activeWindowTitle = [WhalePetContext.Native]::ForegroundTitle()
            activeProcessName = [WhalePetContext.Native]::ForegroundProcessName()
            cursorX           = $cursorX
            cursorY           = $cursorY
            screenWidth       = $screenWidth
            screenHeight      = $screenHeight
            volume            = $volume
            muted             = $muted
            idleSeconds       = $idleSeconds
            time              = $time
        }
    }
}

# ------------------------------------------------------------------ main ----
try {
    $null = Read-PetInput
    $envelope = Get-PetSnapshot
} catch {
    $envelope = @{ ok = $false; error = $_.Exception.Message; code = 'CONTEXT_FAILED' }
}
Write-PetEnvelope $envelope
exit 0

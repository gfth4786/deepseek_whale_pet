<#
.SYNOPSIS
  System volume and media transport for the whale-pet DSH plugin.

.DESCRIPTION
  Reads one JSON object from stdin and writes exactly one JSON envelope to stdout:

    {"action":"volume-up","steps":1}
      -> {"ok":true,"value":{"action":"volume-up","volume":42,"muted":false,"via":"core-audio"}}

  Volume and mute are performed and read back through the Core Audio API
  (IAudioEndpointVolume). Transport actions (play/pause, next, previous, stop) and
  every fallback use the virtual media keys. Every action reads the real state
  back before answering, so the caller always learns the resulting volume and mute
  flag; when read-back is unavailable those fields are null instead of failing the
  call.

  Supported actions:
    volume-up | volume-down | mute | unmute | toggle-mute | set-volume |
    play-pause | next | previous | stop

  Input flags:
    level   0-100, required by set-volume
    steps   1-50, default 2, used by volume-up / volume-down
    dryRun  true = report what would happen, touch nothing
    via     "auto" (default) | "core-audio" | "media-keys"

  `via` is an additive extension, not part of the plugin contract: it lets the
  caller (and the self-test) force the media-key fallback instead of the Core
  Audio path.

  The script never throws: every failure becomes {"ok":false,...}, and the exit
  code stays 0 in both cases.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# 2% per step, matching the Windows volume-key increment.
$script:VolumeStepPercent = 2

# Virtual-key codes for the media keys.
$script:MediaKeyCodes = @{
    'mute'        = 0xAD
    'volume-down' = 0xAE
    'volume-up'   = 0xAF
    'next'        = 0xB0
    'previous'    = 0xB1
    'stop'        = 0xB2
    'play-pause'  = 0xB3
}

function Read-PetInput {
    <#
    .SYNOPSIS
      Read all of stdin as raw bytes and decode it as UTF-8 JSON.

    .DESCRIPTION
      [Console]::In decodes through the console input code page, which turns
      non-ASCII into '?' under Windows PowerShell 5.1. Reading the standard input
      stream directly keeps non-ASCII (for example Chinese text) intact under both
      Windows PowerShell 5.1 and PowerShell 7. Empty input becomes an empty object.
    #>
    $stream = [Console]::OpenStandardInput()
    $buffer = New-Object System.IO.MemoryStream
    try {
        $stream.CopyTo($buffer)
    } finally {
        $buffer.Dispose()
    }
    $text = [System.Text.Encoding]::UTF8.GetString($buffer.ToArray())
    # A caller may hand us a BOM-prefixed UTF-8 payload.
    if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
    if ([string]::IsNullOrWhiteSpace($text)) { return [pscustomobject]@{} }
    return ($text | ConvertFrom-Json)
}

function Get-PetProp {
    <#
    .SYNOPSIS
      Read one property from the parsed request without throwing on absence.
    #>
    param($Object, [string]$Name, $Default = $null)
    if ($null -eq $Object) { return $Default }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $Default }
    if ($null -eq $property.Value) { return $Default }
    return $property.Value
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
$script:CoreAudioSource = @'
using System;
using System.Runtime.InteropServices;

namespace WhalePetMedia
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

    public static class CoreAudio
    {
        private const int E_RENDER = 0;
        private const int E_MULTIMEDIA = 1;
        private const int CLSCTX_ALL = 23;

        private static IAudioEndpointVolume Open()
        {
            IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
            IMMDevice device;
            int hr = enumerator.GetDefaultAudioEndpoint(E_RENDER, E_MULTIMEDIA, out device);
            if (hr != 0) { Marshal.ThrowExceptionForHR(hr); }
            Guid iid = typeof(IAudioEndpointVolume).GUID;
            object volume;
            hr = device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out volume);
            if (hr != 0) { Marshal.ThrowExceptionForHR(hr); }
            return (IAudioEndpointVolume)volume;
        }

        public static bool TryGetVolume(out int percent)
        {
            percent = 0;
            try
            {
                IAudioEndpointVolume volume = Open();
                float scalar;
                if (volume.GetMasterVolumeLevelScalar(out scalar) != 0) { return false; }
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
                IAudioEndpointVolume volume = Open();
                bool value;
                if (volume.GetMute(out value) != 0) { return false; }
                muted = value;
                return true;
            }
            catch
            {
                return false;
            }
        }

        public static bool TrySetVolume(int percent)
        {
            try
            {
                IAudioEndpointVolume volume = Open();
                if (percent < 0) { percent = 0; }
                if (percent > 100) { percent = 100; }
                return volume.SetMasterVolumeLevelScalar(percent / 100.0f, IntPtr.Zero) == 0;
            }
            catch
            {
                return false;
            }
        }

        public static bool TrySetMute(bool muted)
        {
            try
            {
                IAudioEndpointVolume volume = Open();
                return volume.SetMute(muted, IntPtr.Zero) == 0;
            }
            catch
            {
                return false;
            }
        }
    }

    public static class MediaKeys
    {
        [DllImport("user32.dll")]
        private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, IntPtr dwExtraInfo);

        public static void Tap(byte virtualKey)
        {
            keybd_event(virtualKey, 0, 0, IntPtr.Zero);
            System.Threading.Thread.Sleep(20);
            keybd_event(virtualKey, 0, 2, IntPtr.Zero);
        }
    }
}
'@

function Initialize-CoreAudio {
    <#
    .SYNOPSIS
      Compile the Core Audio / keybd_event interop once per process.
    #>
    if ($script:CoreAudioReady) { return $true }
    try {
        Add-Type -TypeDefinition $script:CoreAudioSource -Language CSharp -ErrorAction Stop
        $script:CoreAudioReady = $true
        return $true
    } catch {
        $script:CoreAudioError = $_.Exception.Message
        return $false
    }
}

function Get-VolumeState {
    <#
    .SYNOPSIS
      Read back (volume, muted) through Core Audio; nulls when unavailable.
    #>
    $state = @{ volume = $null; muted = $null; available = $false }
    if (-not (Initialize-CoreAudio)) { return $state }
    $volume = 0
    if ([WhalePetMedia.CoreAudio]::TryGetVolume([ref]$volume)) {
        $state.volume = [int]$volume
        $state.available = $true
    }
    $muted = $false
    if ([WhalePetMedia.CoreAudio]::TryGetMute([ref]$muted)) {
        $state.muted = [bool]$muted
        $state.available = $true
    }
    return $state
}

function Send-MediaKeyRaw {
    <#
    .SYNOPSIS
      Deliver one media key through a named mechanism.
    #>
    param([int]$VirtualKey, [string]$Mechanism)
    if ($Mechanism -eq 'sendkeys') {
        if (-not $script:FormsLoaded) {
            Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
            $script:FormsLoaded = $true
        }
        [System.Windows.Forms.SendKeys]::SendWait([string][char]$VirtualKey)
    } elseif (Initialize-CoreAudio) {
        [WhalePetMedia.MediaKeys]::Tap([byte]$VirtualKey)
    }
}

function Invoke-MediaKey {
    <#
    .SYNOPSIS
      Press one virtual media key and report which mechanism actually worked.

    .DESCRIPTION
      The plugin contract names [System.Windows.Forms.SendKeys]::SendWait([char]0xAD)
      as the media-key mechanism. Under .NET Framework 4.8 SendKeys transmits any
      character above 0x7F as a KEYEVENTF_UNICODE character, not as a virtual key,
      so SendWait('0xAE') returns cleanly and changes nothing (verified on this
      machine). SendKeys is therefore still tried first whenever the effect can be
      verified through Core Audio read-back, and the real virtual key is sent with
      SendInput when it did not take effect.

      Keys whose effect cannot be observed without hijacking the user's playback
      (play/pause, next, previous, stop) are pressed exactly once through SendInput
      so that a working SendKeys could never double-press them.
    #>
    param(
        [int]$VirtualKey,
        [int]$Presses = 1,
        $Before = $null,
        [scriptblock]$Verify = $null
    )

    if ($null -eq $Verify) {
        # Unverifiable transport key: one press, through the mechanism that works.
        for ($i = 0; $i -lt $Presses; $i++) { Send-MediaKeyRaw $VirtualKey 'sendinput' }
        return 'sendinput'
    }

    for ($i = 0; $i -lt $Presses; $i++) { Send-MediaKeyRaw $VirtualKey 'sendkeys' }
    Start-Sleep -Milliseconds 60
    if (& $Verify $Before) { return 'sendkeys' }

    for ($i = 0; $i -lt $Presses; $i++) { Send-MediaKeyRaw $VirtualKey 'sendinput' }
    return 'sendinput'
}

function Invoke-PetAction {
    <#
    .SYNOPSIS
      Validate and execute one media request; returns the envelope hashtable.
    #>
    param($Request)

    $action = [string](Get-PetProp $Request 'action' '')
    $dryRun = [bool](Get-PetProp $Request 'dryRun' $false)

    $known = @('volume-up', 'volume-down', 'mute', 'unmute', 'toggle-mute', 'set-volume',
        'play-pause', 'next', 'previous', 'stop')
    if ([string]::IsNullOrWhiteSpace($action)) {
        return @{ ok = $false; error = 'action is required'; code = 'BAD_INPUT' }
    }
    if ($known -notcontains $action) {
        return @{ ok = $false; error = "unknown action '$action'; expected one of $($known -join ', ')"; code = 'UNKNOWN_ACTION' }
    }

    $stepCount = 2
    $rawSteps = Get-PetProp $Request 'steps' $null
    if ($null -ne $rawSteps) {
        $parsedSteps = 0
        if (-not [int]::TryParse([string]$rawSteps, [ref]$parsedSteps)) {
            return @{ ok = $false; error = "steps must be an integer, got '$rawSteps'"; code = 'BAD_INPUT' }
        }
        if ($parsedSteps -lt 1 -or $parsedSteps -gt 50) {
            return @{ ok = $false; error = "steps must be between 1 and 50, got $parsedSteps"; code = 'BAD_INPUT' }
        }
        $stepCount = $parsedSteps
    }

    $level = 0
    if ($action -eq 'set-volume') {
        $rawLevel = Get-PetProp $Request 'level' $null
        if ($null -eq $rawLevel) {
            return @{ ok = $false; error = 'level is required for set-volume'; code = 'BAD_INPUT' }
        }
        if (-not [int]::TryParse([string]$rawLevel, [ref]$level)) {
            return @{ ok = $false; error = "level must be an integer, got '$rawLevel'"; code = 'BAD_INPUT' }
        }
        if ($level -lt 0 -or $level -gt 100) {
            return @{ ok = $false; error = "level must be between 0 and 100, got $level"; code = 'BAD_INPUT' }
        }
    }

    $coreAudio = Initialize-CoreAudio
    $forceVia = [string](Get-PetProp $Request 'via' 'auto')
    if ($forceVia -eq 'media-keys') { $coreAudio = $false }
    if ($forceVia -eq 'core-audio' -and -not $coreAudio) {
        return @{ ok = $false; error = 'via=core-audio was requested but the Core Audio API is unavailable'; code = 'CORE_AUDIO_UNAVAILABLE' }
    }
    $before = Get-VolumeState

    # ------------------------------------------------------------- dry run --
    if ($dryRun) {
        $would = $null
        switch ($action) {
            'volume-up' {
                $target = $null
                if ($null -ne $before.volume) { $target = [Math]::Min(100, $before.volume + ($script:VolumeStepPercent * $stepCount)) }
                $would = @{ kind = 'volume'; from = $before.volume; to = $target; steps = $stepCount }
            }
            'volume-down' {
                $target = $null
                if ($null -ne $before.volume) { $target = [Math]::Max(0, $before.volume - ($script:VolumeStepPercent * $stepCount)) }
                $would = @{ kind = 'volume'; from = $before.volume; to = $target; steps = $stepCount }
            }
            'set-volume' {
                $would = @{ kind = 'volume'; from = $before.volume; to = [int]$level }
            }
            'mute' {
                $would = @{ kind = 'mute'; from = $before.muted; to = $true }
            }
            'unmute' {
                $would = @{ kind = 'mute'; from = $before.muted; to = $false }
            }
            'toggle-mute' {
                $target = $null
                if ($null -ne $before.muted) { $target = -not $before.muted }
                $would = @{ kind = 'mute'; from = $before.muted; to = $target }
            }
            default {
                $would = @{ kind = 'media-key'; action = $action; virtualKey = $script:MediaKeyCodes[$action] }
            }
        }
        return @{
            ok    = $true
            value = @{
                action = $action
                volume = $before.volume
                muted  = $before.muted
                via    = $(if ($coreAudio) { 'core-audio' } else { 'media-keys' })
                dryRun = $true
                would  = $would
            }
        }
    }

    # -------------------------------------------------------- real action --
    $via = $(if ($coreAudio) { 'core-audio' } else { 'media-keys' })
    $mechanism = $null

    switch ($action) {
        'volume-up' {
            if ($coreAudio -and $null -ne $before.volume) {
                $target = [Math]::Min(100, $before.volume + ($script:VolumeStepPercent * $stepCount))
                if (-not [WhalePetMedia.CoreAudio]::TrySetVolume([int]$target)) {
                    # A driver that refuses an exact level still accepts key presses.
                    $via = 'media-keys'
                }
            } else {
                $via = 'media-keys'
            }
            if ($via -eq 'media-keys') {
                $mechanism = Invoke-MediaKey -VirtualKey $script:MediaKeyCodes['volume-up'] -Presses $stepCount `
                    -Before $before `
                    -Verify { param($Before) $now = Get-VolumeState; $null -ne $now.volume -and $now.volume -ne $Before.volume }
            }
        }
        'volume-down' {
            if ($coreAudio -and $null -ne $before.volume) {
                $target = [Math]::Max(0, $before.volume - ($script:VolumeStepPercent * $stepCount))
                if (-not [WhalePetMedia.CoreAudio]::TrySetVolume([int]$target)) {
                    $via = 'media-keys'
                }
            } else {
                $via = 'media-keys'
            }
            if ($via -eq 'media-keys') {
                $mechanism = Invoke-MediaKey -VirtualKey $script:MediaKeyCodes['volume-down'] -Presses $stepCount `
                    -Before $before `
                    -Verify { param($Before) $now = Get-VolumeState; $null -ne $now.volume -and $now.volume -ne $Before.volume }
            }
        }
        'set-volume' {
            if (-not $coreAudio) {
                return @{ ok = $false; error = 'set-volume needs the Core Audio API, which is unavailable on this machine'; code = 'CORE_AUDIO_UNAVAILABLE' }
            }
            if (-not [WhalePetMedia.CoreAudio]::TrySetVolume([int]$level)) {
                return @{ ok = $false; error = 'the Core Audio API refused to set the master volume'; code = 'CORE_AUDIO_FAILED' }
            }
        }
        'mute' {
            if ($coreAudio -and [WhalePetMedia.CoreAudio]::TrySetMute($true)) { }
            elseif ($null -eq $before.muted -or -not $before.muted) {
                $via = 'media-keys'
                $mechanism = Invoke-MediaKey -VirtualKey $script:MediaKeyCodes['mute'] -Before $before `
                    -Verify { param($Before) (Get-VolumeState).muted -eq $true }
            }
        }
        'unmute' {
            if ($coreAudio -and [WhalePetMedia.CoreAudio]::TrySetMute($false)) { }
            elseif ($null -eq $before.muted -or $before.muted) {
                $via = 'media-keys'
                $mechanism = Invoke-MediaKey -VirtualKey $script:MediaKeyCodes['mute'] -Before $before `
                    -Verify { param($Before) (Get-VolumeState).muted -eq $false }
            }
        }
        'toggle-mute' {
            if ($coreAudio -and $null -ne $before.muted -and [WhalePetMedia.CoreAudio]::TrySetMute((-not $before.muted))) { }
            else {
                $via = 'media-keys'
                $mechanism = Invoke-MediaKey -VirtualKey $script:MediaKeyCodes['mute'] -Before $before `
                    -Verify { param($Before) $now = Get-VolumeState; $null -ne $now.muted -and $now.muted -ne $Before.muted }
            }
        }
        default {
            $via = 'media-keys'
            $mechanism = Invoke-MediaKey -VirtualKey $script:MediaKeyCodes[$action]
        }
    }

    # Read the real state back; a failed read-back must not fail the call.
    $after = Get-VolumeState

    return @{
        ok    = $true
        value = @{
            action    = $action
            volume    = $after.volume
            muted     = $after.muted
            via       = $via
            mechanism = $mechanism
        }
    }
}

# ------------------------------------------------------------------ main ----
try {
    $request = Read-PetInput
    $envelope = Invoke-PetAction $request
} catch {
    $envelope = @{ ok = $false; error = $_.Exception.Message; code = 'MEDIA_FAILED' }
}
Write-PetEnvelope $envelope
exit 0

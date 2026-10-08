<#
.SYNOPSIS
  Keyboard and mouse automation for the whale-pet DSH plugin.

.DESCRIPTION
  Reads one JSON object from stdin and writes exactly one JSON envelope to stdout:

    {"action":"position"}
      -> {"ok":true,"value":{"action":"position","dryRun":false,"position":{"x":960,"y":540}}}

  Actions:
    type         {"text":"...","restoreClipboard":true}
                 ASCII text goes through SendKeys, anything non-ASCII goes
                 through the clipboard (Set-Clipboard + Ctrl+V); with
                 restoreClipboard (default true) the previous clipboard text is
                 put back afterwards.
    key          {"keys":"enter"}          one key
    hotkey       {"keys":"ctrl+shift+t"}   one chord
    move         {"x":int,"y":int}         move the pointer
    position     {}                        read-only, reports the pointer
    click | double-click | right-click     optional {"x":int,"y":int} to move first
    scroll       {"delta":int}             positive scrolls up

  Every action honours "dryRun": true, which reports the resolved coordinates and
  the intended action and touches nothing at all - no pointer movement, no
  clicks, no keystrokes, no clipboard change. Position reads are the only thing a
  dry run performs, because they are read-only.

  The script never throws: every failure becomes {"ok":false,...}, and the exit
  code stays 0 in both cases.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# SendKeys treats these characters as syntax; inside literal text they must be
# wrapped in braces to be typed as themselves.
$script:SendKeysLiteralMap = @{
    '+' = '{+}'; '^' = '{^}'; '%' = '{%}'; '~' = '{~}'
    '(' = '{(}'; ')' = '{)}'; '{' = '{{}'; '}' = '{}}'
    '[' = '{[}'; ']' = '{]}'
}

# Named keys translated into SendKeys notation.
$script:SendKeysNamedKeys = @{
    'enter' = '{ENTER}'; 'return' = '{ENTER}'; 'tab' = '{TAB}'
    'esc' = '{ESC}'; 'escape' = '{ESC}'; 'space' = ' '
    'up' = '{UP}'; 'down' = '{DOWN}'; 'left' = '{LEFT}'; 'right' = '{RIGHT}'
    'home' = '{HOME}'; 'end' = '{END}'
    'pageup' = '{PGUP}'; 'pagedown' = '{PGDN}'; 'pgup' = '{PGUP}'; 'pgdn' = '{PGDN}'
    'delete' = '{DEL}'; 'del' = '{DEL}'; 'backspace' = '{BS}'; 'insert' = '{INS}'
}
for ($i = 1; $i -le 12; $i++) { $script:SendKeysNamedKeys["f$i"] = "{F$i}" }

$script:ModifierKeys = @('ctrl', 'control', 'shift', 'alt', 'win', 'meta')

# VK_LWIN, used because SendKeys has no notation for the Windows key.
$script:VirtualKeyLWin = 0x5B

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
$script:InputSource = @'
using System;
using System.Runtime.InteropServices;

namespace WhalePetInput
{
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT
    {
        public int X;
        public int Y;
    }

    public static class Pointer
    {
        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool SetCursorPos(int X, int Y);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool GetCursorPos(out POINT lpPoint);

        [DllImport("user32.dll")]
        private static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, UIntPtr dwExtraInfo);

        [DllImport("user32.dll")]
        private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

        public const uint LEFTDOWN = 0x0002;
        public const uint LEFTUP = 0x0004;
        public const uint RIGHTDOWN = 0x0008;
        public const uint RIGHTUP = 0x0010;
        public const uint WHEEL = 0x0800;

        public static bool TryGetPosition(out int x, out int y)
        {
            POINT point;
            if (!GetCursorPos(out point)) { x = 0; y = 0; return false; }
            x = point.X;
            y = point.Y;
            return true;
        }

        public static bool TrySetPosition(int x, int y)
        {
            return SetCursorPos(x, y);
        }

        public static void Click(uint downFlag, uint upFlag)
        {
            mouse_event(downFlag, 0, 0, 0, UIntPtr.Zero);
            System.Threading.Thread.Sleep(20);
            mouse_event(upFlag, 0, 0, 0, UIntPtr.Zero);
        }

        public static void Scroll(int delta)
        {
            mouse_event(WHEEL, 0, 0, unchecked((uint)delta), UIntPtr.Zero);
        }

        public static void KeyDown(byte virtualKey)
        {
            keybd_event(virtualKey, 0, 0, UIntPtr.Zero);
        }

        public static void KeyUp(byte virtualKey)
        {
            keybd_event(virtualKey, 0, 2, UIntPtr.Zero);
        }
    }
}
'@

function Initialize-InputInterop {
    <#
    .SYNOPSIS
      Compile the Win32 pointer/keyboard interop once per process.
    #>
    if ($script:InputReady) { return $true }
    try {
        Add-Type -TypeDefinition $script:InputSource -Language CSharp -ErrorAction Stop
        $script:InputReady = $true
        return $true
    } catch {
        $script:InputError = $_.Exception.Message
        return $false
    }
}

function Get-CursorPosition {
    <#
    .SYNOPSIS
      Current pointer position, or null when the call fails.
    #>
    if (-not (Initialize-InputInterop)) { return $null }
    $x = 0
    $y = 0
    if ([WhalePetInput.Pointer]::TryGetPosition([ref]$x, [ref]$y)) {
        return @{ x = [int]$x; y = [int]$y }
    }
    return $null
}

function ConvertTo-SendKeysText {
    <#
    .SYNOPSIS
      Escape plain ASCII text so SendKeys types it literally.
    #>
    param([string]$Text)
    $builder = New-Object System.Text.StringBuilder
    $index = 0
    while ($index -lt $Text.Length) {
        $char = $Text[$index]
        if ($char -eq "`r") {
            if ($index + 1 -lt $Text.Length -and $Text[$index + 1] -eq "`n") { $index++ }
            [void]$builder.Append('{ENTER}')
        } elseif ($char -eq "`n") {
            [void]$builder.Append('{ENTER}')
        } elseif ($char -eq "`t") {
            [void]$builder.Append('{TAB}')
        } elseif ($script:SendKeysLiteralMap.ContainsKey([string]$char)) {
            [void]$builder.Append($script:SendKeysLiteralMap[[string]$char])
        } else {
            [void]$builder.Append($char)
        }
        $index++
    }
    return $builder.ToString()
}

function ConvertTo-SendKeysChord {
    <#
    .SYNOPSIS
      Translate a human key chord such as "ctrl+shift+t" into SendKeys notation.

    .DESCRIPTION
      Returns a hashtable with the SendKeys string, whether the Windows key is
      involved (SendKeys cannot express it) and an error message when the chord
      cannot be translated.
    #>
    param([string]$Keys)
    $result = @{ ok = $false; sendKeys = ''; windows = $false; error = ''; tokens = @() }
    if ([string]::IsNullOrWhiteSpace($Keys)) {
        $result.error = 'keys is required'
        return $result
    }

    $tokens = @($Keys.Split('+') | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ -ne '' })
    if ($tokens.Count -eq 0) {
        $result.error = "keys '$Keys' contains no key"
        return $result
    }

    $ctrl = $false
    $shift = $false
    $alt = $false
    $win = $false
    $keyToken = $null

    foreach ($token in $tokens) {
        if ($token -in @('ctrl', 'control')) { $ctrl = $true; continue }
        if ($token -eq 'shift') { $shift = $true; continue }
        if ($token -eq 'alt') { $alt = $true; continue }
        if ($token -in @('win', 'meta', 'super')) { $win = $true; continue }
        if ($null -ne $keyToken) {
            $result.error = "keys '$Keys' names more than one non-modifier key ('$keyToken' and '$token'); use hotkey for chords"
            return $result
        }
        $keyToken = $token
    }

    if ($null -eq $keyToken) {
        $result.error = "keys '$Keys' has modifiers but no key"
        return $result
    }

    $keySendKeys = $null
    if ($script:SendKeysNamedKeys.ContainsKey($keyToken)) {
        $keySendKeys = $script:SendKeysNamedKeys[$keyToken]
    } elseif ($keyToken.Length -eq 1 -and $keyToken -match '^[a-z0-9]$') {
        $keySendKeys = $keyToken
    } elseif ($keyToken.Length -eq 1 -and '`-=[]\;'',./'.Contains($keyToken)) {
        if ($script:SendKeysLiteralMap.ContainsKey($keyToken)) { $keySendKeys = $script:SendKeysLiteralMap[$keyToken] }
        else { $keySendKeys = $keyToken }
    }

    if ($null -eq $keySendKeys) {
        $supported = @('ctrl', 'shift', 'alt', 'win', 'enter', 'tab', 'esc', 'space',
            'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown',
            'delete', 'backspace', 'insert', 'f1-f12', 'a-z', '0-9')
        $result.error = "unsupported key '$keyToken'; supported names: $($supported -join ', ')"
        return $result
    }

    # SendKeys modifiers precede the key: ^ is Ctrl, % is Alt, + is Shift.
    $prefix = ''
    if ($ctrl) { $prefix += '^' }
    if ($alt) { $prefix += '%' }
    if ($shift) { $prefix += '+' }

    $result.ok = $true
    $result.sendKeys = "$prefix$keySendKeys"
    $result.windows = $win
    $result.tokens = $tokens
    return $result
}

function Send-Keys {
    <#
    .SYNOPSIS
      Deliver one translated chord, holding the Windows key down when asked.
    #>
    param([string]$Sequence, [bool]$Windows)
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    if ($Windows) { [WhalePetInput.Pointer]::KeyDown([byte]$script:VirtualKeyLWin) }
    try {
        [System.Windows.Forms.SendKeys]::SendWait($Sequence)
    } finally {
        if ($Windows) {
            Start-Sleep -Milliseconds 30
            [WhalePetInput.Pointer]::KeyUp([byte]$script:VirtualKeyLWin)
        }
    }
    Start-Sleep -Milliseconds 60
}

function Invoke-PetAction {
    <#
    .SYNOPSIS
      Validate and execute one input request; returns the envelope hashtable.
    #>
    param($Request)

    $action = [string](Get-PetProp $Request 'action' '')
    $dryRun = [bool](Get-PetProp $Request 'dryRun' $false)
    $known = @('type', 'key', 'hotkey', 'move', 'position', 'click', 'double-click', 'right-click', 'scroll')

    if ([string]::IsNullOrWhiteSpace($action)) {
        return @{ ok = $false; error = 'action is required'; code = 'BAD_INPUT' }
    }
    if ($known -notcontains $action) {
        return @{ ok = $false; error = "unknown action '$action'; expected one of $($known -join ', ')"; code = 'UNKNOWN_ACTION' }
    }

    if (-not (Initialize-InputInterop)) {
        return @{ ok = $false; error = "cannot load the Win32 input interop: $($script:InputError)"; code = 'INTEROP_FAILED' }
    }

    # A read of the pointer is the only thing a dry run is allowed to do.
    $position = Get-CursorPosition

    switch ($action) {
        'position' {
            return @{
                ok    = $true
                value = @{ action = 'position'; dryRun = $dryRun; position = $position }
            }
        }

        'type' {
            $text = [string](Get-PetProp $Request 'text' '')
            if ([string]::IsNullOrEmpty($text)) {
                return @{ ok = $false; error = 'text is required for type'; code = 'BAD_INPUT' }
            }
            $restore = [bool](Get-PetProp $Request 'restoreClipboard' $true)

            $unicode = $false
            foreach ($char in $text.ToCharArray()) {
                if ([int]$char -gt 0x7F) { $unicode = $true; break }
            }
            $method = $(if ($unicode) { 'clipboard' } else { 'sendkeys' })

            if ($dryRun) {
                return @{
                    ok    = $true
                    value = @{
                        action   = 'type'
                        dryRun   = $true
                        length   = $text.Length
                        unicode  = $unicode
                        method   = $method
                        restoreClipboard = $restore
                        position = $position
                    }
                }
            }

            if ($method -eq 'sendkeys') {
                Send-Keys -Sequence (ConvertTo-SendKeysText $text) -Windows $false
                return @{
                    ok    = $true
                    value = @{
                        action   = 'type'
                        dryRun   = $false
                        length   = $text.Length
                        unicode  = $false
                        method   = 'sendkeys'
                        position = (Get-CursorPosition)
                    }
                }
            }

            # Non-ASCII: put the text on the clipboard, paste it, restore the old
            # clipboard when we could read it.
            $previous = $null
            $hadPrevious = $false
            try {
                $previous = Get-Clipboard -Raw -ErrorAction Stop
                if ($null -ne $previous) { $hadPrevious = $true }
            } catch {
                $hadPrevious = $false
            }
            Set-Clipboard -Value $text -ErrorAction Stop
            Send-Keys -Sequence '^v' -Windows $false
            Start-Sleep -Milliseconds 120
            $restored = $false
            if ($restore -and $hadPrevious) {
                try {
                    Set-Clipboard -Value $previous -ErrorAction Stop
                    $restored = $true
                } catch {
                    $restored = $false
                }
            }
            return @{
                ok    = $true
                value = @{
                    action    = 'type'
                    dryRun    = $false
                    length    = $text.Length
                    unicode   = $true
                    method    = 'clipboard'
                    restored  = $restored
                    position  = (Get-CursorPosition)
                }
            }
        }

        'key' {
            $chord = ConvertTo-SendKeysChord ([string](Get-PetProp $Request 'keys' ''))
            if (-not $chord.ok) {
                return @{ ok = $false; error = $chord.error; code = 'BAD_INPUT' }
            }
            if ($dryRun) {
                return @{
                    ok    = $true
                    value = @{
                        action   = 'key'
                        dryRun   = $true
                        keys     = [string](Get-PetProp $Request 'keys' '')
                        sendKeys = $chord.sendKeys
                        windows  = $chord.windows
                        position = $position
                    }
                }
            }
            Send-Keys -Sequence $chord.sendKeys -Windows $chord.windows
            return @{
                ok    = $true
                value = @{
                    action   = 'key'
                    dryRun   = $false
                    keys     = [string](Get-PetProp $Request 'keys' '')
                    sendKeys = $chord.sendKeys
                    position = (Get-CursorPosition)
                }
            }
        }

        'hotkey' {
            $chord = ConvertTo-SendKeysChord ([string](Get-PetProp $Request 'keys' ''))
            if (-not $chord.ok) {
                return @{ ok = $false; error = $chord.error; code = 'BAD_INPUT' }
            }
            if ($dryRun) {
                return @{
                    ok    = $true
                    value = @{
                        action   = 'hotkey'
                        dryRun   = $true
                        keys     = [string](Get-PetProp $Request 'keys' '')
                        sendKeys = $chord.sendKeys
                        windows  = $chord.windows
                        position = $position
                    }
                }
            }
            Send-Keys -Sequence $chord.sendKeys -Windows $chord.windows
            return @{
                ok    = $true
                value = @{
                    action   = 'hotkey'
                    dryRun   = $false
                    keys     = [string](Get-PetProp $Request 'keys' '')
                    sendKeys = $chord.sendKeys
                    position = (Get-CursorPosition)
                }
            }
        }

        'move' {
            $coords = Resolve-PetCoordinates $Request
            if (-not $coords.ok) {
                return @{ ok = $false; error = $coords.error; code = 'BAD_INPUT' }
            }
            if ($dryRun) {
                return @{
                    ok    = $true
                    value = @{
                        action   = 'move'
                        dryRun   = $true
                        moved    = $false
                        position = @{ x = $coords.x; y = $coords.y }
                        from     = $position
                    }
                }
            }
            $moved = [WhalePetInput.Pointer]::TrySetPosition([int]$coords.x, [int]$coords.y)
            Start-Sleep -Milliseconds 40
            return @{
                ok    = $true
                value = @{
                    action   = 'move'
                    dryRun   = $false
                    moved    = [bool]$moved
                    position = (Get-CursorPosition)
                    from     = $position
                }
            }
        }

        { $_ -in @('click', 'double-click', 'right-click') } {
            $hasCoords = ($null -ne (Get-PetProp $Request 'x' $null)) -and ($null -ne (Get-PetProp $Request 'y' $null))
            $coords = $null
            if ($hasCoords) {
                $coords = Resolve-PetCoordinates $Request
                if (-not $coords.ok) {
                    return @{ ok = $false; error = $coords.error; code = 'BAD_INPUT' }
                }
            }
            $target = $(if ($hasCoords) { @{ x = $coords.x; y = $coords.y } } else { $position })
            $clicks = $(if ($action -eq 'double-click') { 2 } else { 1 })

            if ($dryRun) {
                return @{
                    ok    = $true
                    value = @{
                        action   = $action
                        dryRun   = $true
                        clicked  = $false
                        clicks   = $clicks
                        button   = $(if ($action -eq 'right-click') { 'right' } else { 'left' })
                        moveFirst = [bool]$hasCoords
                        position = $target
                    }
                }
            }

            if ($hasCoords) { [void][WhalePetInput.Pointer]::TrySetPosition([int]$coords.x, [int]$coords.y); Start-Sleep -Milliseconds 40 }
            $downFlag = $(if ($action -eq 'right-click') { [WhalePetInput.Pointer]::RIGHTDOWN } else { [WhalePetInput.Pointer]::LEFTDOWN })
            $upFlag = $(if ($action -eq 'right-click') { [WhalePetInput.Pointer]::RIGHTUP } else { [WhalePetInput.Pointer]::LEFTUP })
            for ($i = 0; $i -lt $clicks; $i++) {
                [WhalePetInput.Pointer]::Click($downFlag, $upFlag)
                if ($clicks -gt 1) { Start-Sleep -Milliseconds 60 }
            }
            return @{
                ok    = $true
                value = @{
                    action   = $action
                    dryRun   = $false
                    clicked  = $true
                    clicks   = $clicks
                    button   = $(if ($action -eq 'right-click') { 'right' } else { 'left' })
                    moveFirst = [bool]$hasCoords
                    position = (Get-CursorPosition)
                }
            }
        }

        'scroll' {
            $rawDelta = Get-PetProp $Request 'delta' $null
            if ($null -eq $rawDelta) {
                return @{ ok = $false; error = 'delta is required for scroll'; code = 'BAD_INPUT' }
            }
            $delta = 0
            if (-not [int]::TryParse([string]$rawDelta, [ref]$delta)) {
                return @{ ok = $false; error = "delta must be an integer, got '$rawDelta'"; code = 'BAD_INPUT' }
            }
            if ($delta -eq 0) {
                return @{ ok = $false; error = 'delta must not be zero'; code = 'BAD_INPUT' }
            }
            if ([Math]::Abs($delta) -gt 100) {
                return @{ ok = $false; error = "delta must be between -100 and 100, got $delta"; code = 'BAD_INPUT' }
            }
            if ($dryRun) {
                return @{
                    ok    = $true
                    value = @{
                        action   = 'scroll'
                        dryRun   = $true
                        scrolled = $false
                        delta    = $delta
                        notches  = $delta * 120
                        direction = $(if ($delta -gt 0) { 'up' } else { 'down' })
                        position = $position
                    }
                }
            }
            [WhalePetInput.Pointer]::Scroll([int]($delta * 120))
            return @{
                ok    = $true
                value = @{
                    action   = 'scroll'
                    dryRun   = $false
                    scrolled = $true
                    delta    = $delta
                    notches  = $delta * 120
                    direction = $(if ($delta -gt 0) { 'up' } else { 'down' })
                    position = (Get-CursorPosition)
                }
            }
        }
    }

    return @{ ok = $false; error = "action '$action' was not handled"; code = 'INTERNAL' }
}

function Resolve-PetCoordinates {
    <#
    .SYNOPSIS
      Read and validate an integer x/y pair from the request.
    #>
    param($Request)
    $rawX = Get-PetProp $Request 'x' $null
    $rawY = Get-PetProp $Request 'y' $null
    if ($null -eq $rawX -or $null -eq $rawY) {
        return @{ ok = $false; error = 'x and y are required'; code = 'BAD_INPUT' }
    }
    $x = 0
    $y = 0
    if (-not [int]::TryParse([string]$rawX, [ref]$x)) {
        return @{ ok = $false; error = "x must be an integer, got '$rawX'" }
    }
    if (-not [int]::TryParse([string]$rawY, [ref]$y)) {
        return @{ ok = $false; error = "y must be an integer, got '$rawY'" }
    }
    return @{ ok = $true; x = $x; y = $y }
}

# ------------------------------------------------------------------ main ----
try {
    $request = Read-PetInput
    $envelope = Invoke-PetAction $request
} catch {
    $envelope = @{ ok = $false; error = $_.Exception.Message; code = 'INPUT_FAILED' }
}
Write-PetEnvelope $envelope
exit 0

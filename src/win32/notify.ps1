<#
.SYNOPSIS
  Show one Windows notification for the whale-pet DSH plugin.

.DESCRIPTION
  Reads one JSON object from stdin and writes exactly one JSON envelope to stdout:

    {"title":"whale-pet","message":"self-test","silent":true}
      -> {"ok":true,"value":{"shown":true,"via":"toast"}}

  Input:
    title    required
    message  optional, defaults to an empty string
    silent   optional, default false; mutes the toast sound
    appId    optional AppUserModelId; defaults to the registered Windows
             PowerShell AUMID, which is what makes an unpackaged toast appear
    dryRun   optional; reports what would be shown and shows nothing

  Primary path: a WinRT toast through Windows.UI.Notifications. That projection
  only exists in Windows PowerShell 5.1, so the toast is executed by a child
  powershell.exe even when this script runs under PowerShell 7. Fallback: a
  System.Windows.Forms.NotifyIcon balloon tip.

  The script never throws: every failure becomes {"ok":false,...}, and the exit
  code stays 0 in both cases.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# AUMID of the Windows PowerShell shortcut that ships with Windows. An unpackaged
# app has no AUMID of its own, and ToastNotificationManager needs one that is
# registered, otherwise the toast never appears.
$script:DefaultAppId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'

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

# --------------------------------------------------------------- toast ------
function Get-ToastScript {
    <#
    .SYNOPSIS
      The Windows PowerShell 5.1 child script that raises the WinRT toast.

    .DESCRIPTION
      It prints exactly "OK" or "ERR <message>" and nothing else. The title,
      message, silent flag and app id arrive through environment variables, which
      keeps arbitrary user text out of the command line and out of any quoting
      layer.
    #>
    return @'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
    $title = [string]$env:WHALE_PET_TOAST_TITLE
    $message = [string]$env:WHALE_PET_TOAST_MESSAGE
    $silent = ($env:WHALE_PET_TOAST_SILENT -eq '1')
    $appId = [string]$env:WHALE_PET_TOAST_APPID
    [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
    $template = [Windows.UI.Notifications.ToastTemplateType]::ToastText02
    $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($template)
    $nodes = $xml.GetElementsByTagName('text')
    [void]$nodes.Item(0).AppendChild($xml.CreateTextNode($title))
    [void]$nodes.Item(1).AppendChild($xml.CreateTextNode($message))
    if ($silent) {
        $toastNode = $xml.GetElementsByTagName('toast').Item(0)
        $audio = $xml.CreateElement('audio')
        [void]$audio.SetAttribute('silent', 'true')
        [void]$toastNode.AppendChild($audio)
    }
    $toast = New-Object Windows.UI.Notifications.ToastNotification -ArgumentList $xml
    $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
    $notifier.Show($toast)
    [Console]::Out.Write('OK')
} catch {
    [Console]::Out.Write('ERR ' + $_.Exception.Message)
}
'@
}

function Get-WindowsPowerShellPath {
    <#
    .SYNOPSIS
      Absolute path of Windows PowerShell 5.1, the only host with the WinRT
      projection.
    #>
    $candidate = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (Test-Path -LiteralPath $candidate) { return $candidate }
    return 'powershell.exe'
}

function Show-PetToast {
    <#
    .SYNOPSIS
      Run the toast in Windows PowerShell 5.1; returns @{ shown; reason }.
    #>
    param([string]$Title, [string]$Message, [bool]$Silent, [string]$AppId, [int]$TimeoutSeconds = 20)

    $result = @{ shown = $false; reason = '' }
    $saved = @{
        title   = $env:WHALE_PET_TOAST_TITLE
        message = $env:WHALE_PET_TOAST_MESSAGE
        silent  = $env:WHALE_PET_TOAST_SILENT
        appId   = $env:WHALE_PET_TOAST_APPID
    }
    try {
        $env:WHALE_PET_TOAST_TITLE = $Title
        $env:WHALE_PET_TOAST_MESSAGE = $Message
        $env:WHALE_PET_TOAST_SILENT = $(if ($Silent) { '1' } else { '0' })
        $env:WHALE_PET_TOAST_APPID = $AppId

        $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes((Get-ToastScript)))
        $exe = Get-WindowsPowerShellPath
        $output = & $exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded 2>$null
        $text = ([string]($output | Out-String)).Trim()
        if ($text -eq 'OK') {
            $result.shown = $true
        } else {
            $result.reason = $(if ([string]::IsNullOrWhiteSpace($text)) { 'the toast host produced no output' } else { $text })
        }
    } catch {
        $result.reason = $_.Exception.Message
    } finally {
        $env:WHALE_PET_TOAST_TITLE = $saved.title
        $env:WHALE_PET_TOAST_MESSAGE = $saved.message
        $env:WHALE_PET_TOAST_SILENT = $saved.silent
        $env:WHALE_PET_TOAST_APPID = $saved.appId
    }
    return $result
}

function Show-PetBalloon {
    <#
    .SYNOPSIS
      Fallback notification through a NotifyIcon balloon tip.

    .DESCRIPTION
      The balloon lives in this process, so the process stays alive long enough
      for the shell to draw it before the icon is disposed.
    #>
    param([string]$Title, [string]$Message, [int]$HoldMilliseconds = 3500)
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    Add-Type -AssemblyName System.Drawing -ErrorAction Stop
    $icon = New-Object System.Windows.Forms.NotifyIcon
    try {
        $icon.Icon = [System.Drawing.SystemIcons]::Information
        $icon.BalloonTipTitle = $Title
        $icon.BalloonTipText = $Message
        $icon.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
        $icon.Visible = $true
        $icon.ShowBalloonTip($HoldMilliseconds)
        Start-Sleep -Milliseconds $HoldMilliseconds
    } finally {
        $icon.Visible = $false
        $icon.Dispose()
    }
}

function Invoke-PetAction {
    <#
    .SYNOPSIS
      Validate and run one notification request; returns the envelope hashtable.
    #>
    param($Request)

    $title = [string](Get-PetProp $Request 'title' '')
    $message = [string](Get-PetProp $Request 'message' '')
    $silent = [bool](Get-PetProp $Request 'silent' $false)
    $dryRun = [bool](Get-PetProp $Request 'dryRun' $false)
    $appId = [string](Get-PetProp $Request 'appId' '')
    if ([string]::IsNullOrWhiteSpace($appId)) { $appId = $script:DefaultAppId }

    if ([string]::IsNullOrWhiteSpace($title) -and [string]::IsNullOrWhiteSpace($message)) {
        return @{ ok = $false; error = 'title (or message) is required'; code = 'BAD_INPUT' }
    }

    if ($dryRun) {
        return @{
            ok    = $true
            value = @{
                shown  = $false
                via    = 'toast'
                dryRun = $true
                would  = @{ title = $title; message = $message; silent = $silent; appId = $appId }
            }
        }
    }

    $toast = Show-PetToast -Title $title -Message $message -Silent $silent -AppId $appId
    if ($toast.shown) {
        return @{ ok = $true; value = @{ shown = $true; via = 'toast' } }
    }

    Show-PetBalloon -Title $title -Message $message
    return @{
        ok    = $true
        value = @{
            shown  = $true
            via    = 'balloon'
            reason = "toast unavailable: $($toast.reason)"
        }
    }
}

# ------------------------------------------------------------------ main ----
try {
    $request = Read-PetInput
    $envelope = Invoke-PetAction $request
} catch {
    $envelope = @{ ok = $false; error = $_.Exception.Message; code = 'NOTIFY_FAILED' }
}
Write-PetEnvelope $envelope
exit 0

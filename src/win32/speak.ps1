<#
.SYNOPSIS
  Speak one line through the Windows speech synthesizer (System.Speech / SAPI).

.DESCRIPTION
  Fallback voice for `pet_say` when the desktop-pet window is not connected.
  Reads one JSON object from stdin and writes one JSON envelope to stdout:

    {"text":"...","rate":1.05,"volume":1,"lang":"zh-CN","voice":""}
      -> {"ok":true,"value":{"spoken":true,"voice":"Microsoft Huihui Desktop","engine":"system-speech"}}

  Must run under Windows PowerShell 5.1: System.Speech is a .NET Framework
  assembly and is not loadable from PowerShell 7.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Envelope {
    param([hashtable]$Payload)
    Write-Output (ConvertTo-Json -InputObject $Payload -Compress -Depth 8)
}

try {
    $raw = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($raw)) { $raw = '{}' }
    $input = $raw | ConvertFrom-Json

    $text = [string]$input.text
    if ([string]::IsNullOrWhiteSpace($text)) {
        Write-Envelope @{ ok = $false; error = 'text is required'; code = 'BAD_INPUT' }
        exit 0
    }

    Add-Type -AssemblyName System.Speech
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer

    $wanted = [string]$input.voice
    $lang = [string]$input.lang
    if ([string]::IsNullOrWhiteSpace($lang)) { $lang = 'zh-CN' }
    $installed = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled })
    $chosen = $null
    if (-not [string]::IsNullOrWhiteSpace($wanted)) {
        $chosen = $installed | Where-Object { $_.VoiceInfo.Name -like "*$wanted*" } | Select-Object -First 1
    }
    if ($null -eq $chosen) {
        $prefix = $lang.Split('-')[0]
        $chosen = $installed | Where-Object { $_.VoiceInfo.Culture.Name -like "$prefix*" } | Select-Object -First 1
    }
    if ($null -eq $chosen -and $installed.Count -gt 0) { $chosen = $installed[0] }
    if ($null -ne $chosen) { $synth.SelectVoice($chosen.VoiceInfo.Name) }

    # System.Speech rate is -10..10; the plugin's rate is a 0.5..2 multiplier.
    $rate = 0.0
    if ($null -ne $input.rate) { $rate = [double]$input.rate }
    if ($rate -le 0) { $rate = 1.0 }
    $synth.Rate = [int][Math]::Max(-10, [Math]::Min(10, [Math]::Round(($rate - 1.0) * 8)))
    $volume = 1.0
    if ($null -ne $input.volume) { $volume = [double]$input.volume }
    $synth.Volume = [int][Math]::Max(0, [Math]::Min(100, [Math]::Round($volume * 100)))

    $synth.Speak($text) | Out-Null
    $synth.Dispose()

    Write-Envelope @{
        ok    = $true
        value = @{
            spoken = $true
            voice  = if ($null -ne $chosen) { $chosen.VoiceInfo.Name } else { $null }
            engine = 'system-speech'
        }
    }
    exit 0
} catch {
    Write-Envelope @{ ok = $false; error = $_.Exception.Message; code = 'SPEAK_FAILED' }
    exit 0
}

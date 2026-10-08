<#
.SYNOPSIS
  Transcribe one recorded WAV clip with the offline Windows speech recognizer.

.DESCRIPTION
  Speech recognition fallback for the pet window when the browser has no
  Web Speech engine (Electron does not ship one). Reads one JSON object from
  stdin and writes one JSON envelope to stdout:

    {"audioBase64":"<canonical 16 kHz mono PCM16 WAV>","lang":"zh-CN"}
      -> {"ok":true,"value":{"text":"...","confidence":0.82,"engine":"sapi"}}

  Requires the Windows Speech Recognition language pack for `lang`; a missing
  recognizer is reported as a structured error rather than a crash. Must run
  under Windows PowerShell 5.1: System.Speech is a .NET Framework assembly.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Envelope {
    param([hashtable]$Payload)
    Write-Output (ConvertTo-Json -InputObject $Payload -Compress -Depth 8)
}

$tempFile = $null
try {
    $raw = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($raw)) { $raw = '{}' }
    $input = $raw | ConvertFrom-Json

    $base64 = [string]$input.audioBase64
    if ([string]::IsNullOrWhiteSpace($base64)) {
        Write-Envelope @{ ok = $false; error = 'audioBase64 is required'; code = 'BAD_INPUT' }
        exit 0
    }
    $lang = [string]$input.lang
    if ([string]::IsNullOrWhiteSpace($lang)) { $lang = 'zh-CN' }

    Add-Type -AssemblyName System.Speech
    $recognizers = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers())
    if ($recognizers.Count -eq 0) {
        Write-Envelope @{ ok = $false; error = 'no Windows speech recognizer is installed'; code = 'NO_RECOGNIZER' }
        exit 0
    }
    $prefix = $lang.Split('-')[0]
    $info = $recognizers | Where-Object { $_.Culture.Name -like "$prefix*" } | Select-Object -First 1
    if ($null -eq $info) { $info = $recognizers[0] }

    $tempFile = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "dsh-whale-pet-asr-$([Guid]::NewGuid().ToString('N')).wav")
    [System.IO.File]::WriteAllBytes($tempFile, [Convert]::FromBase64String($base64))

    $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($info)
    $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
    $engine.SetInputToWaveFile($tempFile)
    $result = $engine.Recognize()
    $engine.Dispose()

    if ($null -eq $result) {
        Write-Envelope @{ ok = $true; value = @{ text = ''; confidence = 0.0; engine = 'sapi'; culture = $info.Culture.Name; heard = $false } }
        exit 0
    }
    Write-Envelope @{
        ok    = $true
        value = @{
            text       = $result.Text
            confidence = [Math]::Round([double]$result.Confidence, 3)
            engine     = 'sapi'
            culture    = $info.Culture.Name
            heard      = $true
        }
    }
    exit 0
} catch {
    $message = $_.Exception.Message
    $code = 'ASR_FAILED'
    if ($message -like '*No recognizer*' -or $message -like '*not installed*') { $code = 'NO_RECOGNIZER' }
    Write-Envelope @{ ok = $false; error = $message; code = $code }
    exit 0
} finally {
    if ($null -ne $tempFile -and [System.IO.File]::Exists($tempFile)) {
        try { [System.IO.File]::Delete($tempFile) } catch { }
    }
}

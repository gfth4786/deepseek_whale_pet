<#
.SYNOPSIS
  Keep the browser-shell pet window above other windows.

.DESCRIPTION
  The Electron shell makes its own window always-on-top. The Edge/Chrome
  fallback cannot, so this keeper polls for the pet window and re-asserts
  HWND_TOPMOST whenever something pushes it down. It exits on its own a few
  seconds after the window disappears, and also when its parent goes away.

  Usage: pwsh -NoProfile -File scripts/topmost.ps1 [-TitlePattern '鲸鱼娘']
#>
[CmdletBinding()]
param(
    [string]$TitlePattern = '鲸鱼娘',
    [int]$IntervalMs = 2000,
    [int]$MissesBeforeExit = 15
)

$ErrorActionPreference = 'Stop'

if (-not ('WhalePetTopmost' -as [type])) {
    Add-Type -Namespace WhalePet -Name Topmost -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
public static extern bool SetWindowPos(System.IntPtr hWnd, System.IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

public const uint SWP_NOSIZE = 0x0001;
public const uint SWP_NOMOVE = 0x0002;
public const uint SWP_NOACTIVATE = 0x0010;
public static readonly System.IntPtr HWND_TOPMOST = new System.IntPtr(-1);

public static bool Promote(System.IntPtr handle) {
    return SetWindowPos(handle, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
}
'@
}

$misses = 0
while ($true) {
    $targets = @(Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$TitlePattern*" })
    if ($targets.Count -eq 0) {
        $misses++
        if ($misses -ge $MissesBeforeExit) { break }
    }
    else {
        $misses = 0
        foreach ($target in $targets) {
            try { [void][WhalePet.Topmost]::Promote($target.MainWindowHandle) } catch { }
        }
    }
    Start-Sleep -Milliseconds $IntervalMs
}

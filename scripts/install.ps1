#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Install the whale-pet bundle into a DSH profile, or remove it again.

.DESCRIPTION
  Wraps the two commands a user would otherwise type by hand:

    pnpm install                                     # window shell (Electron)
    dsh plugin --profile <profile> add <this folder>  # the bundle layer

  The bundle layer is read at DSH startup, so the plugin (and the pet window)
  appear after a restart. `-Uninstall` reverses the install.

.PARAMETER Profile
  DSH profile to install into. Defaults to `web` (the profile behind `dsh web`).

.PARAMETER Dsh
  How to invoke the DSH CLI. Use `pnpm dsh` when running from a source checkout.

.PARAMETER SkipDependencies
  Do not run `pnpm install` (use when the window shell is already installed).

.EXAMPLE
  powershell -NoProfile -File scripts/install.ps1

.EXAMPLE
  powershell -NoProfile -File scripts/install.ps1 -Profile demo -Dsh 'pnpm dsh' -SkipDependencies
#>
[CmdletBinding()]
param(
    [string]$Profile = 'web',
    [string]$Dsh = 'dsh',
    [switch]$SkipDependencies,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Write-Host "whale-pet: $root" -ForegroundColor Cyan

$dshParts = $Dsh -split '\s+'
$dshExe = $dshParts[0]
$dshArgs = @($dshParts[1..($dshParts.Count - 1)] | Where-Object { $_ })
if ($null -eq (Get-Command $dshExe -ErrorAction SilentlyContinue)) {
    Write-Warning "找不到 '$dshExe'。若你在源码检出里开发，请改用："
    Write-Host "  powershell -NoProfile -File scripts/install.ps1 -Dsh 'pnpm dsh'" -ForegroundColor Yellow
    exit 1
}

# `add` takes a path, `remove` takes the dependency name pnpm recorded.
$packageName = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).name

if ($Uninstall) {
    $removeArgs = @($dshArgs) + @('plugin', '--profile', $Profile, 'remove', $packageName)
    Write-Host "→ $dshExe $($removeArgs -join ' ')"
    & $dshExe @removeArgs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Host '已从 profile 移除。重启 DSH 后生效。' -ForegroundColor Green
    exit 0
}

$bundleArgs = @($dshArgs) + @('plugin', '--profile', $Profile, 'add', $root)

if (-not $SkipDependencies) {
    $electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
    if (Test-Path $electron) {
        Write-Host '✓ 窗口外壳已就绪' -ForegroundColor Green
    }
    else {
        Write-Host '→ 安装窗口依赖（Electron，约 150 MB）…'
        $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
        if ($null -eq $pnpm) {
            Write-Warning '没有 pnpm：跳过依赖安装。桌宠会退回 Edge/Chrome 独立窗口。'
        }
        else {
            Push-Location $root
            try {
                & pnpm install
                # pnpm 默认不跑依赖的构建脚本，Electron 的二进制正是被这一步漏掉的。
                $installer = Join-Path $root 'node_modules\electron\install.js'
                if (-not (Test-Path $electron) -and (Test-Path $installer)) {
                    Write-Host '→ pnpm 没有下载 Electron 二进制，手动补一次…'
                    if (-not $env:ELECTRON_MIRROR) {
                        Write-Host '  （若卡在下载，可先设镜像：$env:ELECTRON_MIRROR="https://registry.npmmirror.com/-/binary/electron/"）'
                    }
                    & node $installer
                }
            }
            finally { Pop-Location }
            if (-not (Test-Path $electron)) {
                Write-Warning 'Electron 仍不可用：桌宠会退回 Edge/Chrome 独立窗口，其余功能不受影响。'
            }
        }
    }
}

Write-Host "→ $dshExe $($bundleArgs -join ' ')"
& $dshExe @bundleArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ''
Write-Host '✓ 已安装到 profile。' -ForegroundColor Green
Write-Host "  重启 DSH 后鲸鱼娘会自己出来：  $dshExe $($dshArgs -join ' ') --profile $Profile"
Write-Host '  先检查配置层：                ' -NoNewline
Write-Host "$dshExe $($dshArgs -join ' ') --profile $Profile --dump-config"
Write-Host "  卸载：                        powershell -NoProfile -File scripts/install.ps1 -Uninstall -Profile $Profile"

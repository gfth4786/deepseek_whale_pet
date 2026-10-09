#!/usr/bin/env node
/**
 * Launcher for the whale-girl desktop window.
 *
 * Two shells are supported, in order of preference:
 *
 * 1. **Electron** — a genuinely transparent, frameless, always-on-top window.
 *    Used whenever the bundled `electron` dev dependency has a real binary.
 * 2. **A Chromium app window** — Edge or Chrome in `--app=` mode, promoted to
 *    always-on-top by a small PowerShell keeper. No download, but the window is
 *    opaque and has a title bar.
 *
 * Usage:
 *   node scripts/launch-pet.mjs --url=http://127.0.0.1:4571/pet/?token=…
 *   node scripts/launch-pet.mjs --url=… --selftest --shot=tests/artifacts/x.png
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const MAIN = join(ROOT, 'pet', 'electron-main.cjs')

/** Windows PowerShell 5.1, the one interpreter a stock Windows box always has. */
const WINDOWS_POWERSHELL = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
)

/** Interpreter for the always-on-top keeper; either PowerShell host works. */
const POWERSHELL_COMMAND = process.env.DSH_WHALE_PET_PWSH
  ?? (existsSync(WINDOWS_POWERSHELL) ? WINDOWS_POWERSHELL : 'powershell')

/** The always-on-top keeper process, kept so it can be reported in diagnostics. */
let keeperProcess

/** Parse `--key=value` and `--key value` pairs from an argument list. */
export function parseArgs(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
    const eq = arg.indexOf('=')
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1)
      continue
    }
    const key = arg.slice(2)
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next
      index++
    } else {
      out[key] = true
    }
  }
  return out
}

/** Window geometry handed down by the plugin. */
export function windowSpec(env = process.env) {
  const fallback = { width: 320, height: 420, margin: 24, corner: 'bottom-right', alwaysOnTop: true }
  const raw = env.DSH_WHALE_PET_WINDOW
  if (typeof raw !== 'string' || raw.length === 0) return fallback
  try {
    return { ...fallback, ...JSON.parse(raw) }
  } catch {
    return fallback
  }
}

/**
 * Absolute path of a usable Electron binary, or undefined.
 *
 * Resolved by looking at the conventional files only, never by `require()`ing
 * the `electron` package: that package's entry point *downloads* a 150 MB
 * binary as a side effect when its `dist/` is missing, and Node's resolver will
 * happily find an unrelated `electron` further up the directory tree. A
 * deployment can point at any Electron with `DSH_WHALE_PET_ELECTRON`.
 * @param base - package directory whose `node_modules` should be inspected.
 * @returns the executable path, or undefined when unavailable.
 */
export function resolveElectron(base = ROOT) {
  const dist = join(base, 'node_modules', 'electron', 'dist')
  const override = process.env.DSH_WHALE_PET_ELECTRON
  const overrideDist = process.env.ELECTRON_OVERRIDE_DIST_PATH
  const candidates = [
    override,
    overrideDist === undefined ? undefined : join(overrideDist, 'electron.exe'),
    overrideDist === undefined ? undefined : join(overrideDist, 'electron'),
    join(dist, 'electron.exe'),
    join(dist, 'electron'),
  ]
  return candidates.find(candidate => typeof candidate === 'string' && candidate.length > 0 && existsSync(candidate))
}

/** Chromium-family browsers that can open a standalone app window. */
const BROWSERS = [
  join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
]

/**
 * First installed Chromium browser usable as a pet window.
 * @returns the executable path, or undefined.
 */
export function findBrowser() {
  return BROWSERS.find(candidate => candidate.length > 0 && existsSync(candidate))
}

/** Place a window in the requested work-area corner. */
function cornerArgs(spec, screen) {
  const width = Number(spec.width) || 320
  const height = Number(spec.height) || 420
  const margin = Number(spec.margin) || 24
  const area = screen ?? { x: 0, y: 0, width: 1920, height: 1080 }
  const right = area.x + area.width - width - margin
  const bottom = area.y + area.height - height - margin
  const left = area.x + margin
  const top = area.y + margin
  switch (spec.corner) {
    case 'bottom-left': return { x: left, y: bottom, width, height }
    case 'top-right': return { x: right, y: top, width, height }
    case 'top-left': return { x: left, y: top, width, height }
    default: return { x: right, y: bottom, width, height }
  }
}

/**
 * Launch Electron and stay alive as its supervisor.
 *
 * `--user-data-dir=<path>` is forwarded as a Chromium switch placed *before* the
 * app path. The window takes a single-instance lock on its user-data directory,
 * which is what keeps a normal desktop to one pet — but it also means a second
 * launch (the selftest, a test) would silently quit while the real window is
 * running. Passing a private directory is how those runs get their own window.
 * @param executable - the Electron binary.
 * @param argv - window arguments, already including any `--user-data-dir`.
 * @param selftest - whether to inherit stdio so the JSON report reaches the caller.
 * @returns the spawned child process.
 */
function runElectron(executable, argv, selftest) {
  const profileArg = argv.find(argument => argument.startsWith('--user-data-dir='))
  const child = spawn(executable, [
    ...(profileArg === undefined ? [] : [profileArg]),
    MAIN,
    ...argv.filter(argument => argument !== profileArg),
  ], {
    // Inheriting stdio while testing lets the JSON report reach the caller;
    // a normal launch stays quiet. A deployment can opt into the window's
    // console output with DSH_WHALE_PET_WINDOW_DEBUG=1.
    stdio: selftest || process.env.DSH_WHALE_PET_WINDOW_DEBUG === '1' ? 'inherit' : 'ignore',
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    windowsHide: false,
  })
  supervise(child)
  return child
}

/**
 * Stay alive for as long as the window does.
 *
 * This process is the handle the plugin tracks: if it exited right after
 * spawning Electron, the plugin would report the window as closed while it is
 * still on screen, and `pet_window quit` would have nothing to kill. Exiting
 * with the child also makes the launcher a real process-tree root, so the
 * plugin's `taskkill /T` reaches the window.
 * @param child - the spawned window process.
 */
function supervise(child) {
  child.on('exit', (code, signal) => {
    if (signal !== null && signal !== undefined) process.exitCode = 0
    else process.exitCode = code ?? 0
    process.exit()
  })
  child.on('error', (error) => {
    process.stderr.write(`whale-pet launcher: window failed to start: ${error.message}\n`)
    process.exitCode = 4
  })
  const forward = () => {
    try {
      child.kill()
    } catch {
      // The window is already gone.
    }
  }
  process.on('SIGINT', forward)
  process.on('SIGTERM', forward)
  process.on('exit', forward)
}

/** Launch a Chromium app window plus the always-on-top keeper. */
function runBrowser(executable, url, spec, selftest) {
  const geometry = cornerArgs(spec)
  const profile = join(tmpdir(), 'dsh-whale-pet-browser')
  mkdirSync(profile, { recursive: true })
  const args = [
    `--app=${url}`,
    `--window-size=${geometry.width},${geometry.height}`,
    `--window-position=${geometry.x},${geometry.y}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--autoplay-policy=no-user-gesture-required',
  ]
  const child = spawn(executable, args, {
    stdio: selftest || process.env.DSH_WHALE_PET_WINDOW_DEBUG === '1' ? 'inherit' : 'ignore',
    windowsHide: false,
  })
  if (spec.alwaysOnTop !== false) {
    const keeper = join(HERE, 'topmost.ps1')
    if (existsSync(keeper)) {
      keeperProcess = spawn(POWERSHELL_COMMAND, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', keeper], {
        stdio: 'ignore',
        windowsHide: true,
      })
      keeperProcess.on('error', () => {
        // The keeper is a nicety; a machine without PowerShell still gets a window.
      })
    }
  }
  if (selftest) {
    process.stderr.write('selftest is only meaningful with Electron; no screenshot was taken\n')
  }
  supervise(child)
  return child
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const url = typeof args.url === 'string' ? args.url : ''
  if (url.length === 0) {
    process.stderr.write('usage: node scripts/launch-pet.mjs --url=<pet url> [--selftest] [--shot=<path>] [--user-data-dir=<path>]\n')
    process.exitCode = 2
    return
  }
  const selftest = args.selftest === true
  const spec = windowSpec()
  const argv = [`--url=${url}`]
  if (args.hidden === true) argv.push('--hidden')
  if (args['no-topmost'] === true) argv.push('--no-topmost')
  // A private profile directory is how a test window avoids the running pet's
  // single-instance lock (see runElectron).
  if (typeof args['user-data-dir'] === 'string' && args['user-data-dir'].length > 0) {
    argv.push(`--user-data-dir=${args['user-data-dir']}`)
  }
  if (selftest) {
    argv.push('--selftest')
    if (typeof args.shot === 'string') argv.push(`--shot=${args.shot}`)
  }
  const electron = resolveElectron()
  if (electron !== undefined) {
    runElectron(electron, argv, selftest)
    return
  }
  const browser = findBrowser()
  if (browser === undefined) {
    process.stderr.write(
      'whale-pet: neither Electron nor Edge/Chrome was found.\n'
      + 'Install the window shell with `pnpm install` inside the plugin directory, then retry.\n',
    )
    process.exitCode = 3
    return
  }
  process.stderr.write('whale-pet: Electron is unavailable; opening an Edge/Chrome app window instead.\n')
  runBrowser(browser, url, spec, selftest)
}

// Importable for tests: only act when executed directly.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`whale-pet launcher failed: ${error?.stack ?? error}\n`)
    process.exitCode = 1
  })
}

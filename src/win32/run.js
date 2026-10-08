/**
 * Runs the bundled Windows PowerShell helpers and speaks their JSON protocol.
 *
 * Every helper under `src/win32/` is a self-contained script that reads one
 * JSON object from stdin and writes exactly one JSON object to stdout:
 * `{"ok":true,"value":{...}}` or `{"ok":false,"error":"...","code":"..."}`.
 * This module owns process spawning, the timeout, decoding, and the envelope
 * check, so the tools above it only see a value or a thrown error.
 *
 * The helpers are spawned directly with `node:child_process`. That is
 * deliberate: the DSH sandbox wraps the model's shell tool argv, not plugin
 * code, so a plugin is the policy boundary for what it runs. Everything here is
 * a fixed, reviewed script under this package — never a model-supplied command.
 *
 * @module dsh-whale-pet/src/win32/run
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Absolute path of Windows PowerShell 5.1, needed for the WinRT toast projection. */
export const WINDOWS_POWERSHELL = process.env.DSH_WHALE_PET_WINDOWS_PWSH
  ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/**
 * Locate one executable on `PATH` (plus `PATHEXT` on Windows).
 * @param name - executable base name without an extension.
 * @returns the absolute path, or undefined when it is not installed.
 */
function findOnPath(name) {
  const raw = process.env.PATH ?? ''
  const extensions = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(part => part.length > 0)
  const separator = process.platform === 'win32' ? ';' : ':'
  for (const directory of raw.split(separator)) {
    if (directory.length === 0) continue
    for (const extension of [...extensions, '']) {
      const candidate = join(directory, `${name}${extension}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * The PowerShell used for the desktop helpers.
 *
 * PowerShell 7 is preferred when it is installed, but it is not a given: a
 * stock Windows box ships only Windows PowerShell 5.1, and several of these
 * helpers work under both. Assuming `pwsh` would make every helper call fail
 * with ENOENT on exactly the machines this plugin targets, so the choice is
 * resolved up front and can be pinned with `DSH_WHALE_PET_PWSH`.
 */
export const POWERSHELL = process.env.DSH_WHALE_PET_PWSH
  ?? findOnPath('pwsh')
  ?? (existsSync('C:\\Program Files\\PowerShell\\7\\pwsh.exe') ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' : undefined)
  ?? findOnPath('powershell')
  ?? WINDOWS_POWERSHELL

/** The interpreter used when the preferred one cannot be started at all. */
const FALLBACK_POWERSHELL = existsSync(WINDOWS_POWERSHELL) ? WINDOWS_POWERSHELL : POWERSHELL

/** Raised when a helper cannot run or answers outside its protocol. */
export class HelperError extends Error {
  /**
   * @param message - what failed, including the helper name.
   * @param options - optional machine code and captured diagnostics.
   */
  constructor(message, options = {}) {
    super(message)
    this.name = 'HelperError'
    this.code = options.code ?? 'HELPER_FAILED'
    this.stderr = options.stderr ?? ''
    this.exitCode = options.exitCode
  }
}

/**
 * Absolute path of one helper script inside this package.
 * @param name - script base name without extension.
 * @returns the absolute `.ps1` path.
 */
export function helperPath(name) {
  return join(HERE, `${name}.ps1`)
}

/**
 * Run one helper and return its `value` payload.
 * @param name - script base name without extension.
 * @param input - JSON-serializable input object, or undefined for `{}`.
 * @param options - timeout, interpreter override, cancellation, and logger.
 * @returns the helper's `value` object.
 * @throws {HelperError} on a missing script, spawn failure, timeout, cancellation,
 * non-JSON output, or an `ok:false` envelope.
 */
export async function runHelper(name, input = {}, options = {}) {
  try {
    return await invokeHelper(name, input, options)
  } catch (error) {
    // A pinned interpreter that is not actually installed is the one failure a
    // caller cannot fix from configuration; retry once on the other host.
    const requested = options.executable ?? POWERSHELL
    if (error?.code === 'HELPER_SPAWN_FAILED'
      && requested !== FALLBACK_POWERSHELL
      && error.message.includes('ENOENT')) {
      return await invokeHelper(name, input, { ...options, executable: FALLBACK_POWERSHELL })
    }
    throw error
  }
}

/**
 * Run one helper against one interpreter, without the fallback retry.
 * @param name - script base name without extension.
 * @param input - JSON-serializable input object.
 * @param options - timeout, interpreter override, and cancellation.
 * @returns the helper's `value` object.
 */
async function invokeHelper(name, input, options) {
  const script = helperPath(name)
  if (!existsSync(script)) {
    throw new HelperError(`whale-pet helper ${name}.ps1 is missing at ${script}`, { code: 'HELPER_MISSING' })
  }
  const timeoutMs = options.timeoutMs ?? 20000
  const executable = options.executable ?? POWERSHELL
  const signal = options.signal
  if (signal?.aborted === true) {
    throw new HelperError(`whale-pet helper ${name}.ps1 was cancelled before it started`, { code: 'HELPER_CANCELLED' })
  }
  const payload = `${JSON.stringify(input ?? {})}\n`
  const result = await new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(
        executable,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      )
    } catch (error) {
      reject(new HelperError(`cannot start ${executable} for ${name}.ps1: ${error.message}`, {
        code: 'HELPER_SPAWN_FAILED',
      }))
      return
    }
    const stdout = []
    const stderr = []
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      fn(value)
    }
    const kill = () => {
      try {
        child.kill()
      } catch {
        // The process may already be gone; the reported outcome stands regardless.
      }
    }
    const onAbort = () => {
      kill()
      finish(reject, new HelperError(`whale-pet helper ${name}.ps1 was cancelled`, { code: 'HELPER_CANCELLED' }))
    }
    const timer = setTimeout(() => {
      kill()
      finish(reject, new HelperError(`whale-pet helper ${name}.ps1 timed out after ${timeoutMs}ms`, {
        code: 'HELPER_TIMEOUT',
        stderr: Buffer.concat(stderr).toString('utf8'),
      }))
    }, timeoutMs)
    signal?.addEventListener?.('abort', onAbort, { once: true })
    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => stderr.push(chunk))
    child.on('error', error => finish(reject, new HelperError(
      `whale-pet helper ${name}.ps1 failed to start: ${error.message}`,
      { code: 'HELPER_SPAWN_FAILED' },
    )))
    child.on('close', (code) => {
      finish(resolve, {
        exitCode: code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
    child.stdin.on('error', () => {
      // A helper that exits before reading stdin raises EPIPE; the close handler reports the real outcome.
    })
    child.stdin.end(payload, 'utf8')
  })

  const envelope = parseEnvelope(name, result)
  if (envelope.ok === true) return envelope.value
  throw new HelperError(
    `whale-pet helper ${name}.ps1 refused: ${String(envelope.error ?? 'unknown error')}`,
    { code: String(envelope.code ?? 'HELPER_REFUSED'), stderr: result.stderr, exitCode: result.exitCode },
  )
}

/**
 * Parse one helper's stdout into its protocol envelope.
 * @param name - helper name used in diagnostics.
 * @param result - captured process result.
 * @returns the parsed envelope.
 * @throws {HelperError} when stdout is not exactly one JSON object.
 */
function parseEnvelope(name, result) {
  const text = result.stdout.trim()
  if (text.length === 0) {
    throw new HelperError(
      `whale-pet helper ${name}.ps1 wrote no JSON (exit ${result.exitCode})${stderrSuffix(result.stderr)}`,
      { code: 'HELPER_NO_OUTPUT', stderr: result.stderr, exitCode: result.exitCode },
    )
  }
  // The contract is one line, but a helper that leaks a warning keeps its last
  // JSON-looking line usable instead of failing the whole call.
  const candidate = text.includes('\n') ? text.split('\n').filter(Boolean).at(-1) : text
  let parsed
  try {
    parsed = JSON.parse(candidate)
  } catch {
    throw new HelperError(
      `whale-pet helper ${name}.ps1 wrote non-JSON output: ${truncate(text, 400)}`,
      { code: 'HELPER_BAD_OUTPUT', stderr: result.stderr, exitCode: result.exitCode },
    )
  }
  if (typeof parsed !== 'object' || parsed === null || typeof parsed.ok !== 'boolean') {
    throw new HelperError(
      `whale-pet helper ${name}.ps1 wrote an invalid envelope: ${truncate(text, 400)}`,
      { code: 'HELPER_BAD_ENVELOPE', stderr: result.stderr, exitCode: result.exitCode },
    )
  }
  return parsed
}

/** Render captured stderr for one diagnostic line. */
function stderrSuffix(stderr) {
  const text = (stderr ?? '').trim()
  return text.length === 0 ? '' : `: ${truncate(text, 300)}`
}

/** Cut long text for a diagnostic message. */
function truncate(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

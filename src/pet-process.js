/**
 * Lifecycle of the desktop-pet window process.
 *
 * The window is a separate OS process: Electron when it is available (a real
 * transparent, always-on-top, frameless window) and a Chromium app window as a
 * documented fallback. The plugin never links into it — the two halves only
 * share the loopback bridge — so this module only starts, watches, and stops it.
 *
 * @module dsh-whale-pet/src/pet-process
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** Absolute path of the bundled launcher script. */
export const LAUNCHER = join(HERE, '..', 'scripts', 'launch-pet.mjs')

/** Path of the pid file that lets a later plugin instance stop a stale window. */
export const PID_FILE = join(tmpdir(), 'dsh-whale-pet.pid')

/**
 * Owns one pet window process.
 */
export class PetProcess {
  #child
  #startedAt

  /**
   * @param options - launcher selection, url, and logging.
   * @param options.config - resolved plugin configuration.
   * @param options.url - the pet document URL including the bridge token.
   * @param options.log - log sink.
   * @param options.onExit - called when the window process ends on its own.
   */
  constructor(options) {
    this.config = options.config
    this.url = options.url
    this.log = options.log ?? (() => {})
    this.onExit = options.onExit ?? (() => {})
  }

  /** Whether a window process is currently tracked and alive. */
  get running() {
    return this.#child !== undefined && this.#child.exitCode === null && !this.#child.killed
  }

  /** The tracked pid, or undefined. */
  get pid() {
    return this.#child?.pid
  }

  /**
   * Start the window unless one is already running.
   * @returns the started pid, or undefined when a window is already up.
   */
  start() {
    if (this.running) return undefined
    const launcher = this.config.launcher.length > 0 ? this.config.launcher : LAUNCHER
    if (!existsSync(launcher)) {
      throw new Error(`whale-pet launcher not found at ${launcher}`)
    }
    const args = [launcher, '--url', this.url]
    if (this.config.window.startHidden) args.push('--hidden')
    if (!this.config.window.alwaysOnTop) args.push('--no-topmost')
    args.push(...this.config.launcherArgs)
    const child = spawn(process.execPath, args, {
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, DSH_WHALE_PET_WINDOW: JSON.stringify(this.config.window) },
    })
    child.on('error', (error) => {
      this.log(`pet window failed to start: ${error.message}`)
    })
    child.on('exit', (code, signal) => {
      this.log(`pet window exited (code ${String(code)}, signal ${String(signal)})`)
      this.#child = undefined
      this.#startedAt = undefined
      try {
        rmSync(PID_FILE, { force: true })
      } catch {
        // A missing or locked pid file never blocks shutdown.
      }
      this.onExit(code)
    })
    this.#child = child
    this.#startedAt = Date.now()
    try {
      writeFileSync(PID_FILE, String(child.pid ?? ''), 'utf8')
    } catch (error) {
      this.log(`pid file not written: ${error.message}`)
    }
    return child.pid
  }

  /**
   * Stop the window process tree.
   * @returns completion once the child has been signalled.
   */
  async stop() {
    const child = this.#child
    this.#child = undefined
    this.#startedAt = undefined
    const pid = child?.pid ?? readStalePid()
    try {
      rmSync(PID_FILE, { force: true })
    } catch {
      // Ignore: the pid file is advisory.
    }
    if (pid === undefined) return
    if (process.platform === 'win32') {
      // The launcher owns the Electron/Chromium process, so the whole tree goes.
      await new Promise((resolvePromise) => {
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        killer.on('exit', () => resolvePromise())
        killer.on('error', () => resolvePromise())
      })
      return
    }
    try {
      child?.kill('SIGTERM')
    } catch {
      // Already gone.
    }
  }

  /** Render a status line for the tool result. */
  status() {
    return {
      running: this.running,
      pid: this.pid ?? null,
      url: this.url.replace(/token=[^&]+/u, 'token=***'),
      uptimeMs: this.#startedAt === undefined ? null : Date.now() - this.#startedAt,
    }
  }
}

/**
 * Read the pid of a window process left behind by an earlier DSH run.
 * @returns the pid, or undefined when the file is absent or malformed.
 */
export function readStalePid() {
  try {
    const text = readFileSync(PID_FILE, 'utf8').trim()
    const pid = Number(text)
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

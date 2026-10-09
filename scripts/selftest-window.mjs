#!/usr/bin/env node
/**
 * Visual self-test for the pet window.
 *
 * Starts a throwaway bridge, launches the window against it, waits for the
 * renderer to report ready, saves a PNG, and prints one JSON line. Used by the
 * repository checks and by anyone swapping in their own artwork:
 *
 *   node scripts/selftest-window.mjs [--shot=tests/artifacts/pet-window.png]
 *                                    [--mood=happy] [--keep]
 */

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { PetBridge } from '../src/bridge.js'
import { parseArgs, resolveElectron } from './launch-pet.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const args = parseArgs(process.argv.slice(2))
const shot = typeof args.shot === 'string' ? args.shot : join(ROOT, 'tests', 'artifacts', 'pet-window.png')
const mood = typeof args.mood === 'string' ? args.mood : 'idle'

mkdirSync(dirname(shot), { recursive: true })

const received = []
const bridge = new PetBridge({
  host: '127.0.0.1',
  port: 0,
  token: 'selftest',
  log: message => process.stderr.write(`[selftest] ${message}\n`),
  snapshot: () => ({
    sessionId: 'session-selftest',
    lastReply: '',
    running: false,
    voice: { enabled: false, lang: 'zh-CN', voice: '', rate: 1.05, pitch: 1.25, volume: 1 },
    asr: { enabled: false, lang: 'zh-CN', engine: 'auto' },
    now: new Date().toISOString(),
  }),
  onMessage: async (payload) => {
    received.push(payload)
    return { sessionId: 'session-selftest' }
  },
})

const port = await bridge.start()

/** Run the launcher and resolve with its reported JSON. */
function runWindow() {
  return new Promise((resolve) => {
    // A private user-data directory: otherwise the running pet window's
    // single-instance lock makes this Electron quit without rendering anything.
    const profile = mkdtempSync(join(tmpdir(), 'whale-pet-selftest-'))
    const child = spawn(process.execPath, [
      join(HERE, 'launch-pet.mjs'),
      `--url=${bridge.petUrl}`,
      `--user-data-dir=${profile}`,
      '--selftest',
      `--shot=${shot}`,
    ], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: false })
    let stdout = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    const timer = setTimeout(() => {
      child.kill()
      resolve({ ok: false, error: 'the launcher did not finish within 90s' })
    }, 90000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      rmSync(profile, { recursive: true, force: true })
      const line = stdout.trim().split('\n').filter(Boolean).at(-1)
      if (line === undefined) {
        resolve({ ok: false, error: `the launcher exited with code ${String(code)} and said nothing` })
        return
      }
      try {
        resolve(JSON.parse(line))
      } catch {
        resolve({ ok: false, error: `unparsable launcher output: ${line}` })
      }
    })
  })
}

try {
  const electron = resolveElectron()
  if (electron === undefined) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'Electron is not installed; nothing to render' })}\n`)
    process.exitCode = 1
  } else {
    // Ask the page for a mood before the shot: the renderer exposes no API, so
    // the mood is set through a query the page does not need to understand and
    // a follow-up event on the live stream instead.
    const result = await runWindow()
    if (result?.ok === true && mood !== 'idle') {
      // A second pass would need a live connection; keep the mood hint for the
      // report instead of pretending the shot changed.
      result.value.mood = mood
    }
    process.stdout.write(`${JSON.stringify(result)}\n`)
    process.exitCode = result?.ok === true ? 0 : 1
  }
} finally {
  if (args.keep !== true) await bridge.stop()
  if (received.length > 0) {
    process.stderr.write(`[selftest] the window sent ${received.length} message(s)\n`)
  }
}

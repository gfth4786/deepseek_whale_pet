/**
 * Shared harness for tests that need a real pet window.
 *
 * Several behaviours only exist in the browser half — sound-effect playback, the
 * host speech provider, the sprite player — so their tests all need the same
 * three things: a throwaway bridge, a real Electron window pointed at it, and a
 * way to read the lifecycle events the window posts back. That is what lives
 * here, so each test can stay about its own subject.
 *
 * Not named `*.test.mjs` on purpose: it is a helper, not a suite.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PetBridge } from '../src/bridge.js'
import { loadPetConfig } from '../src/pet-config.js'
import { resolveElectron } from '../scripts/launch-pet.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Poll one predicate until it holds or the deadline passes.
 * @param predicate - zero-argument check.
 * @param timeoutMs - how long to keep asking.
 * @returns whether it became true.
 */
export async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return false
}

/**
 * Build one 16-bit PCM mono WAV holding a short tone.
 * @param seconds - clip length.
 * @param sampleRate - samples per second.
 * @returns the encoded file.
 */
export function encodeWav(seconds, sampleRate = 22050) {
  const samples = Math.floor(seconds * sampleRate)
  const buffer = Buffer.alloc(44 + samples * 2)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + samples * 2, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(samples * 2, 40)
  for (let index = 0; index < samples; index++) {
    const fade = Math.min(1, index / 400, (samples - index) / 400)
    const value = Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 0.25 * fade
    buffer.writeInt16LE(Math.round(value * 0x7fff), 44 + index * 2)
  }
  return buffer
}

/** Skip the calling test unless Electron is installed. */
export function requireElectron(t) {
  if (resolveElectron() === undefined) {
    t.skip('Electron is not installed')
    return false
  }
  return true
}

/**
 * Run `body` with a real pet window attached to a throwaway bridge.
 *
 * The window gets a private user-data directory: the desktop pet holds the
 * single-instance lock for the default one, and a second Electron would quit
 * before rendering anything.
 * @param options - `voice` snapshot fields, plus optional `actions`/`voices`.
 * @param body - receives `{ bridge, events }` once the window has painted.
 */
export async function withPetWindow(options, body) {
  const events = []
  const catalogue = await loadPetConfig(() => {})
  const bridge = new PetBridge({
    host: '127.0.0.1',
    port: 0,
    token: 'pet-window-test',
    log: () => {},
    onMessage: async () => ({ sessionId: 'test' }),
    onClientEvent: event => events.push(event),
    onAsr: options.onAsr,
    onTts: options.onTts,
    snapshot: () => ({
      sessionId: 'test',
      lastReply: '',
      running: false,
      voice: {
        enabled: true,
        engine: 'browser',
        lang: 'zh-CN',
        voice: '',
        rate: 1,
        pitch: 1,
        volume: 0.2,
        maxChars: 240,
        ...options.voice,
      },
      asr: { enabled: false, lang: 'zh-CN', engine: 'auto', maxSeconds: 5 },
      actions: options.actions ?? catalogue.actions,
      voices: options.voices ?? catalogue.voices,
      now: new Date().toISOString(),
    }),
  })
  await bridge.start()
  const profile = mkdtempSync(join(tmpdir(), 'whale-pet-window-'))
  const launcher = spawn(process.execPath, [
    join(ROOT, 'scripts', 'launch-pet.mjs'),
    `--url=${bridge.petUrl}`,
    `--user-data-dir=${profile}`,
  ], { stdio: 'ignore', windowsHide: true })
  try {
    const ready = await waitFor(() => events.some(event => event.type === 'ready'), 25000)
    assert.ok(ready, `the window never reported ready (events: ${JSON.stringify(events)})`)
    await body({ bridge, events })
  } finally {
    launcher.kill()
    await bridge.stop()
    await new Promise(resolve => setTimeout(resolve, 800))
    rmSync(profile, { recursive: true, force: true })
  }
}

/**
 * Integration check against the real local 曼波 engine.
 *
 * The unit tests drive `synthesize()` against a stub server, which proves the
 * protocol but not that this configuration and this engine agree. The engine is
 * a 7.6 GB third-party package with its own idea of field names, so the contract
 * is verified here against the real thing whenever it happens to be running —
 * and skipped otherwise, because it is not part of the repository's test deps.
 *
 * Start the engine first:
 *   node scripts/mambotts/start-engine.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { synthesize } from '../src/tts.js'
import { MAMBO_HTTP, engineRunning, measureWav } from './mambo-contract.mjs'

test('the real 曼波 engine answers this provider config with audible WAV', { timeout: 180000 }, async (t) => {
  if (!(await engineRunning())) {
    t.skip('曼波引擎未运行（node scripts/mambotts/start-engine.mjs）')
    return
  }
  const clip = await synthesize({ text: '你好，我是曼波。', http: MAMBO_HTTP })
  assert.equal(clip.contentType, 'audio/wav')
  const wav = measureWav(clip.audio)
  assert.ok(wav !== undefined, 'the engine did not return a WAV')
  // Silence is what a mismatched reference clip produces, so measure the audio
  // rather than trusting the header.
  assert.ok(wav.seconds > 0.8, `expected speech, got ${wav.seconds.toFixed(2)}s`)
  assert.ok(wav.peak > 0.05, `audio is silent (peak ${wav.peak})`)
  assert.ok(wav.rms > 0.01, `audio is near-silent (rms ${wav.rms})`)
})

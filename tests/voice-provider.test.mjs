/**
 * The sound-effect voice path and the host speech provider, end to end.
 *
 * `voice.effectFile` puts the window in effect mode: every reply plays one clip
 * instead of being synthesized. `voice.engine: 'http'` instead makes it ask the
 * host for a clip, which the host synthesizes through the configured provider —
 * the local 曼波 engine in the real deployment.
 *
 * Neither behaviour is observable from the host alone, so both tests launch the
 * real window, push a `say` event, and read the lifecycle reports it posts back.
 * The engine test is skipped unless that engine is actually running.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TtsCache, synthesize } from '../src/tts.js'
import { MAMBO_HTTP, engineRunning } from './mambo-contract.mjs'
import { encodeWav, requireElectron, waitFor, withPetWindow } from './pet-window-harness.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const AUDIO_DIR = join(ROOT, 'pet', 'assets', 'audio')
const PROBE = join(AUDIO_DIR, 'manbo-probe.wav')
const PROBE_RELATIVE = 'assets/audio/manbo-probe.wav'

test('an effect voice plays its clip instead of speaking', { timeout: 90000 }, async (t) => {
  if (!requireElectron(t)) return
  mkdirSync(AUDIO_DIR, { recursive: true })
  writeFileSync(PROBE, encodeWav(0.6))
  try {
    await withPetWindow({ voice: { effectFile: PROBE_RELATIVE } }, async ({ bridge, events }) => {
      bridge.publish('say', { text: '曼波测试', mood: 'happy' })
      const reported = await waitFor(
        () => events.some(event => event.type === 'effect' || event.type === 'error'),
        15000,
      )
      assert.ok(reported, 'the window reported neither playback nor an error')
      assert.equal(events.find(event => event.type === 'error'), undefined,
        'the window fell back to speech instead of playing the clip')
      assert.match(String(events.find(event => event.type === 'effect').message), /manbo-probe\.wav/)
    })
  } finally {
    rmSync(PROBE, { force: true })
  }
})

test('a missing clip reports itself and falls back to speech', { timeout: 90000 }, async (t) => {
  if (!requireElectron(t)) return
  await withPetWindow({ voice: { effectFile: 'assets/audio/definitely-not-here.mp3' } }, async ({ bridge, events }) => {
    bridge.publish('say', { text: '这条应该回退到语音合成', mood: 'happy' })
    const reported = await waitFor(() => events.some(event => event.type === 'error'), 15000)
    assert.ok(reported, 'a missing clip must be reported, not silently swallowed')
    assert.match(String(events.find(event => event.type === 'error').message), /definitely-not-here\.mp3/)
  })
})

test('the window speaks through the host provider and the real 曼波 engine', { timeout: 240000 }, async (t) => {
  if (!requireElectron(t)) return
  if (!(await engineRunning())) {
    t.skip('曼波引擎未运行（node scripts/mambotts/start-engine.mjs）')
    return
  }
  // Wired exactly like index.js: one cache, one synthesize() call per line.
  const cache = new TtsCache(MAMBO_HTTP.cacheEntries)
  const seen = []
  await withPetWindow({
    voice: { engine: 'http', volume: 0.05 },
    onTts: async ({ text }) => {
      seen.push(text)
      const hit = cache.get(text)
      if (hit !== undefined) return hit
      const clip = await synthesize({ text, http: MAMBO_HTTP })
      cache.set(text, clip)
      return clip
    },
  }, async ({ bridge, events }) => {
    bridge.publish('say', { text: '你好，我是曼波。', mood: 'happy' })
    const settled = await waitFor(
      () => events.some(event => event.type === 'tts' || event.type === 'error'),
      60000,
    )
    assert.ok(settled, `the window reported neither playback nor an error (${JSON.stringify(events)})`)
    assert.equal(events.find(event => event.type === 'error'), undefined,
      'the window failed to play what the engine returned')
    const played = events.find(event => event.type === 'tts')
    // The report carries the decoded clip size: a real sentence is tens of KB.
    const bytes = Number(String(played.message).match(/^(\d+)B/u)?.[1] ?? 0)
    assert.ok(bytes > 40000, `expected a substantial clip, got ${played.message}`)
    assert.deepEqual(seen, ['你好，我是曼波。'])
  })
})

test('the engine reports it is alive on /control', { timeout: 30000 }, async (t) => {
  if (!(await engineRunning())) {
    t.skip('曼波引擎未运行')
    return
  }
  assert.equal(await engineRunning(), true)
})

test('a probe clip is not left behind by the effect tests', () => {
  assert.equal(existsSync(PROBE), false)
})

/**
 * The contract between this plugin and a locally running 曼波 engine.
 *
 * The provider block here is the same one the plugin ships for the engine
 * (see docs/mambo-voice.md), so tests and production cannot drift apart without
 * one of them failing. Not named `*.test.mjs` on purpose: it is a helper.
 */

/** The exact `voice.http` block used against MamboTTS's GPT-SoVITS engine. */
export const MAMBO_HTTP = Object.freeze({
  url: 'http://127.0.0.1:9880/',
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{"text":"{{text}}","text_language":"zh","speed":1.0,'
    + '"refer_wav_path":"F:/project/MamboTTS/models/refer.wav",'
    + '"prompt_text":"大家好，欢迎来到我的频道，今天给大家分享一个有趣的内容",'
    + '"prompt_language":"zh"}',
  audioPath: '',
  audioEncoding: 'base64',
  format: 'wav',
  timeoutMs: 120000,
  cacheEntries: 8,
})

/** Where the engine lives, for diagnostics in test failures. */
export const ENGINE_CONTROL_URL = 'http://127.0.0.1:9880/control'

/**
 * Whether the engine is up.
 *
 * Its own client judges liveness by "`/control` answered parseable JSON", and
 * that is the test here too: another service squatting on the port would answer
 * HTML, and a 404 from the engine still answers JSON.
 * @returns true when the engine answered.
 */
export async function engineRunning() {
  try {
    const response = await fetch(ENGINE_CONTROL_URL, { signal: AbortSignal.timeout(1500) })
    await response.json()
    return true
  } catch {
    return false
  }
}

/**
 * Measure a WAV: duration and how loud it actually is.
 *
 * A well-formed WAV can still be silence, and silence is exactly what a
 * mismatched reference clip produces, so tests assert on the payload.
 * @param buffer - the WAV bytes.
 * @returns format and level facts, or undefined when this is not a WAV.
 */
export function measureWav(buffer) {
  if (buffer.length < 44
    || buffer.toString('ascii', 0, 4) !== 'RIFF'
    || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return undefined
  }
  let pos = 12
  let format
  let data
  while (pos + 8 <= buffer.length) {
    const id = buffer.toString('ascii', pos, pos + 4)
    const size = buffer.readUInt32LE(pos + 4)
    if (id === 'fmt ') {
      format = {
        channels: buffer.readUInt16LE(pos + 10),
        sampleRate: buffer.readUInt32LE(pos + 12),
        bits: buffer.readUInt16LE(pos + 22),
      }
    }
    if (id === 'data') {
      data = { offset: pos + 8, size: Math.min(size, buffer.length - pos - 8) }
      break
    }
    pos += 8 + size + (size & 1)
  }
  if (format === undefined || data === undefined) return undefined
  const frameBytes = Math.max(1, (format.bits / 8) * format.channels)
  const samples = Math.floor(data.size / frameBytes)
  let peak = 0
  let sumSquares = 0
  let counted = 0
  for (let index = 0; index + 1 < data.size; index += frameBytes) {
    const value = buffer.readInt16LE(data.offset + index) / 32768
    peak = Math.max(peak, Math.abs(value))
    sumSquares += value * value
    counted++
  }
  return {
    ...format,
    seconds: samples / format.sampleRate,
    peak,
    rms: Math.sqrt(sumSquares / Math.max(1, counted)),
    dataBytes: data.size,
  }
}

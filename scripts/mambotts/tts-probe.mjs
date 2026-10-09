/**
 * Send one line to the local 曼波 engine and report what came back.
 *
 * This is the same request the plugin's `voice.http` provider makes, so it doubles
 * as the fastest way to tell "the engine is broken" from "the plugin is broken".
 * It also measures the result — a WAV can be well-formed and silent, and silence
 * is exactly what a mis-set reference clip produces.
 *
 * Usage:
 *   node scripts/mambotts/tts-probe.mjs [--text=…] [--out=…] [--url=http://127.0.0.1:9880/]
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const args = Object.fromEntries(
  process.argv.slice(2).filter(arg => arg.startsWith('--')).map((arg) => {
    const eq = arg.indexOf('=')
    return eq === -1 ? [arg.slice(2), true] : [arg.slice(2, eq), arg.slice(eq + 1)]
  }),
)

const url = typeof args.url === 'string' ? args.url : 'http://127.0.0.1:9880/'
const text = typeof args.text === 'string' ? args.text : '你好，我是曼波，这是一次发声测试。'
const out = typeof args.out === 'string' ? args.out : join(ROOT, '.setup', 'probe.wav')

/** The reference clip and its transcript must match word for word. */
const payload = {
  text,
  text_language: 'zh',
  refer_wav_path: typeof args.refer === 'string' ? args.refer : 'F:\\project\\MamboTTS\\models\\refer.wav',
  prompt_text: typeof args.prompt === 'string'
    ? args.prompt
    : '大家好，欢迎来到我的频道，今天给大家分享一个有趣的内容',
  prompt_language: 'zh',
  speed: 1.0,
  media_type: 'wav',
}

const started = Date.now()
let response
try {
  response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120000),
  })
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: `request failed: ${String(error?.message ?? error)}` }))
  process.exit(1)
}
// The engine streams the WAV while it generates, so the first byte says nothing
// about how long synthesis took: the clock has to run until the body is read.
const timeToFirstByteMs = Date.now() - started
const body = Buffer.from(await response.arrayBuffer())
const elapsedMs = Date.now() - started

if (!response.ok) {
  console.log(JSON.stringify({ ok: false, status: response.status, body: body.toString('utf8').slice(0, 400) }))
  process.exit(1)
}

/**
 * Read a canonical RIFF/WAVE header: channels, sample rate and the data chunk.
 * @param buffer - the response body.
 * @returns format facts, or undefined when this is not a WAV.
 */
function readWav(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
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
  return format === undefined || data === undefined ? undefined : { ...format, data }
}

const wav = readWav(body)
let report = { ok: false, error: 'not a WAV', head: body.toString('ascii', 0, 16), bytes: body.length }
if (wav !== undefined) {
  const frameBytes = Math.max(1, (wav.bits / 8) * wav.channels)
  const samples = Math.floor(wav.data.size / frameBytes)
  const seconds = samples / wav.sampleRate
  // Peak and RMS over the 16-bit payload: both zero means a silent "success".
  let peak = 0
  let sumSquares = 0
  let counted = 0
  for (let index = 0; index + 1 < wav.data.size; index += frameBytes) {
    const value = body.readInt16LE(wav.data.offset + index) / 32768
    peak = Math.max(peak, Math.abs(value))
    sumSquares += value * value
    counted++
  }
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, body)
  report = {
    ok: peak > 0.01,
    out,
    bytes: body.length,
    elapsedMs,
    timeToFirstByteMs,
    realtimeFactor: Number((elapsedMs / 1000 / Math.max(0.1, seconds)).toFixed(2)),
    seconds: Number(seconds.toFixed(2)),
    sampleRate: wav.sampleRate,
    channels: wav.channels,
    bits: wav.bits,
    peak: Number(peak.toFixed(3)),
    rms: Number(Math.sqrt(sumSquares / Math.max(1, counted)).toFixed(4)),
    charsPerSecond: Number((text.length / Math.max(0.1, seconds)).toFixed(1)),
  }
}
console.log(JSON.stringify(report, null, 2))
process.exit(report.ok ? 0 : 1)

/**
 * Speech synthesis through a configured HTTP provider.
 *
 * The browser's own `speechSynthesis` has a fixed set of voices — whatever the
 * operating system installed. A character voice (曼波 and friends) lives behind
 * a TTS service instead: Fish Audio's API, a local GPT-SoVITS or Bert-VITS2
 * server, or anything else reachable over HTTP. This module turns the plugin's
 * declarative `voice.http` block into one request and one audio buffer, so the
 * same code covers all of them:
 *
 *   GPT-SoVITS   GET  http://127.0.0.1:9880/tts?text={{text}}&ref_audio_path=…
 *   Bert-VITS2   POST http://127.0.0.1:5000/voice  {"text":"{{text}}",…}
 *   Fish Audio   POST https://api.fish.audio/v1/tts {"text":"{{text}}",…} + Bearer
 *
 * Credentials live in this process only: the window asks the bridge for audio
 * and never sees a header or a key.
 *
 * @module dsh-whale-pet/src/tts
 */

/** Largest clip accepted from a provider, in bytes. */
export const MAX_AUDIO_BYTES = 12 * 1024 * 1024

/** Content types by the container names the config accepts. */
const AUDIO_TYPES = Object.freeze({
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
})

/** Raised when the provider cannot produce audio. */
export class TtsError extends Error {
  /**
   * @param message - what went wrong, including the provider's own words.
   * @param options - optional machine code and HTTP status.
   */
  constructor(message, options = {}) {
    super(`whale-pet tts: ${message}`)
    this.name = 'TtsError'
    this.code = options.code ?? 'TTS_FAILED'
    this.status = options.status
  }
}

/**
 * Content type for one configured format name.
 * @param format - container name from the config.
 * @returns the MIME type, defaulting to mp3.
 */
export function audioTypeFor(format) {
  const key = String(format ?? '').trim().toLowerCase().replace(/^\./u, '')
  return AUDIO_TYPES[key] ?? AUDIO_TYPES.mp3
}

/**
 * Substitute `{{text}}` in a URL template, URL-encoded.
 * @param template - the configured url.
 * @param text - the line to speak.
 * @returns the request URL.
 */
export function renderUrl(template, text) {
  return String(template).split('{{text}}').join(encodeURIComponent(text))
}

/**
 * Substitute `{{text}}` in a JSON body template.
 *
 * Only the inner escaping is applied, so the author writes the quotes:
 * `{"text":"{{text}}"}` stays valid JSON whatever the text contains.
 * @param template - the configured body.
 * @param text - the line to speak.
 * @returns the request body.
 */
export function renderBody(template, text) {
  const escaped = JSON.stringify(String(text)).slice(1, -1)
  return String(template).split('{{text}}').join(escaped)
}

/**
 * Read one dotted path out of a decoded JSON response.
 * @param value - the decoded response.
 * @param path - dotted path such as `data.audio`.
 * @returns the value at that path, or undefined.
 */
export function readPath(value, path) {
  let current = value
  for (const segment of String(path).split('.')) {
    if (segment.length === 0) continue
    if (current === null || typeof current !== 'object') return undefined
    current = current[segment]
  }
  return current
}

/**
 * Synthesize one line through the configured provider.
 * @param options - text, resolved plugin config, logger, and cancellation.
 * @param options.text - the line to speak.
 * @param options.http - the `voice.http` configuration block.
 * @param options.log - diagnostic sink.
 * @param options.signal - caller cancellation, combined with the timeout.
 * @param options.fetchImpl - fetch override, used by tests.
 * @returns the audio bytes and their content type.
 * @throws {TtsError} on a missing endpoint, a failed request, or an empty clip.
 */
export async function synthesize(options) {
  const { text, http, log = () => {}, signal, fetchImpl = fetch } = options
  const url = renderUrl(http.url, text)
  if (String(url).trim().length === 0) {
    throw new TtsError('voice.http.url is empty', { code: 'TTS_NOT_CONFIGURED' })
  }
  const headers = { ...http.headers }
  const init = {
    method: http.method,
    headers,
    signal: signal === undefined
      ? AbortSignal.timeout(http.timeoutMs)
      : AbortSignal.any([signal, AbortSignal.timeout(http.timeoutMs)]),
  }
  if (http.method === 'POST') {
    init.body = renderBody(http.body, text)
  }

  let response
  try {
    response = await fetchImpl(url, init)
  } catch (error) {
    throw new TtsError(`${http.method} ${url} failed: ${String(error?.message ?? error)}`, {
      code: signal?.aborted === true ? 'TTS_CANCELLED' : 'TTS_UNREACHABLE',
    })
  }

  const bytes = await readAudio(response, http, url, fetchImpl)
  if (bytes.length === 0) {
    throw new TtsError('provider returned no audio', { code: 'TTS_EMPTY', status: response.status })
  }
  if (bytes.length > MAX_AUDIO_BYTES) {
    throw new TtsError(`provider returned ${bytes.length} bytes, over the ${MAX_AUDIO_BYTES} cap`, {
      code: 'TTS_TOO_LARGE',
      status: response.status,
    })
  }
  log(`tts ${http.method} ${url.replace(/\?.*$/u, '?…')} -> ${bytes.length}B ${audioTypeFor(http.format)}`)
  return { audio: bytes, contentType: audioTypeFor(http.format) }
}

/**
 * Extract the audio bytes from one provider response.
 * @param response - the fetch response.
 * @param http - the `voice.http` configuration block.
 * @param url - the request URL, for diagnostics.
 * @param fetchImpl - fetch used to follow an audio URL.
 * @returns the audio bytes.
 * @throws {TtsError} on a non-OK response or an unusable payload.
 */
async function readAudio(response, http, url, fetchImpl) {
  if (!response.ok) {
    const detail = await safeText(response)
    throw new TtsError(`provider answered HTTP ${response.status}${detail.length === 0 ? '' : `: ${detail}`}`, {
      code: 'TTS_HTTP_ERROR',
      status: response.status,
    })
  }
  if (String(http.audioPath).trim().length === 0) {
    return Buffer.from(await response.arrayBuffer())
  }
  const payload = await response.json().catch(() => undefined)
  const value = readPath(payload, http.audioPath)
  if (typeof value !== 'string' || value.length === 0) {
    throw new TtsError(`response has no string at ${http.audioPath}`, {
      code: 'TTS_BAD_PAYLOAD',
      status: response.status,
    })
  }
  if (http.audioEncoding === 'url') {
    const audio = await fetchImpl(value, { signal: AbortSignal.timeout(http.timeoutMs) })
    if (!audio.ok) {
      throw new TtsError(`audio URL answered HTTP ${audio.status}`, { code: 'TTS_HTTP_ERROR', status: audio.status })
    }
    return Buffer.from(await audio.arrayBuffer())
  }
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length === 0) {
    throw new TtsError(`${http.audioPath} is not valid base64 audio`, { code: 'TTS_BAD_PAYLOAD' })
  }
  void url
  return decoded
}

/**
 * Read an error body without letting a decode failure mask the real problem.
 * @param response - the failed response.
 * @returns a bounded excerpt, or an empty string.
 */
async function safeText(response) {
  try {
    return (await response.text()).replace(/\s+/gu, ' ').trim().slice(0, 200)
  } catch {
    return ''
  }
}

/**
 * A bounded, insertion-ordered cache of synthesized clips.
 *
 * Replies repeat (retries, re-reads, the same short line twice), and a TTS
 * round trip is the slowest part of speaking. Keyed by exact text so a hit is
 * always the same audio.
 */
export class TtsCache {
  #entries = new Map()

  /** @param limit - maximum entries; 0 disables caching. */
  constructor(limit) {
    this.limit = Math.max(0, Number(limit) || 0)
  }

  /** Number of cached clips. */
  get size() {
    return this.#entries.size
  }

  /**
   * Read one cached clip.
   * @param key - exact text.
   * @returns the cached entry, or undefined.
   */
  get(key) {
    if (this.limit === 0) return undefined
    const hit = this.#entries.get(key)
    if (hit === undefined) return undefined
    // Refresh recency: re-inserting moves the key to the end.
    this.#entries.delete(key)
    this.#entries.set(key, hit)
    return hit
  }

  /**
   * Store one clip, evicting the oldest entry past the limit.
   * @param key - exact text.
   * @param value - audio bytes and content type.
   */
  set(key, value) {
    if (this.limit === 0) return
    this.#entries.delete(key)
    this.#entries.set(key, value)
    while (this.#entries.size > this.limit) {
      const oldest = this.#entries.keys().next()
      if (oldest.done === true) break
      this.#entries.delete(oldest.value)
    }
  }
}

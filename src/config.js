/**
 * Configuration defaults, normalization, and loud validation for the whale-pet
 * plugin. The plugin deliberately exports no Schemastery `Config` schema: it is
 * shipped as plain ESM with no build step and no runtime dependency on a
 * Schemastery instance, so the row config arrives unvalidated and is checked
 * here instead. Invalid values fail plugin activation with a precise message
 * (the Harness convention: configuration errors must be loud).
 *
 * @module dsh-whale-pet/src/config
 */

/** Bridge port used when neither config nor environment pin one. */
export const DEFAULT_PORT = 4571

/**
 * The complete default configuration. Every tunable is present so a user can
 * change any of them from `cordis.patch.yml` without touching code.
 */
export const DEFAULT_CONFIG = Object.freeze({
  /** Master switch: turn every tool and the pet window off without uninstalling. */
  enabled: true,
  /** Loopback host for the pet bridge. Never widened to a routable address. */
  host: '127.0.0.1',
  /** Bridge port; `0` asks the OS for a free port (the effective port is logged). */
  port: DEFAULT_PORT,
  /** Shared secret for bridge requests; empty generates a fresh one per boot. */
  token: '',
  /** Start the desktop window together with the DSH process. */
  autoLaunch: true,
  /** Absolute path to the window launcher; empty uses the bundled script. */
  launcher: '',
  /** Extra arguments appended to the launcher command line. */
  launcherArgs: [],
  /** Kills the pet window when the plugin unloads. */
  stopOnUnload: true,
  window: {
    width: 320,
    height: 420,
    /** Gap between the window and the work-area corner, in pixels. */
    margin: 24,
    /** Corner the window starts in: bottom-right | bottom-left | top-right | top-left. */
    corner: 'bottom-right',
    alwaysOnTop: true,
    /** Window opacity, 0.2 - 1. */
    opacity: 1,
    /** Start hidden and let the tray/agent show it. */
    startHidden: false,
  },
  voice: {
    enabled: true,
    /**
     * How a reply becomes sound:
     *   browser — the window's own speech synthesis (the default);
     *   http    — ask the `http` provider below for audio and play that. This is
     *             how a 曼波-style voice model (Fish Audio, GPT-SoVITS,
     *             Bert-VITS2, …) is wired in.
     */
    engine: 'browser',
    /** Remote or local speech-synthesis provider used when `engine` is `http`. */
    http: {
      /** Endpoint; may contain `{{text}}`, substituted URL-encoded. */
      url: '',
      /** POST (JSON body) or GET (query string only). */
      method: 'POST',
      /** Request headers, e.g. `authorization: 'Bearer …'`. Never reach the window. */
      headers: {},
      /**
       * Request body template for POST. `{{text}}` is substituted JSON-escaped
       * without its surrounding quotes, so `{"text":"{{text}}"}` stays valid JSON.
       */
      body: '{"text":"{{text}}"}',
      /** Dotted path into a JSON response holding the audio, e.g. `data.audio`. */
      audioPath: '',
      /** How that value carries the audio: base64 bytes, or a URL to fetch. */
      audioEncoding: 'base64',
      /** Container the provider returns; the window plays it as-is. */
      format: 'mp3',
      /** Request deadline in milliseconds. */
      timeoutMs: 30000,
      /** Synthesized clips kept in memory, keyed by exact text (0 disables). */
      cacheEntries: 64,
    },
    /** BCP-47 tag handed to the browser speech synthesizer. */
    lang: 'zh-CN',
    /** Preferred voice name; empty picks the best match for `lang`. */
    voice: '',
    rate: 1.05,
    pitch: 1.25,
    volume: 1,
    /** Longest text handed to one utterance; longer replies are split. */
    maxChars: 240,
    /** Speak the model's settled replies. */
    speakReplies: true,
    /**
     * Default sound effect for every reply, as a path relative to `pet/`
     * (e.g. `assets/audio/manbo.mp3`). When set, the window boots in effect mode
     * and plays that clip instead of synthesizing; the right-click 声音 sidebar
     * still switches between the `src/config.yml` entries at runtime.
     */
    effectFile: '',
  },
  asr: {
    enabled: true,
    lang: 'zh-CN',
    /** auto | webspeech | sapi — `auto` prefers the browser engine, then Windows SAPI. */
    engine: 'auto',
    /** Hard cap for one recording, in seconds; the window enforces it as well. */
    maxSeconds: 20,
  },
  session: {
    /** active | pinned | none — which conversation the pet speaks for. */
    mode: 'active',
    /** Session id used by `pinned`. */
    id: '',
  },
  /** Ask the user before a tool class runs; unused classes stay unprompted. */
  approval: {
    input: false,
    media: false,
    notify: false,
    window: false,
  },
  tools: {
    media: true,
    input: true,
    notify: true,
    look: true,
    control: true,
    say: true,
  },
  /** Milliseconds a PowerShell helper may run before it is killed. */
  helperTimeoutMs: 20000,
  /** Log bridge traffic and forwarded session events. */
  debug: false,
})

/** Raised for a configuration value the plugin cannot honor. */
export class ConfigError extends Error {
  /** @param message - what is wrong and which key carries it. */
  constructor(message) {
    super(`whale-pet config: ${message}`)
    this.name = 'ConfigError'
  }
}

const isPlainObject = value =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Merge one user section over its defaults, rejecting unknown or mistyped keys.
 *
 * Nested sections recurse, so a user who sets one `voice.http` key keeps every
 * other default in that section and still gets unknown-key diagnostics.
 * @param section - dotted section name used in diagnostics.
 * @param defaults - the default object for that section.
 * @param input - user-supplied value, or undefined.
 * @returns the merged section.
 */
function mergeSection(section, defaults, input) {
  if (input === undefined || input === null) {
    return Object.fromEntries(Object.entries(defaults).map(([key, value]) => [
      key,
      isPlainObject(value) ? mergeSection(`${section}.${key}`, value, undefined) : value,
    ]))
  }
  if (!isPlainObject(input)) throw new ConfigError(`${section} must be an object`)
  const merged = { ...defaults }
  for (const [key, value] of Object.entries(input)) {
    if (!(key in defaults)) {
      throw new ConfigError(`unknown key ${section}.${key}`)
    }
    const expected = defaults[key]
    if (isPlainObject(expected)) {
      // An empty object default is a free-form map — request headers, where the
      // user picks the keys — not a section with a fixed shape. Recursing into it
      // would reject every key the user supplies, which is exactly what happened
      // to `voice.http.headers` before this rule existed.
      merged[key] = Object.keys(expected).length === 0
        ? mergeMap(`${section}.${key}`, value)
        : mergeSection(`${section}.${key}`, expected, value)
      continue
    }
    if (typeof expected === 'boolean' && typeof value !== 'boolean') {
      throw new ConfigError(`${section}.${key} must be a boolean`)
    }
    if (typeof expected === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new ConfigError(`${section}.${key} must be a finite number`)
    }
    if (typeof expected === 'string' && typeof value !== 'string') {
      throw new ConfigError(`${section}.${key} must be a string`)
    }
    merged[key] = value
  }
  return merged
}

/**
 * Accept a free-form map, such as a set of request headers.
 *
 * The shape is the user's to choose; value types are checked where the map is
 * interpreted (see the `voice.http.headers` validation in `resolveConfig`).
 * @param section - dotted name used in diagnostics.
 * @param input - user-supplied value.
 * @returns a copy of the map.
 */
function mergeMap(section, input) {
  if (input === undefined || input === null) return {}
  if (!isPlainObject(input)) throw new ConfigError(`${section} must be an object`)
  return { ...input }
}

/**
 * Clamp one number into an inclusive range.
 * @param value - candidate value.
 * @param min - lower bound.
 * @param max - upper bound.
 * @returns the clamped value.
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/**
 * Normalize a raw row config into the runtime configuration.
 * @param raw - the `config` block of the plugin row, or undefined.
 * @param env - process environment, read for `DSH_WHALE_PET_*` overrides.
 * @returns a frozen, validated configuration.
 * @throws {ConfigError} when a value cannot be honored.
 */
export function resolveConfig(raw, env = {}) {
  if (raw !== undefined && raw !== null && !isPlainObject(raw)) {
    throw new ConfigError('the plugin row config must be an object')
  }
  const input = raw ?? {}
  const known = new Set(Object.keys(DEFAULT_CONFIG))
  for (const key of Object.keys(input)) {
    if (!known.has(key)) throw new ConfigError(`unknown key ${key}`)
  }
  const config = { ...DEFAULT_CONFIG }
  for (const [key, value] of Object.entries(input)) {
    if (isPlainObject(DEFAULT_CONFIG[key])) continue
    const expected = DEFAULT_CONFIG[key]
    if (typeof expected === 'boolean' && typeof value !== 'boolean') {
      throw new ConfigError(`${key} must be a boolean`)
    }
    if (typeof expected === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new ConfigError(`${key} must be a finite number`)
    }
    if (typeof expected === 'string' && typeof value !== 'string') {
      throw new ConfigError(`${key} must be a string`)
    }
    if (Array.isArray(expected) && !Array.isArray(value)) {
      throw new ConfigError(`${key} must be an array`)
    }
    config[key] = value
  }
  for (const section of ['window', 'voice', 'asr', 'session', 'approval', 'tools']) {
    config[section] = mergeSection(section, DEFAULT_CONFIG[section], input[section])
  }

  // Environment overrides keep a deployment tunable without editing the profile.
  if (env.DSH_WHALE_PET_PORT !== undefined && input.port === undefined) {
    const port = Number(env.DSH_WHALE_PET_PORT)
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new ConfigError('DSH_WHALE_PET_PORT must be an integer port')
    }
    config.port = port
  }
  if (env.DSH_WHALE_PET_DISABLE === '1') config.enabled = false
  if (env.DSH_WHALE_PET_AUTOLAUNCH === '0') config.autoLaunch = false

  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new ConfigError('port must be an integer between 0 and 65535')
  }
  if (config.host !== '127.0.0.1' && config.host !== 'localhost' && config.host !== '::1') {
    throw new ConfigError('host must be a loopback address (127.0.0.1, localhost, or ::1)')
  }
  config.helperTimeoutMs = clamp(config.helperTimeoutMs, 1000, 120000)
  config.window.width = clamp(config.window.width, 160, 1200)
  config.window.height = clamp(config.window.height, 160, 1200)
  config.window.margin = clamp(config.window.margin, 0, 400)
  config.window.opacity = clamp(config.window.opacity, 0.2, 1)
  if (!['bottom-right', 'bottom-left', 'top-right', 'top-left'].includes(config.window.corner)) {
    throw new ConfigError('window.corner must be bottom-right, bottom-left, top-right, or top-left')
  }
  config.voice.rate = clamp(config.voice.rate, 0.5, 2)
  config.voice.pitch = clamp(config.voice.pitch, 0.5, 2)
  config.voice.volume = clamp(config.voice.volume, 0, 1)
  config.voice.maxChars = clamp(config.voice.maxChars, 40, 2000)
  if (!['browser', 'http'].includes(config.voice.engine)) {
    throw new ConfigError('voice.engine must be browser or http')
  }
  const voiceHttp = config.voice.http
  voiceHttp.method = voiceHttp.method.toUpperCase()
  if (!['GET', 'POST'].includes(voiceHttp.method)) {
    throw new ConfigError('voice.http.method must be GET or POST')
  }
  if (!['base64', 'url'].includes(voiceHttp.audioEncoding)) {
    throw new ConfigError('voice.http.audioEncoding must be base64 or url')
  }
  for (const [name, value] of Object.entries(voiceHttp.headers)) {
    if (typeof value !== 'string') {
      throw new ConfigError(`voice.http.headers.${name} must be a string`)
    }
  }
  voiceHttp.timeoutMs = clamp(voiceHttp.timeoutMs, 1000, 120000)
  voiceHttp.cacheEntries = clamp(voiceHttp.cacheEntries, 0, 512)
  if (config.voice.engine === 'http' && voiceHttp.url.trim() === '') {
    // Failing here beats a window that silently never speaks.
    throw new ConfigError('voice.http.url is required when voice.engine is http')
  }
  config.asr.maxSeconds = clamp(config.asr.maxSeconds, 3, 120)
  if (!['auto', 'webspeech', 'sapi'].includes(config.asr.engine)) {
    throw new ConfigError('asr.engine must be auto, webspeech, or sapi')
  }
  if (!['active', 'pinned', 'none'].includes(config.session.mode)) {
    throw new ConfigError('session.mode must be active, pinned, or none')
  }
  if (config.session.mode === 'pinned' && config.session.id.trim() === '') {
    throw new ConfigError('session.id is required when session.mode is pinned')
  }
  if (!Array.isArray(config.launcherArgs) || config.launcherArgs.some(arg => typeof arg !== 'string')) {
    throw new ConfigError('launcherArgs must be an array of strings')
  }
  return Object.freeze({
    ...config,
    window: Object.freeze(config.window),
    voice: Object.freeze({
      ...config.voice,
      http: Object.freeze({ ...config.voice.http, headers: Object.freeze({ ...config.voice.http.headers }) }),
    }),
    asr: Object.freeze(config.asr),
    session: Object.freeze(config.session),
    approval: Object.freeze(config.approval),
    tools: Object.freeze(config.tools),
    launcherArgs: Object.freeze([...config.launcherArgs]),
  })
}

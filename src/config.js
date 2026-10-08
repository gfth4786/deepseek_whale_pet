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
    /** BCP-47 tag handed to the speech synthesizer. */
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
 * @param section - dotted section name used in diagnostics.
 * @param defaults - the default object for that section.
 * @param input - user-supplied value, or undefined.
 * @returns the merged section.
 */
function mergeSection(section, defaults, input) {
  if (input === undefined || input === null) return { ...defaults }
  if (!isPlainObject(input)) throw new ConfigError(`${section} must be an object`)
  const merged = { ...defaults }
  for (const [key, value] of Object.entries(input)) {
    if (!(key in defaults)) {
      throw new ConfigError(`unknown key ${section}.${key}`)
    }
    const expected = defaults[key]
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
    voice: Object.freeze(config.voice),
    asr: Object.freeze(config.asr),
    session: Object.freeze(config.session),
    approval: Object.freeze(config.approval),
    tools: Object.freeze(config.tools),
    launcherArgs: Object.freeze([...config.launcherArgs]),
  })
}

/**
 * DeepSeek whale-girl desktop pet — the DSH plugin half.
 *
 * What this plugin owns:
 *
 * 1. A loopback bridge (`src/bridge.js`) that serves the pet window document and
 *    carries every host ↔ pet message: assistant replies to speak, tool activity
 *    for the status line, and the user's typed or spoken line back into a session.
 * 2. A desktop window process (`src/pet-process.js` → `scripts/launch-pet.mjs`):
 *    Electron when available, a Chromium app window otherwise.
 * 3. Model-facing tools: media/volume, keyboard and mouse automation, system
 *    notifications, a read-only desktop snapshot, plus tools that drive the pet
 *    itself (`pet_say`, `pet_mood`, `pet_window`).
 *
 * The plugin is plain ESM with no build step and imports nothing from the
 * harness packages, so it loads straight from the profile as a bundle row. The
 * only runtime dependency is Node itself plus the bundled PowerShell helpers.
 *
 * @module dsh-whale-pet
 */

import { resolveConfig } from './src/config.js'
import { loadPetConfig } from './src/pet-config.js'
import { PetBridge } from './src/bridge.js'
import { SessionWatcher } from './src/session-watch.js'
import { PetProcess } from './src/pet-process.js'
import { WINDOWS_POWERSHELL, runHelper } from './src/win32/run.js'
import { TtsCache, synthesize } from './src/tts.js'
import { pcTools } from './src/tools/pc.js'
import { petTools } from './src/tools/pet.js'

/** Cordis plugin name shown in plugin inventories and diagnostics. */
export const name = 'whale-pet'

/** Required services: the tool registry and the agent registry the pet watches. */
export const inject = ['tools', 'agents']

/** Largest recording handed to the offline recognizer. */
const ASR_MAX_BYTES = 8 * 1024 * 1024

/**
 * Register the pet: bridge, tools, window, and conversation mirror.
 * @param ctx - the Cordis context of this plugin row.
 * @param rawConfig - the row's `config` block, validated here.
 * @returns completion once the bridge is listening and the tools are registered.
 */
export async function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig, process.env)
  const log = createLogger(ctx, config)
  if (!config.enabled) {
    log('disabled by config; no bridge, tools, or window started')
    return
  }

  // The right-click sidebar's action + voice catalogue, from src/config.yml.
  const petConfig = await loadPetConfig(log)

  const watcher = new SessionWatcher({ ctx, config, bridge: undefined, log })
  // Synthesized clips repeat (a retried turn, a re-read line), and the round trip
  // is the slowest part of speaking, so successful clips are kept.
  const ttsCache = new TtsCache(config.voice.http.cacheEntries)
  const bridge = new PetBridge({
    host: config.host,
    port: config.port,
    token: config.token,
    log,
    snapshot: () => ({
      ...watcher.snapshot(),
      actions: petConfig.actions,
      voices: petConfig.voices,
      clients: bridge.clientCount,
    }),
    onMessage: ({ text, source }) => watcher.sendUserText(text, source),
    onClientEvent: (event) => onClientEvent(event, log),
    onAsr: async ({ audio, lang }) => transcribe({ audio, lang, config, log }),
    onTts: async ({ text }) => {
      const cached = ttsCache.get(text)
      if (cached !== undefined) return cached
      const clip = await synthesize({ text, http: config.voice.http, log })
      ttsCache.set(text, clip)
      return clip
    },
  })
  watcher.bridge = bridge

  const port = await bridge.start()
  const petProcess = new PetProcess({
    config,
    url: bridge.petUrl,
    log,
    onExit: () => {
      log('the pet window closed')
    },
  })

  const publish = (type, payload) => bridge.publish(type, payload)
  const deps = { ctx, config, log, publish, bridge, petProcess }

  watcher.attach()
  const registered = []
  if (config.tools.media || config.tools.input || config.tools.notify || config.tools.look) {
    for (const tool of pcTools(deps)) {
      if (!toolEnabled(tool.name, config)) continue
      registered.push(tool.name)
      ctx.tools.register(tool)
    }
  }
  if (config.tools.say || config.tools.control) {
    for (const tool of petTools(deps)) {
      if (!toolEnabled(tool.name, config)) continue
      registered.push(tool.name)
      ctx.tools.register(tool)
    }
  }

  if (config.autoLaunch) {
    try {
      const pid = petProcess.start()
      log(pid === undefined ? 'pet window already running' : `pet window started (pid ${pid})`)
    } catch (error) {
      // A missing Electron install must not take the whole plugin down: the
      // tools and the bridge are still useful, and the launcher explains itself.
      log(`pet window not started: ${error.message}`)
    }
  }

  ctx.effect(() => () => {
    if (config.stopOnUnload) {
      void petProcess.stop()
    }
    return bridge.stop()
  }, 'whale-pet: bridge and window teardown')

  log(
    `ready — bridge http://${config.host}:${port} (token ${config.token.length > 0 ? 'from config' : 'generated'}), `
    + `tools: ${registered.join(', ') || 'none'}`,
  )
}

/**
 * Whether one tool is enabled by the configuration.
 * @param toolName - the registered tool name.
 * @param config - resolved plugin configuration.
 * @returns true when the tool's class is switched on.
 */
function toolEnabled(toolName, config) {
  switch (toolName) {
    case 'pet_media': return config.tools.media
    case 'pet_input': return config.tools.input
    case 'pet_notify': return config.tools.notify
    case 'pet_look': return config.tools.look
    case 'pet_say': return config.tools.say
    case 'pet_mood': return config.tools.say
    case 'pet_window': return config.tools.control
    default: return true
  }
}

/**
 * Handle one lifecycle event reported by the pet window.
 * @param event - the parsed request body.
 * @param log - log sink.
 */
function onClientEvent(event, log) {
  const type = typeof event?.type === 'string' ? event.type : 'unknown'
  if (type === 'error') {
    log(`pet window reported an error: ${String(event?.message ?? '')}`)
    return
  }
  log(`pet window event: ${type}${event?.mood === undefined ? '' : ` (${String(event.mood)})`}`)
}

/**
 * Transcribe one recording with the offline Windows recognizer.
 * @param options - audio bytes, requested language, config, and log sink.
 * @returns the transcript payload.
 * @throws {Error} when the clip is unusable or the recognizer is missing.
 */
async function transcribe({ audio, lang, config, log }) {
  if (!config.asr.enabled) throw new Error('语音识别已在配置中关闭')
  if (!Buffer.isBuffer(audio) || audio.length === 0) throw new Error('录音为空')
  if (audio.length > ASR_MAX_BYTES) throw new Error('录音太大，请说得短一点')
  const value = await runHelper('asr', {
    audioBase64: audio.toString('base64'),
    lang: lang ?? config.asr.lang,
  }, { executable: WINDOWS_POWERSHELL, timeoutMs: Math.max(config.helperTimeoutMs, config.asr.maxSeconds * 1000) })
  log(`asr -> ${JSON.stringify(value).slice(0, 200)}`)
  return value
}

/**
 * Build the plugin's logger.
 *
 * Every line goes to the Cordis logger. With `debug: true` it also goes to
 * stderr, because a plugin's own service logger is only surfaced when a
 * deployment mounts a log exporter — and "why is my pet not there?" is exactly
 * the question debug logging has to answer on a stock install.
 * @param ctx - the plugin context.
 * @param config - resolved plugin configuration.
 * @returns a log sink that prefixes every line and honors the debug switch.
 */
function createLogger(ctx, config) {
  const logger = ctx.logger
  return (message) => {
    const line = `[whale-pet] ${message}`
    try {
      if (config.debug) console.error(line)
      logger?.info?.(line)
    } catch {
      // Logging must never break the plugin.
    }
  }
}

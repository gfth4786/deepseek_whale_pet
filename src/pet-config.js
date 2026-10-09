/**
 * Load the desk-pet's sidebar catalogue from `src/config.yml`.
 *
 * The file lists the actions (sprite sequences) and voices (TTS) the user can
 * pick from the right-click sidebar. The plugin is zero-runtime-dependency and
 * Node ships no YAML parser, so this parses a deliberately small, documented
 * subset — just the two top-level sections and `- key: value` list items — and
 * validates the entries. A missing or malformed file must not take the whole pet
 * down, so it falls back to the built-in six actions (no voices) with a warning,
 * mirroring how a missing Electron install degrades gracefully.
 *
 * @module dsh-whale-pet/src/pet-config
 */

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** Absolute path of the sidebar config, next to this module. */
export const CONFIG_FILE = resolve(HERE, 'config.yml')

/** Built-in fallback catalogue when `config.yml` is missing or invalid. */
const DEFAULT_ACTIONS = Object.freeze([
  { id: 'eat_token', name: '吃 token', folder: 'assets/whale/eat_token' },
  { id: 'working', name: '干活', folder: 'assets/whale/working' },
  { id: 'idle', name: '发呆', folder: 'assets/whale/idle' },
  { id: 'happy', name: '开心', folder: 'assets/whale/happy' },
  { id: 'sleepy', name: '困了', folder: 'assets/whale/sleepy' },
  { id: 'surprised', name: '惊讶', folder: 'assets/whale/surprised' },
])

/**
 * Parse and validate the config text into `{ actions, voices }`.
 *
 * Each action keeps `{ id, name, folder }`. Each voice keeps
 * `{ id, name, kind, voice, lang, file }` where `kind` is `'tts'` (synthesize
 * the reply, the default) or `'effect'` (play one sound clip instead of
 * speaking, which is how a meme voice pack is wired up). A `tts` voice may leave
 * `voice` empty to mean "any installed voice for `lang`"; an `effect` voice must
 * name a `file`, relative to `pet/`. Entries missing a required field are
 * dropped silently. Throws when no usable action survives, so the caller can
 * fall back to the defaults.
 *
 * @param text - the raw YAML text.
 * @returns the validated catalogue.
 * @throws {Error} when the text yields no usable action.
 */
export function parsePetConfig(text) {
  const { actions, voices } = parseSections(text)
  const usableActions = actions.map(entry => ({
    id: str(entry.id),
    name: str(entry.name),
    folder: str(entry.folder),
  })).filter(action => action.id.length > 0 && action.name.length > 0 && action.folder.length > 0)
  const usableVoices = voices.map(entry => ({
    id: str(entry.id),
    name: str(entry.name),
    kind: str(entry.kind).toLowerCase() === 'effect' ? 'effect' : 'tts',
    voice: str(entry.voice),
    lang: str(entry.lang) || 'zh-CN',
    file: str(entry.file),
  })).filter(voice => voice.id.length > 0 && voice.name.length > 0
    // An effect without a clip is unusable, so it is dropped like any other
    // entry missing a required field; a tts voice may legitimately name none.
    && (voice.kind === 'tts' || voice.file.length > 0))
  if (usableActions.length === 0) throw new Error('config.yml 里没有可用的动作')
  return { actions: usableActions, voices: usableVoices }
}

/**
 * Load the sidebar config from disk, falling back to defaults on any failure.
 *
 * @param log - warning sink, e.g. the plugin's own logger.
 * @param filePath - config path override (used by tests).
 * @returns the catalogue, always non-empty actions.
 */
export async function loadPetConfig(log = () => {}, filePath = CONFIG_FILE) {
  let text
  try {
    text = await readFile(filePath, 'utf8')
  } catch (error) {
    log(`config.yml 未找到或不可读（${String(error?.message ?? error)}），使用内置默认动作`)
    return { actions: DEFAULT_ACTIONS, voices: [] }
  }
  try {
    return parsePetConfig(text)
  } catch (error) {
    log(`config.yml 解析失败（${String(error?.message ?? error)}），使用内置默认动作`)
    return { actions: DEFAULT_ACTIONS, voices: [] }
  }
}

/**
 * Split the supported YAML subset into raw `{ actions, voices }` entry lists.
 * Understands `#` comment lines, `actions:` / `voices:` headers, and
 * `- key: value` items followed by indented `key: value` fields.
 * @param text - the raw YAML text.
 * @returns raw parsed entries (unvalidated).
 */
function parseSections(text) {
  const actions = []
  const voices = []
  let section = null
  let current = null
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trimEnd()
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue

    if (/^actions:\s*$/.test(line)) { section = 'actions'; current = null; continue }
    if (/^voices:\s*$/.test(line)) { section = 'voices'; current = null; continue }

    if (trimmed.startsWith('-')) {
      const entry = {}
      const kv = splitKeyValue(trimmed.slice(1).trim())
      if (kv !== null) entry[kv.key] = kv.value
      if (section === 'actions') { actions.push(entry); current = entry }
      else if (section === 'voices') { voices.push(entry); current = entry }
      else current = null
      continue
    }

    if (current !== null) {
      const kv = splitKeyValue(trimmed)
      if (kv !== null) current[kv.key] = kv.value
    }
  }
  return { actions, voices }
}

/**
 * Split `key: value` on the first colon, trimming and unquoting the value.
 * @param text - one `key: value` fragment.
 * @returns `{ key, value }`, or null when there is no colon or key.
 */
function splitKeyValue(text) {
  const index = text.indexOf(':')
  if (index < 0) return null
  const key = text.slice(0, index).trim()
  if (key.length === 0) return null
  return { key, value: unquote(text.slice(index + 1).trim()) }
}

/** Strip one pair of matching surrounding quotes, when present. */
function unquote(value) {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

/** Coerce a parsed value to a trimmed string. */
function str(value) {
  return typeof value === 'string' ? value.trim() : ''
}

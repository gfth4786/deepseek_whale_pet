/**
 * The pet window's behaviour.
 *
 * One document, three jobs: render the whale-girl and her expressions, speak and
 * listen, and be the user's way into the conversation the pet is watching. All
 * host traffic rides the plugin's loopback bridge — a Server-Sent Events stream
 * for everything the host pushes, and small JSON posts for everything the pet
 * sends back.
 */

/** Boot data injected by the bridge: the per-boot token and current state. */
function readBoot() {
  const node = document.getElementById('whale-pet-boot')
  if (node === null) return { token: '', state: {} }
  try {
    const parsed = JSON.parse(node.textContent ?? '{}')
    return { token: typeof parsed.token === 'string' ? parsed.token : '', state: parsed.state ?? {} }
  } catch {
    return { token: '', state: {} }
  }
}

const boot = readBoot()
const TOKEN = boot.token
const INITIAL = boot.state

/** Build one bridge URL with the per-boot token attached. */
const api = (path, extra = {}) => {
  const url = new URL(`/api/${path}`, globalThis.location.origin)
  url.searchParams.set('token', TOKEN)
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, String(value))
  return url.toString()
}

const el = {
  app: document.getElementById('app'),
  character: document.getElementById('character'),
  eatToken: document.getElementById('eat-token'),
  bubble: document.getElementById('bubble'),
  bubbleText: document.getElementById('bubble-text'),
  bubbleMeta: document.getElementById('bubble-meta'),
  busy: document.getElementById('busy'),
  busyLabel: document.getElementById('busy-label'),
  composer: document.getElementById('composer'),
  input: document.getElementById('input'),
  send: document.getElementById('send'),
  mic: document.getElementById('mic'),
  sidebar: document.getElementById('sidebar'),
  toast: document.getElementById('toast'),
}

/**
 * Voice settings, merged with anything the host sends later.
 *
 * `kind` selects how a reply is voiced: `tts` synthesizes the text, `effect`
 * plays one sound clip instead (a meme voice pack such as 曼波). The sidebar's
 * 声音 section switches between catalogue entries, which set these fields.
 */
const voice = {
  enabled: INITIAL.voice?.enabled !== false,
  lang: INITIAL.voice?.lang ?? 'zh-CN',
  name: INITIAL.voice?.voice ?? '',
  rate: Number(INITIAL.voice?.rate ?? 1.05),
  pitch: Number(INITIAL.voice?.pitch ?? 1.25),
  volume: Number(INITIAL.voice?.volume ?? 1),
  muted: false,
  /** Selected catalogue entry id, for persisting the choice across restarts. */
  id: '',
  /** `tts` | `effect`. */
  kind: 'tts',
  /** Clip path relative to `pet/`, for `kind: 'effect'`. */
  file: '',
  /** `browser` (window synthesis) or `http` (the host's speech provider). */
  engine: INITIAL.voice?.engine === 'http' ? 'http' : 'browser',
  /** Chunk budget for one provider request. */
  maxChars: Number(INITIAL.voice?.maxChars) > 0 ? Number(INITIAL.voice.maxChars) : 240,
}

/** Speech-recognition settings. */
const asr = {
  enabled: INITIAL.asr?.enabled !== false,
  lang: INITIAL.asr?.lang ?? 'zh-CN',
  engine: INITIAL.asr?.engine ?? 'auto',
  // The host sends its configured cap; 20s is the deployment default.
  maxSeconds: Number(INITIAL.asr?.maxSeconds) > 0 ? Number(INITIAL.asr.maxSeconds) : 20,
}

const MOODS = ['idle', 'happy', 'thinking', 'working', 'sleepy', 'surprised']

/** Sidebar actions from the host config: sprite sequences the user can pick. */
const ACTIONS = (Array.isArray(INITIAL.actions) ? INITIAL.actions : [])
  .filter(action => action && typeof action.folder === 'string' && typeof action.name === 'string')
/** Sidebar voices from the host config: sound entries the user can pick. */
const VOICES = (Array.isArray(INITIAL.voices) ? INITIAL.voices : [])
  .filter(entry => entry && typeof entry.id === 'string' && typeof entry.name === 'string')

/** localStorage key holding the id of the voice the user picked last. */
const VOICE_KEY = 'dsh-whale-pet.voice'

// The deployment may pin a sound effect as the default (voice.effectFile), in
// which case every reply plays it until the sidebar picks something else.
if (typeof INITIAL.voice?.effectFile === 'string' && INITIAL.voice.effectFile.trim().length > 0) {
  voice.kind = 'effect'
  voice.file = INITIAL.voice.effectFile.trim()
}

/** Mood → the folder path under pet/ that holds its frame sequence. */
function moodFolder(mood) {
  return `assets/whale/${mood === 'thinking' ? 'eat_token' : mood}`
}

// ── sprite animation player ───────────────────────────────────────────────────

/**
 * Plays PNG frame sequences from `pet/assets/whale/<folder>/`.
 * Each folder must contain `manifest.json` plus `frame_0000.png` … `frame_NNNN.png`.
 * The player preloads every mood's and every configured action's sequence at
 * startup; `setMood()` switches to a mood's sequence automatically, and the
 * right-click sidebar plays an action's sequence directly. When a sequence is
 * not available the SVG + CSS fallback still works.
 *
 * Mood → folder mapping:
 *   idle      → idle/
 *   happy     → happy/
 *   thinking  → eat_token/
 *   working   → working/
 *   sleepy    → sleepy/
 *   surprised → surprised/
 */
const spriteAnim = {
  /** @type {Map<string, { manifest: object, frames: HTMLImageElement[], loaded: number } | null>} */
  sets: new Map(),
  /** The folder whose set is currently playing, or null when idle/SVG. */
  current: null,
  playing: false,
  raf: 0,
  index: 0,
  startTime: 0,

  /**
   * Kick off background preloads for every mood folder plus every configured
   * action folder.  Safe to call more than once; a second call is a no-op for
   * each already-attempted folder.
   */
  warm() {
    const folders = new Set()
    for (const mood of MOODS) folders.add(moodFolder(mood))
    for (const action of ACTIONS) folders.add(action.folder)
    for (const folder of folders) void this._loadSet(folder)
  },

  /** Load one folder set. A missing manifest marks the folder as unavailable.
   * Once loaded, if the folder matches the current mood, auto-switch from SVG
   * to sprite. */
  async _loadSet(folder) {
    if (this.sets.has(folder)) return
    let data
    try {
      const resp = await fetch(`/pet/${folder}/manifest.json`, { cache: 'no-store' })
      data = await resp.json()
    } catch {
      this.sets.set(folder, null)
      return
    }
    if (typeof data?.frames !== 'number' || data.frames <= 0) {
      this.sets.set(folder, null)
      return
    }
    const entry = { manifest: data, frames: new Array(data.frames).fill(null), loaded: 0 }
    this.sets.set(folder, entry)
    this._preloadBatch(folder, entry, 0)
    // If this folder backs the currently displayed mood, switch over.
    if (moodFolder(el.app.dataset.mood) === folder && !this.playing) {
      this.switchTo(folder)
    }
  },

  /** Recursively preload frames 20 at a time. */
  _preloadBatch(folder, entry, start) {
    const batch = 20
    const end = Math.min(start + batch, entry.manifest.frames)
    let pending = end - start
    if (pending === 0) return
    for (let i = start; i < end; i++) {
      const img = new Image()
      img.onload = img.onerror = () => {
        entry.frames[i] = img
        entry.loaded += 1
        pending -= 1
        if (pending === 0 && end < entry.manifest.frames) {
          this._preloadBatch(folder, entry, end)
        }
      }
      img.src = `/pet/${folder}/frame_${String(i).padStart(4, '0')}.png`
    }
  },

  /** Whether a sprite set is loaded for this folder. */
  has(folder) {
    const set = this.sets.get(folder)
    return set !== undefined && set !== null
  },

  /**
   * Switch the displayed animation to `folder`.  Stops whatever was playing
   * and starts the new sequence from frame 0.  Does nothing when `folder` has
   * no sprite set.
   */
  switchTo(folder) {
    this.stop()
    const set = this.sets.get(folder)
    if (set === undefined || set === null) return
    this.current = folder
    this.playing = true
    this.index = 0
    this.startTime = 0
    el.app.classList.add('sprite--active')
    this._tick()
  },

  /** Stop playback and restore the SVG character. */
  stop() {
    if (!this.playing) return
    this.playing = false
    this.current = null
    cancelAnimationFrame(this.raf)
    this.raf = 0
    el.app.classList.remove('sprite--active')
  },

  _tick(now = performance.now()) {
    if (!this.playing) return
    this.raf = requestAnimationFrame((t) => { this._tick(t) })
    if (this.startTime === 0) this.startTime = now

    const set = this.current === null ? null : this.sets.get(this.current)
    if (set === undefined || set === null) return
    const fps = set.manifest.fps ?? 24
    const total = set.manifest.frames ?? 1
    const elapsed = now - this.startTime
    const desired = Math.floor(elapsed / (1000 / fps)) % total

    if (desired !== this.index) {
      this.index = desired
      const frame = this._readyFrame(set, desired)
      if (frame !== null) el.eatToken.src = frame.src
    }
  },

  _readyFrame(set, index) {
    const exact = set.frames[index]
    if (exact !== null && exact.complete && exact.naturalWidth > 0) return exact
    for (let d = 1; d < set.frames.length; d++) {
      const prev = set.frames[index - d]
      if (prev !== null && prev.complete && prev.naturalWidth > 0) return prev
      const next = set.frames[index + d]
      if (next !== null && next.complete && next.naturalWidth > 0) return next
    }
    return null
  },
}

// ── character ───────────────────────────────────────────────────────────────

/**
 * Inline the character art so CSS can animate individual parts and switch
 * expression layers. The artwork ships one group per mood; the inline
 * `display` styles it carries are dropped here so the stylesheet owns the switch.
 *
 * PNG artwork wins when it is present: dropping `idle.png`, `happy.png`, … into
 * `pet/assets/whale/png/` replaces the vector character without touching code.
 * `idle.png` doubles as the fallback for a mood that has no image of its own.
 */
async function mountCharacter() {
  let markup = ''
  try {
    const response = await fetch('/pet/assets/whale/whale-girl.svg', { cache: 'no-store' })
    if (response.ok) markup = await response.text()
  } catch {
    markup = ''
  }
  if (markup.trim().length === 0) {
    // A missing asset must not leave an empty window: draw a placeholder whale.
    markup = PLACEHOLDER_WHALE
  }
  el.character.innerHTML = markup
  for (const group of el.character.querySelectorAll('[id^="exp-"]')) {
    group.removeAttribute('style')
  }
  // Drop any fixed width/height so the CSS box decides the size.
  const svg = el.character.querySelector('svg')
  if (svg !== null) {
    svg.setAttribute('width', '100%')
    svg.setAttribute('height', '100%')
    svg.setAttribute('preserveAspectRatio', 'xMidYMax meet')
  }
  await mountPngArtwork()
}

/**
 * Prefer PNG artwork when the user has dropped some in, one image per mood.
 */
async function mountPngArtwork() {
  const available = new Map()
  await Promise.all(MOODS.map(async (mood) => {
    const url = `/pet/assets/whale/png/${mood}.png`
    try {
      const response = await fetch(url, { method: 'HEAD', cache: 'no-store' })
      if (response.ok) available.set(mood, url)
    } catch {
      // No PNG for this mood; the vector character stays in charge.
    }
  }))
  if (available.size === 0) return
  const fallback = available.get('idle') ?? [...available.values()][0]
  for (const mood of MOODS) {
    const image = document.createElement('img')
    image.className = 'character__png'
    image.dataset.mood = mood
    image.src = available.get(mood) ?? fallback
    image.alt = ''
    image.draggable = false
    el.character.append(image)
  }
  el.character.classList.add('character--png')
  report('art', `PNG artwork in use (${[...available.keys()].join(', ')})`)
}

/** Minimal stand-in character used only when the art file cannot be loaded. */
const PLACEHOLDER_WHALE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" width="100%" height="100%">
<g id="whale-root">
<ellipse id="whale-shadow" cx="150" cy="276" rx="78" ry="12" fill="#00000022"/>
<g id="whale-body"><ellipse cx="150" cy="190" rx="88" ry="76" fill="#4d6bfe"/><ellipse cx="150" cy="215" rx="46" ry="40" fill="#f4f7ff" opacity="0.9"/></g>
<g id="whale-head"><circle cx="150" cy="120" r="72" fill="#4d6bfe"/></g>
<g id="whale-eye-l"><ellipse cx="126" cy="122" rx="12" ry="15" fill="#131a3a"/><circle cx="130" cy="116" r="4" fill="#fff"/></g>
<g id="whale-eye-r"><ellipse cx="178" cy="122" rx="12" ry="15" fill="#131a3a"/><circle cx="182" cy="116" r="4" fill="#fff"/></g>
<g id="exp-mouth"><path d="M138 148 q12 10 24 0" stroke="#131a3a" stroke-width="4" fill="none" stroke-linecap="round"/></g>
</g></svg>`

/** Switch the character's expression. */
function setMood(mood, durationMs) {
  const next = MOODS.includes(mood) ? mood : 'idle'
  el.app.dataset.mood = next
  // Switch to the sprite animation for this mood if available; SVG CSS
  // animations remain the fallback when the sprite folder is missing.
  const folder = moodFolder(next)
  if (spriteAnim.has(folder)) spriteAnim.switchTo(folder)
  if (moodTimer !== null) clearTimeout(moodTimer)
  moodTimer = null
  if (typeof durationMs === 'number' && durationMs > 0) {
    moodTimer = setTimeout(() => {
      el.app.dataset.mood = 'idle'
      moodTimer = null
    }, durationMs)
  }
}

let moodTimer = null

/** Update the work-state pill under the character. */
function setState(state, label) {
  el.app.dataset.state = state
  if (state === 'idle') {
    el.busy.hidden = true
    return
  }
  el.busy.hidden = false
  el.busyLabel.textContent = label ?? (state === 'thinking' ? '思考中' : '干活中')
}

// ── bubble ──────────────────────────────────────────────────────────────────

let bubbleTimer = null
let typewriter = null

/**
 * Show text in the speech bubble, optionally typing it out.
 * @param text - the text to show.
 * @param meta - small caption under the text.
 * @param options - `{ type: boolean, ttlMs: number }`.
 */
function showBubble(text, meta = '', options = {}) {
  const value = String(text ?? '').trim()
  if (value.length === 0) return
  el.bubble.hidden = false
  el.bubbleMeta.textContent = meta
  if (typewriter !== null) clearInterval(typewriter)
  typewriter = null
  if (options.type === false || value.length > 400) {
    el.bubbleText.textContent = value
  } else {
    let index = 0
    const step = Math.max(1, Math.round(value.length / 90))
    el.bubbleText.textContent = ''
    typewriter = setInterval(() => {
      index = Math.min(value.length, index + step)
      el.bubbleText.textContent = value.slice(0, index)
      if (index >= value.length) {
        clearInterval(typewriter)
        typewriter = null
      }
    }, 16)
  }
  if (bubbleTimer !== null) clearTimeout(bubbleTimer)
  const ttl = typeof options.ttlMs === 'number' ? options.ttlMs : 14000
  bubbleTimer = ttl > 0
    ? setTimeout(() => {
      el.bubble.hidden = true
      bubbleTimer = null
    }, ttl)
    : null
}

/** Small transient notice at the top of the window. */
function showToast(text, ttlMs = 2600) {
  el.toast.textContent = String(text ?? '')
  el.toast.hidden = false
  setTimeout(() => {
    el.toast.hidden = true
  }, ttlMs)
}

// ── speech synthesis ────────────────────────────────────────────────────────

/** Ordered utterances waiting to be spoken. */
const speechQueue = []
let speaking = false
let voicesLoaded = []

/** Refresh the voice list; Chromium fills it asynchronously. */
function loadVoices() {
  if (!('speechSynthesis' in globalThis)) return
  const voices = globalThis.speechSynthesis.getVoices()
  if (voices.length > 0) voicesLoaded = voices
}

if ('speechSynthesis' in globalThis) {
  loadVoices()
  globalThis.speechSynthesis.addEventListener?.('voiceschanged', loadVoices)
}

/** Pick the best installed voice for the configured language and name. */
function pickVoice() {
  if (voicesLoaded.length === 0) loadVoices()
  if (voicesLoaded.length === 0) return null
  const prefix = voice.lang.split('-')[0].toLowerCase()
  if (voice.name.length > 0) {
    const named = voicesLoaded.find(item => item.name.toLowerCase().includes(voice.name.toLowerCase()))
    if (named !== undefined) return named
  }
  return voicesLoaded.find(item => item.lang.replace('_', '-').toLowerCase().startsWith(prefix))
    ?? voicesLoaded.find(item => item.lang.toLowerCase().startsWith(prefix))
    ?? null
}

// ── sound-effect voices ─────────────────────────────────────────────────────

/** One reusable audio element for effect voices; recreated only if it breaks. */
let effectAudio = null
/** Path whose clip already failed, so the warning is shown once. */
let effectBroken = ''

/**
 * Apply one sidebar catalogue entry to the live voice settings.
 *
 * An `effect` entry stops synthesizing replies and plays its clip instead; a
 * `tts` entry restores synthesis with the named (substring-matched) voice.
 * @param entry - a validated entry from the host's `voices` catalogue.
 */
function applyVoiceEntry(entry) {
  voice.id = typeof entry.id === 'string' ? entry.id : ''
  voice.kind = entry.kind === 'effect' ? 'effect' : 'tts'
  voice.file = typeof entry.file === 'string' ? entry.file : ''
  voice.name = typeof entry.voice === 'string' ? entry.voice : ''
  voice.lang = typeof entry.lang === 'string' && entry.lang.length > 0 ? entry.lang : 'zh-CN'
  // A new clip deserves a fresh attempt even if the previous one was missing.
  effectBroken = ''
  effectAudio = null
  try {
    globalThis.localStorage?.setItem(VOICE_KEY, voice.id)
  } catch {
    // A window with storage disabled simply does not remember the choice.
  }
}

/**
 * Report one unusable effect clip, once per path.
 * @param path - the clip path from the config.
 * @param reason - what the browser said.
 */
function reportEffectFailure(path, reason) {
  if (effectBroken === path) return
  effectBroken = path
  showToast(`音效不可用：${path}（${reason}）——已回退到语音合成`)
  report('error', `effect voice failed: ${path}: ${reason}`)
}

/**
 * Play the selected effect clip once.
 *
 * Returns true when playback started, so the caller can skip synthesis.
 * A missing or undecodable file reports itself and returns false, which makes
 * the reply fall back to speech rather than going silent.
 * @returns whether the clip took over.
 */
function playEffect() {
  const path = typeof voice.file === 'string' ? voice.file.trim() : ''
  if (path.length === 0) {
    reportEffectFailure('（未配置）', 'config.yml 里这条声音没有 file')
    return false
  }
  if (effectBroken === path) return false
  try {
    if (effectAudio === null) effectAudio = new Audio()
    effectAudio.src = `/pet/${path.replace(/^\/+/u, '')}`
    effectAudio.volume = Math.min(1, Math.max(0, voice.volume))
    effectAudio.currentTime = 0
    const previousState = el.app.dataset.state
    effectAudio.onended = () => {
      if (el.app.dataset.state === 'speaking') setState(previousState === 'speaking' ? 'idle' : previousState)
    }
    effectAudio.onerror = () => { reportEffectFailure(path, '加载失败') }
    const started = effectAudio.play()
    if (started !== undefined) {
      started.then(() => {
        setState('speaking', '播放音效')
        // Reported so the host log shows that the clip (not speech) took over.
        report('effect', path)
      }).catch((error) => {
        setState(previousState === 'speaking' ? 'idle' : previousState)
        reportEffectFailure(path, String(error?.message ?? error))
      })
    }
    return true
  } catch (error) {
    reportEffectFailure(path, String(error?.message ?? error))
    return false
  }
}

/** Queue one line for speech; ignores empty text and the muted state. */
function speak(text) {
  const value = String(text ?? '').trim()
  if (value.length === 0) return
  if (!voice.enabled || voice.muted) return
  // An effect voice replaces the reading entirely: every reply plays the clip.
  // A clip that cannot play falls through to the configured engine below.
  if (voice.kind === 'effect' && playEffect()) return
  if (voice.engine === 'http') {
    for (const line of chunkForProvider(value, voice.maxChars)) speechQueue.push(line)
    if (!speaking) nextUtterance()
    return
  }
  if (!('speechSynthesis' in globalThis)) {
    showToast('此环境没有语音合成能力')
    return
  }
  speechQueue.push(value)
  if (!speaking) nextUtterance()
}

/**
 * Split one line into provider-sized chunks.
 *
 * Replies already arrive pre-chunked, but `say` and notifications hand whole
 * strings over; a TTS round trip per sentence keeps each request short and lets
 * playback start before the rest has been synthesized.
 * @param text - the line to split.
 * @param maxChars - configured budget per request.
 * @returns one or more non-empty chunks.
 */
function chunkForProvider(text, maxChars) {
  const limit = Number.isFinite(maxChars) && maxChars >= 8 ? Math.floor(maxChars) : 240
  const parts = String(text).split(/(?<=[。！？!?；;])\s*|\n+/u).filter(part => part.trim().length > 0)
  const chunks = []
  let current = ''
  for (const part of parts) {
    const piece = part.trim()
    if (current.length > 0 && current.length + piece.length > limit) {
      chunks.push(current)
      current = ''
    }
    if (piece.length > limit) {
      if (current.length > 0) {
        chunks.push(current)
        current = ''
      }
      for (let index = 0; index < piece.length; index += limit) chunks.push(piece.slice(index, index + limit))
      continue
    }
    current = current.length === 0 ? piece : `${current}${piece}`
  }
  if (current.length > 0) chunks.push(current)
  return chunks.length === 0 ? [String(text)] : chunks
}

/**
 * Speak one line through the host's speech provider.
 *
 * The provider (and its credentials) live in the host process; the window only
 * asks the bridge for a clip and plays it, so a key never reaches the page.
 * @param line - the chunk to speak.
 * @throws {Error} when the provider refuses or the returned audio cannot play.
 */
async function speakViaProvider(line) {
  const response = await fetch(api('tts'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: line, voiceId: voice.id }),
  })
  if (!response.ok) {
    const detail = await response.json().catch(() => undefined)
    throw new Error(String(detail?.error ?? `HTTP ${response.status}`))
  }
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  try {
    const audio = new Audio(url)
    audio.volume = Math.min(1, Math.max(0, voice.volume))
    await audio.play()
    // Reported so the host log (and the tests) can tell that a synthesized clip
    // really played, rather than only seeing the failures.
    report('tts', `${blob.size}B ${String(blob.type || 'audio')}`)
    await new Promise((resolve, reject) => {
      audio.onended = () => resolve()
      audio.onerror = () => reject(new Error('音频无法播放'))
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Speak the next queued line. */
function nextUtterance() {
  const line = speechQueue.shift()
  if (line === undefined) {
    speaking = false
    if (el.app.dataset.state === 'speaking') setState('idle')
    return
  }
  speaking = true
  if (voice.engine === 'http') {
    const previous = el.app.dataset.state
    setState('speaking', '说话中')
    speakViaProvider(line).catch((error) => {
      report('error', `tts failed: ${String(error?.message ?? error)}`)
      showToast(`语音合成失败：${String(error?.message ?? error)}`)
    }).finally(() => {
      setState(previous === 'speaking' ? 'idle' : previous)
      nextUtterance()
    })
    return
  }
  const utterance = new SpeechSynthesisUtterance(line)
  const picked = pickVoice()
  if (picked !== null) utterance.voice = picked
  utterance.lang = voice.lang
  utterance.rate = voice.rate
  utterance.pitch = voice.pitch
  utterance.volume = voice.volume
  const previousState = el.app.dataset.state
  utterance.onstart = () => {
    setState('speaking', '说话中')
  }
  utterance.onend = () => {
    setState(previousState === 'speaking' ? 'idle' : previousState)
    nextUtterance()
  }
  utterance.onerror = () => {
    setState(previousState === 'speaking' ? 'idle' : previousState)
    nextUtterance()
  }
  try {
    globalThis.speechSynthesis.speak(utterance)
  } catch (error) {
    report('error', `speech failed: ${String(error?.message ?? error)}`)
    nextUtterance()
  }
}

/** Stop everything currently queued or speaking. */
function hush() {
  speechQueue.length = 0
  speaking = false
  try {
    globalThis.speechSynthesis?.cancel()
  } catch {
    // Nothing was speaking.
  }
  if (el.app.dataset.state === 'speaking') setState('idle')
}

// ── speech recognition ──────────────────────────────────────────────────────

const recorder = {
  active: false,
  stream: null,
  media: null,
  chunks: [],
  stopTimer: null,
}

/** Whether this engine offers the Web Speech recognition API. */
function hasWebSpeech() {
  return typeof globalThis.SpeechRecognition === 'function' || typeof globalThis.webkitSpeechRecognition === 'function'
}

/** Start listening, preferring the browser engine and falling back to Windows SAPI. */
async function startListening() {
  if (recorder.active) {
    stopListening()
    return
  }
  if (!asr.enabled) {
    showToast('语音输入已关闭')
    return
  }
  if (asr.engine !== 'sapi' && hasWebSpeech()) {
    startWebSpeech()
    return
  }
  if (asr.engine === 'webspeech') {
    showToast('这个窗口没有浏览器语音识别')
    return
  }
  await startRecorder()
}

let webSpeech = null

/** Recognise through the browser's own engine. */
function startWebSpeech() {
  const Recognition = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition
  webSpeech = new Recognition()
  webSpeech.lang = asr.lang
  webSpeech.continuous = false
  webSpeech.interimResults = false
  webSpeech.maxAlternatives = 1
  el.mic.classList.add('is-recording')
  showToast('我在听…')
  webSpeech.onresult = (event) => {
    const transcript = event?.results?.[0]?.[0]?.transcript ?? ''
    if (transcript.trim().length > 0) send(transcript.trim(), 'voice')
  }
  webSpeech.onerror = (event) => {
    const code = String(event?.error ?? 'unknown')
    if (code === 'not-allowed' || code === 'service-not-allowed') {
      showToast('麦克风被拒绝，改用本地识别')
      void startRecorder()
      return
    }
    showToast(`语音识别失败：${code}`)
  }
  webSpeech.onend = () => {
    el.mic.classList.remove('is-recording')
    webSpeech = null
  }
  try {
    webSpeech.start()
  } catch (error) {
    el.mic.classList.remove('is-recording')
    showToast(`无法开始识别：${String(error?.message ?? error)}`)
  }
}

/** Record audio and hand it to the host's offline recogniser. */
async function startRecorder() {
  if (!navigator.mediaDevices?.getUserMedia) {
    showToast('这个窗口不能访问麦克风')
    return
  }
  try {
    recorder.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: false,
    })
  } catch (error) {
    showToast(`麦克风不可用：${String(error?.message ?? error)}`)
    return
  }
  recorder.chunks = []
  recorder.media = new MediaRecorder(recorder.stream)
  recorder.media.ondataavailable = (event) => {
    if (event.data.size > 0) recorder.chunks.push(event.data)
  }
  recorder.media.onstop = () => {
    void finishRecording()
  }
  recorder.media.start()
  recorder.active = true
  el.mic.classList.add('is-recording')
  showToast('我在听…再点一次结束')
  recorder.stopTimer = setTimeout(() => stopListening(), asr.maxSeconds * 1000)
}

/** Stop the current recording session. */
function stopListening() {
  if (recorder.stopTimer !== null) clearTimeout(recorder.stopTimer)
  recorder.stopTimer = null
  el.mic.classList.remove('is-recording')
  if (webSpeech !== null) {
    try {
      webSpeech.stop()
    } catch {
      // Already stopped.
    }
    return
  }
  if (recorder.media !== null && recorder.media.state !== 'inactive') {
    recorder.media.stop()
  } else {
    recorder.active = false
    releaseStream()
  }
}

/** Release the microphone. */
function releaseStream() {
  for (const track of recorder.stream?.getTracks?.() ?? []) track.stop()
  recorder.stream = null
  recorder.media = null
}

/** Encode, upload, and transcribe the finished recording. */
async function finishRecording() {
  recorder.active = false
  const chunks = recorder.chunks
  recorder.chunks = []
  releaseStream()
  if (chunks.length === 0) return
  showToast('识别中…')
  try {
    const blob = new Blob(chunks, { type: chunks[0].type || 'audio/webm' })
    const wav = await toWav(blob)
    const response = await fetch(api('asr'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audioBase64: base64(wav), lang: asr.lang }),
    })
    const payload = await response.json()
    if (payload?.ok !== true) throw new Error(String(payload?.error ?? '识别失败'))
    const text = String(payload.value?.text ?? '').trim()
    if (text.length === 0) {
      showToast('没听清，再说一次？')
      return
    }
    send(text, 'voice')
  } catch (error) {
    showToast(`识别失败：${String(error?.message ?? error)}`)
  }
}

/**
 * Decode any recorded audio into the canonical 16 kHz mono PCM16 WAV the host
 * recogniser accepts.
 * @param blob - the recorded audio.
 * @returns the WAV bytes.
 */
async function toWav(blob) {
  const context = new AudioContext()
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer())
    const frames = Math.max(1, Math.ceil(decoded.duration * 16000))
    const offline = new OfflineAudioContext(1, frames, 16000)
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start()
    const rendered = await offline.startRendering()
    return encodeWav(rendered.getChannelData(0), 16000)
  } finally {
    void context.close()
  }
}

/**
 * Encode mono float samples as a 16-bit PCM WAV file.
 * @param samples - normalized samples in [-1, 1].
 * @param sampleRate - sample rate in Hz.
 * @returns the WAV bytes.
 */
function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const writeText = (offset, text) => {
    for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index))
  }
  writeText(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeText(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  let offset = 44
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample))
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
    offset += 2
  }
  return new Uint8Array(buffer)
}

/** Base64-encode bytes without blowing the call stack on long clips. */
function base64(bytes) {
  let text = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    text += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(text)
}

// ── bridge ──────────────────────────────────────────────────────────────────

/** Send one line into the watched conversation. */
async function send(text, source = 'text') {
  const value = String(text ?? '').trim()
  if (value.length === 0) return
  el.input.value = ''
  showBubble(value, source === 'voice' ? '你说（语音）' : '你说', { type: false, ttlMs: 6000 })
  try {
    const response = await fetch(api('message'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: value, source }),
    })
    const payload = await response.json()
    if (payload?.ok !== true) throw new Error(String(payload?.error ?? '发送失败'))
    setState('thinking', '思考中')
    setMood('thinking')
  } catch (error) {
    showBubble(`发不出去：${String(error?.message ?? error)}`, '错误', { type: false, ttlMs: 9000 })
  }
}

/** Report one lifecycle event back to the host log. */
function report(type, message) {
  try {
    void fetch(api('client'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type, message, mood: el.app.dataset.mood }),
    })
  } catch {
    // Diagnostics only; never surface a reporting failure.
  }
}

/** Handle one Server-Sent Event from the host. */
function onEvent(event) {
  switch (event.type) {
    case 'reply': {
      const meta = event.interrupted === true ? '（被打断）' : '鲸鱼娘'
      showBubble(event.text ?? '', meta)
      if (event.speak !== false) speak((event.utterances ?? []).join('。'))
      setMood('happy', 6000)
      setState('idle')
      break
    }
    case 'say': {
      showBubble(event.text ?? '', '鲸鱼娘')
      speak(event.text ?? '')
      setMood(event.mood ?? 'happy', 6000)
      break
    }
    case 'mood': {
      setMood(event.mood, event.durationMs)
      break
    }
    case 'status': {
      if (event.state === 'thinking') {
        setState('thinking', '思考中')
        setMood('thinking')
      } else {
        setState('idle')
        if (el.app.dataset.mood === 'thinking' || el.app.dataset.mood === 'working') setMood('idle')
      }
      break
    }
    case 'tool': {
      if (event.phase === 'start') {
        setState('working', `执行 ${String(event.label ?? event.name ?? '工具')}`)
        setMood('working')
      } else {
        setState('idle')
        setMood(event.isError === true ? 'surprised' : 'idle', event.isError === true ? 3000 : undefined)
      }
      break
    }
    case 'notify': {
      showBubble(String(event.message ?? ''), String(event.title ?? '通知'), { ttlMs: 20000 })
      speak(event.message ?? '')
      setMood('surprised', 4000)
      break
    }
    case 'user': {
      showBubble(String(event.text ?? ''), '你说', { type: false, ttlMs: 6000 })
      break
    }
    case 'window': {
      void windowCommand(String(event.action ?? ''))
      break
    }
    default:
      break
  }
}

/** Open the event stream, reconnecting when the host restarts. */
function connect() {
  const source = new EventSource(api('events'))
  source.onopen = () => {
    report('ready')
    setState('idle')
  }
  source.onmessage = (message) => {
    let event
    try {
      event = JSON.parse(message.data)
    } catch {
      return
    }
    onEvent(event)
  }
  source.onerror = () => {
    setState('idle')
    showToast('和 DSH 的连接断开了，正在重连…')
  }
  return source
}

// ── window commands ─────────────────────────────────────────────────────────

/** The Electron preload surface, when the window runs under Electron. */
const windowApi = globalThis.whalePetWindow ?? null

/** Apply one window command from the host or a keyboard shortcut. */
async function windowCommand(action) {
  if (windowApi === null) {
    showToast(`此窗口不支持「${action}」`)
    return
  }
  switch (action) {
    case 'hide': await windowApi.hide(); break
    case 'show': await windowApi.show(); break
    case 'quit': await windowApi.quit(); break
    case 'topmost-on': await windowApi.setTopmost(true); showToast('已置顶'); break
    case 'topmost-off': await windowApi.setTopmost(false); showToast('已取消置顶'); break
    case 'toggle': {
      const topmost = await windowApi.getTopmost()
      await windowApi.setTopmost(!topmost)
      showToast(topmost ? '已取消置顶' : '已置顶')
      break
    }
    default: break
  }
}

/** Show or hide the composer. */
function toggleComposer(force) {
  const next = typeof force === 'boolean' ? force : el.composer.hidden
  el.composer.hidden = !next
  if (next) el.input.focus()
}

/** Toggle the sidebar. */
function toggleSidebar(force) {
  const next = typeof force === 'boolean' ? force : el.sidebar.hidden
  el.sidebar.hidden = !next
}

/** Build the sidebar's action + voice buttons from the boot config. */
function buildSidebar() {
  el.sidebar.textContent = ''

  const actions = document.createElement('section')
  actions.className = 'sidebar__section'
  const actionsTitle = document.createElement('h3')
  actionsTitle.className = 'sidebar__title'
  actionsTitle.textContent = '动作'
  actions.append(actionsTitle)
  for (const action of ACTIONS) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'sidebar__button'
    button.textContent = action.name
    button.addEventListener('click', () => {
      toggleSidebar(false)
      // Play the sequence only — do not touch the SVG expression layer.
      spriteAnim.switchTo(action.folder)
      showToast(`播放动作：${action.name}`)
    })
    actions.append(button)
  }
  el.sidebar.append(actions)

  const voices = document.createElement('section')
  voices.className = 'sidebar__section'
  const voicesTitle = document.createElement('h3')
  voicesTitle.className = 'sidebar__title'
  voicesTitle.textContent = '声音'
  voices.append(voicesTitle)
  if (VOICES.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'sidebar__empty'
    empty.textContent = '（未配置声音）'
    voices.append(empty)
  } else {
    for (const entry of VOICES) {
      const isEffect = entry.kind === 'effect'
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'sidebar__button'
      button.textContent = isEffect ? `${entry.name}（音效）` : entry.name
      if (voice.id === entry.id) button.dataset.active = 'true'
      button.addEventListener('click', () => {
        toggleSidebar(false)
        applyVoiceEntry(entry)
        buildSidebar()
        showToast(`已切换声音：${entry.name}`)
        if (isEffect) {
          // Preview the clip itself: that is what the replies will sound like.
          if (!playEffect()) speak(entry.name)
        } else {
          speak(entry.name)
        }
      })
      voices.append(button)
    }
  }
  el.sidebar.append(voices)
}

/**
 * Restore the voice the user picked in a previous window.
 *
 * The host config supplies the catalogue and its default; the choice itself is
 * window-local, so it lives in localStorage and is only applied when it still
 * names an entry in the current catalogue.
 */
function restoreVoiceChoice() {
  let saved = ''
  try {
    saved = globalThis.localStorage?.getItem(VOICE_KEY) ?? ''
  } catch {
    saved = ''
  }
  if (saved.length === 0) return
  const entry = VOICES.find(candidate => candidate.id === saved)
  if (entry === undefined) return
  applyVoiceEntry(entry)
}

// ── window dragging ─────────────────────────────────────────────────────────

/** Left-button drag of the whale moves the window; a still press stays a click. */
let dragState = null
let suppressClick = false

function initWindowDrag() {
  const onMouseDown = (event) => {
    if (event.button !== 0 || windowApi === null) return
    dragState = {
      startX: event.screenX,
      startY: event.screenY,
      lastX: event.screenX,
      lastY: event.screenY,
      moving: false,
    }
  }
  const onMouseMove = (event) => {
    if (dragState === null) return
    const dx = event.screenX - dragState.startX
    const dy = event.screenY - dragState.startY
    if (!dragState.moving && Math.hypot(dx, dy) < 6) return
    dragState.moving = true
    const moveX = event.screenX - dragState.lastX
    const moveY = event.screenY - dragState.lastY
    dragState.lastX = event.screenX
    dragState.lastY = event.screenY
    void windowApi.moveBy(moveX, moveY)
  }
  const onMouseUp = () => {
    if (dragState === null) return
    const wasMoving = dragState.moving
    dragState = null
    if (wasMoving) {
      // A drag must not also toggle the composer via the click event that follows.
      suppressClick = true
      setTimeout(() => { suppressClick = false }, 0)
    }
  }
  for (const target of [el.character, el.eatToken]) {
    target.addEventListener('mousedown', onMouseDown)
  }
  globalThis.addEventListener('mousemove', onMouseMove)
  globalThis.addEventListener('mouseup', onMouseUp)
}

// ── wiring ──────────────────────────────────────────────────────────────────

el.composer.addEventListener('submit', (event) => {
  event.preventDefault()
  void send(el.input.value, 'text')
})

el.mic.addEventListener('click', () => {
  void startListening()
})

document.getElementById('stage').addEventListener('click', (event) => {
  if (event.button !== 0) return
  if (suppressClick) return
  toggleSidebar(false)
  toggleComposer()
})

document.getElementById('stage').addEventListener('contextmenu', (event) => {
  event.preventDefault()
  toggleSidebar()
})

document.addEventListener('click', (event) => {
  if (!el.sidebar.hidden && !el.sidebar.contains(event.target)) toggleSidebar(false)
})

el.input.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    toggleComposer(false)
    el.input.blur()
  }
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && el.composer.hidden) {
    void windowCommand(windowApi === null ? '' : 'hide')
  }
})

globalThis.addEventListener('beforeunload', () => {
  hush()
  stopListening()
})

/** Idle life: blink is CSS, but an occasional mood flicker keeps her alive. */
function startIdleLife() {
  setInterval(() => {
    if (el.app.dataset.state !== 'idle') return
    if (el.app.dataset.mood !== 'idle') return
    const mood = Math.random() < 0.5 ? 'sleepy' : 'happy'
    setMood(mood, 2600)
  }, 45000)
}

/** First paint: art, stream, ready signal. */
async function main() {
  await mountCharacter()
  setState('idle')
  setMood('idle')
  restoreVoiceChoice()
  buildSidebar()
  initWindowDrag()
  startIdleLife()
  void spriteAnim.warm()
  connect()
  windowApi?.ready()
  report('boot', `mood=${el.app.dataset.mood}`)
}

void main()

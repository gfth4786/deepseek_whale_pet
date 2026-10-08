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
  bubble: document.getElementById('bubble'),
  bubbleText: document.getElementById('bubble-text'),
  bubbleMeta: document.getElementById('bubble-meta'),
  busy: document.getElementById('busy'),
  busyLabel: document.getElementById('busy-label'),
  composer: document.getElementById('composer'),
  input: document.getElementById('input'),
  send: document.getElementById('send'),
  mic: document.getElementById('mic'),
  menu: document.getElementById('menu'),
  toast: document.getElementById('toast'),
}

/** Voice settings, merged with anything the host sends later. */
const voice = {
  enabled: INITIAL.voice?.enabled !== false,
  lang: INITIAL.voice?.lang ?? 'zh-CN',
  name: INITIAL.voice?.voice ?? '',
  rate: Number(INITIAL.voice?.rate ?? 1.05),
  pitch: Number(INITIAL.voice?.pitch ?? 1.25),
  volume: Number(INITIAL.voice?.volume ?? 1),
  muted: false,
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
let lastSpoken = ''

/**
 * Show text in the speech bubble, optionally typing it out.
 * @param text - the text to show.
 * @param meta - small caption under the text.
 * @param options - `{ type: boolean, ttlMs: number }`.
 */
function showBubble(text, meta = '', options = {}) {
  const value = String(text ?? '').trim()
  if (value.length === 0) return
  lastSpoken = value
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

/** Queue one line for speech; ignores empty text and the muted state. */
function speak(text) {
  const value = String(text ?? '').trim()
  if (value.length === 0) return
  if (!voice.enabled || voice.muted) return
  if (!('speechSynthesis' in globalThis)) {
    showToast('此环境没有语音合成能力')
    return
  }
  speechQueue.push(value)
  if (!speaking) nextUtterance()
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
        if (el.app.dataset.mood === 'idle' || el.app.dataset.mood === 'happy') setMood('thinking')
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

/** Apply one window command from the host or the menu. */
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

/** Toggle the menu. */
function toggleMenu(force) {
  const next = typeof force === 'boolean' ? force : el.menu.hidden
  el.menu.hidden = !next
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
  toggleMenu(false)
  toggleComposer()
})

document.getElementById('stage').addEventListener('contextmenu', (event) => {
  event.preventDefault()
  toggleMenu()
})

el.menu.addEventListener('click', (event) => {
  const action = event.target?.dataset?.action
  if (typeof action !== 'string') return
  toggleMenu(false)
  switch (action) {
    case 'composer': toggleComposer(true); break
    case 'mute': {
      voice.muted = !voice.muted
      if (voice.muted) hush()
      event.target.textContent = voice.muted ? '取消静音朗读' : '静音朗读'
      showToast(voice.muted ? '朗读已静音' : '朗读已恢复')
      break
    }
    case 'topmost': void windowCommand('toggle'); break
    case 'speak-last': speak(lastSpoken); break
    case 'hide': void windowCommand('hide'); break
    case 'quit': void windowCommand('quit'); break
    default: break
  }
})

document.addEventListener('click', (event) => {
  if (!el.menu.hidden && !el.menu.contains(event.target)) toggleMenu(false)
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
  startIdleLife()
  connect()
  windowApi?.ready()
  report('boot', `mood=${el.app.dataset.mood}`)
}

void main()

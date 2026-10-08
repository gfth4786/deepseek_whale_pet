/**
 * The loopback bridge between DSH and the desktop-pet window.
 *
 * The pet window is a separate process (Electron, or a Chromium app window as a
 * fallback) that has to receive assistant replies and send the user's spoken or
 * typed input back. Rather than teaching it the Harness API, the plugin runs a
 * tiny HTTP server:
 *
 *   GET  /pet/*        static pet window assets (the window's own document)
 *   GET  /api/state    one-shot snapshot: session, voice config, last reply
 *   GET  /api/events   Server-Sent Events: every host → pet push
 *   POST /api/message  user text from the pet → the target agent
 *   POST /api/client   pet-side lifecycle events (ready, mood, spoke)
 *   POST /api/asr      recorded audio → transcript (Windows SAPI fallback)
 *
 * Bound to a loopback address only, and every `/api` request must carry the
 * per-boot token, so a random page in the user's browser cannot drive the pet's
 * tools or inject messages into a session.
 *
 * @module dsh-whale-pet/src/bridge
 */

import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
/** Absolute path of the pet window document and its assets. */
export const PET_ROOT = resolve(HERE, '..', 'pet')

/** Static content types the bridge serves. */
const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
})

/** Largest request body the bridge accepts, in bytes (audio recordings). */
const MAX_BODY_BYTES = 12 * 1024 * 1024

/** Interval between SSE comment heartbeats, in milliseconds. */
const SSE_HEARTBEAT_MS = 25000

/**
 * The bridge server: static pet assets, the SSE push channel, and the pet's
 * inbound API.
 */
export class PetBridge {
  /** @type {Set<import('node:http').ServerResponse>} */
  #clients = new Set()
  #server
  #heartbeat
  #port = 0
  #token
  /** Recent events replayed to a window that connects late. */
  #recent = []

  /**
   * @param options - host binding, the message sink, and the optional log sink.
   * @param options.host - loopback host to bind.
   * @param options.port - requested port, or 0 for an OS-assigned one.
   * @param options.token - shared secret; empty mints a fresh one.
   * @param options.onMessage - receives `{ text, source }` from the pet.
   * @param options.onClientEvent - receives `{ type, ... }` lifecycle events.
   * @param options.onAsr - receives raw audio bytes, returns a transcript.
   * @param options.snapshot - returns the current snapshot for `GET /api/state`.
   * @param options.log - debug log sink.
   */
  constructor(options) {
    this.host = options.host
    this.requestedPort = options.port
    this.#token = options.token && options.token.length > 0 ? options.token : randomBytes(16).toString('hex')
    this.onMessage = options.onMessage
    this.onClientEvent = options.onClientEvent ?? (() => {})
    this.onAsr = options.onAsr
    this.snapshot = options.snapshot ?? (() => ({}))
    this.log = options.log ?? (() => {})
  }

  /** The effective shared secret other processes must present. */
  get token() {
    return this.#token
  }

  /** The bound port, valid after {@link start}. */
  get port() {
    return this.#port
  }

  /** Loopback URL of the pet document, token included. */
  get petUrl() {
    return `http://${this.host}:${this.#port}/pet/?token=${this.#token}`
  }

  /** Number of connected pet windows. */
  get clientCount() {
    return this.#clients.size
  }

  /**
   * Bind the server and resolve once it accepts connections.
   *
   * A configured port is a convenience (the window URL stays stable across
   * restarts), not a requirement: when it is taken the bridge asks the OS for a
   * free port instead of failing the plugin.
   * @returns the bound port.
   * @throws {Error} when even an OS-assigned port cannot be bound.
   */
  async start() {
    if (this.#server !== undefined) throw new Error('whale-pet bridge is already running')
    try {
      await this.#listen(this.requestedPort)
    } catch (error) {
      if (this.requestedPort === 0 || error?.code !== 'EADDRINUSE') throw error
      this.log(`bridge port ${this.requestedPort} is in use; asking the OS for a free port`)
      await this.#listen(0)
    }
    const address = this.#server.address()
    this.#port = typeof address === 'object' && address !== null ? address.port : this.requestedPort
    this.#heartbeat = setInterval(() => {
      for (const client of this.#clients) client.write(': ping\n\n')
    }, SSE_HEARTBEAT_MS)
    this.#heartbeat.unref?.()
    return this.#port
  }

  /**
   * Create the server and bind one port.
   * @param port - port to bind; 0 asks the OS.
   * @returns completion once the listener is up.
   */
  async #listen(port) {
    const server = createServer((req, res) => {
      this.#handle(req, res).catch((error) => {
        this.log(`bridge request failed: ${error?.stack ?? error}`)
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        }
        res.end('whale-pet bridge error')
      })
    })
    server.on('clientError', (_error, socket) => socket.destroy())
    try {
      await new Promise((resolvePromise, reject) => {
        const onError = (error) => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.off('error', onError)
          resolvePromise()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, this.host)
      })
    } catch (error) {
      await new Promise((resolvePromise) => server.close(() => resolvePromise()))
      throw error
    }
    this.#server = server
  }

  /**
   * Close every stream and stop accepting connections.
   * @returns completion once the listener is closed.
   */
  async stop() {
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat)
    this.#heartbeat = undefined
    for (const client of this.#clients) {
      try {
        client.end()
      } catch {
        // A dead client is already gone; nothing to reclaim.
      }
    }
    this.#clients.clear()
    const server = this.#server
    this.#server = undefined
    if (server === undefined) return
    await new Promise((resolvePromise) => server.close(() => resolvePromise()))
  }

  /**
   * Push one event to every connected pet window.
   * @param type - event name the renderer switches on.
   * @param payload - JSON-serializable event body.
   * @returns whether at least one window received it.
   */
  publish(type, payload = {}) {
    const event = { type, ...payload }
    const frame = `data: ${JSON.stringify(event)}\n\n`
    this.#recent.push(event)
    if (this.#recent.length > 60) this.#recent.shift()
    let delivered = false
    for (const client of this.#clients) {
      try {
        client.write(frame)
        delivered = true
      } catch {
        this.#clients.delete(client)
      }
    }
    return delivered
  }

  /**
   * Route one request.
   * @param req - incoming request.
   * @param res - response to complete.
   */
  async #handle(req, res) {
    const url = new URL(req.url ?? '/', `http://${this.host}:${this.#port}`)
    const path = url.pathname
    if (path === '/api/events') {
      if (!this.#authorized(url, req)) return this.#deny(res)
      return this.#stream(res)
    }
    if (path.startsWith('/api/')) {
      if (!this.#authorized(url, req)) return this.#deny(res)
      return this.#api(path, req, res)
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' })
      res.end('method not allowed')
      return
    }
    return this.#static(path, req, res)
  }

  /**
   * Whether one request carries the bridge token.
   * @param url - parsed request URL.
   * @param req - incoming request.
   * @returns true when the token matches.
   */
  #authorized(url, req) {
    const header = req.headers['x-whale-pet-token']
    const presented = url.searchParams.get('token') ?? (typeof header === 'string' ? header : '')
    return presented.length > 0 && presented === this.#token
  }

  /** Answer 403 for an unauthenticated API request. */
  #deny(res) {
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: 'invalid whale-pet bridge token' }))
  }

  /** Open one Server-Sent Events stream. */
  #stream(res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(': connected\n\n')
    // A window that opened after the last reply still learns what was said.
    for (const event of this.#recent) res.write(`data: ${JSON.stringify(event)}\n\n`)
    this.#clients.add(res)
    const drop = () => {
      this.#clients.delete(res)
    }
    res.on('close', drop)
    res.on('error', drop)
  }

  /**
   * Handle one `/api/*` request.
   * @param path - request path.
   * @param req - incoming request.
   * @param res - response to complete.
   */
  async #api(path, req, res) {
    if (path === '/api/state' && req.method === 'GET') {
      return this.#json(res, 200, { ok: true, value: this.snapshot() })
    }
    if (path === '/api/message' && req.method === 'POST') {
      const body = await this.#body(req, res)
      if (body === undefined) return
      const parsed = parseJson(body)
      const text = typeof parsed?.text === 'string' ? parsed.text.trim() : ''
      if (text.length === 0) return this.#json(res, 400, { ok: false, error: 'text is required' })
      try {
        const value = await this.onMessage({ text, source: parsed?.source === 'voice' ? 'voice' : 'text' })
        return this.#json(res, 200, { ok: true, value })
      } catch (error) {
        return this.#json(res, 200, { ok: false, error: String(error?.message ?? error) })
      }
    }
    if (path === '/api/client' && req.method === 'POST') {
      const body = await this.#body(req, res)
      if (body === undefined) return
      const parsed = parseJson(body)
      if (parsed === undefined) return this.#json(res, 400, { ok: false, error: 'invalid JSON body' })
      this.onClientEvent(parsed)
      return this.#json(res, 200, { ok: true, value: { accepted: true } })
    }
    if (path === '/api/asr' && req.method === 'POST') {
      if (this.onAsr === undefined) {
        return this.#json(res, 200, { ok: false, error: 'ASR is not available in this deployment' })
      }
      const body = await this.#body(req, res)
      if (body === undefined) return
      const parsed = parseJson(body) ?? {}
      const base64 = typeof parsed.audioBase64 === 'string' ? parsed.audioBase64 : ''
      if (base64.length === 0) return this.#json(res, 400, { ok: false, error: 'audioBase64 is required' })
      try {
        const audio = Buffer.from(base64, 'base64')
        const value = await this.onAsr({ audio, lang: parsed.lang })
        return this.#json(res, 200, { ok: true, value })
      } catch (error) {
        return this.#json(res, 200, { ok: false, error: String(error?.message ?? error) })
      }
    }
    return this.#json(res, 404, { ok: false, error: `unknown endpoint ${path}` })
  }

  /**
   * Read and size-check one request body.
   * @param req - incoming request.
   * @param res - response used when the body is rejected.
   * @returns the body text, or undefined when a response was already sent.
   */
  async #body(req, res) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        this.#json(res, 413, { ok: false, error: 'request body too large' })
        return undefined
      }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  /**
   * Send one JSON response.
   * @param res - response to complete.
   * @param status - HTTP status.
   * @param value - value to serialize.
   */
  #json(res, status, value) {
    const body = JSON.stringify(value)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  /**
   * Serve one pet asset.
   * @param path - request path.
   * @param req - incoming request (for HEAD).
   * @param res - response to complete.
   */
  async #static(path, req, res) {
    const relative = path === '/' ? '/pet/' : path
    const target = resolveStaticPath(relative)
    if (target === undefined) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('forbidden')
      return
    }
    let bytes
    try {
      bytes = await readFile(target)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream'
    let body = bytes
    if (target.endsWith('.html')) {
      // The document learns its bridge token and the current state at serve
      // time. A non-executable JSON script block carries the data, so the page
      // needs no inline-script exemption in its Content-Security-Policy, and no
      // other origin can read this response (the bridge sends no CORS headers).
      const injected = bytes.toString('utf8').replace(
        '<!--WHALE_PET_BOOT-->',
        `<script type="application/json" id="whale-pet-boot">${JSON.stringify({
          token: this.#token,
          state: this.snapshot(),
        }).replace(/</gu, '\\u003c')}</script>`,
      )
      body = Buffer.from(injected, 'utf8')
    }
    res.writeHead(200, {
      'content-type': type,
      'content-length': body.length,
      'cache-control': 'no-store',
    })
    if (req.method === 'HEAD') res.end()
    else res.end(body)
  }
}

/**
 * Resolve one URL path to a file inside the pet directory, rejecting escapes.
 * A directory request (`/pet/`) resolves to that directory's `index.html`.
 * @param path - request path such as `/pet/pet.js`.
 * @returns the absolute file path, or undefined when it leaves the pet root.
 */
export function resolveStaticPath(path) {
  if (!path.startsWith('/pet/')) return undefined
  let decoded
  try {
    decoded = decodeURIComponent(path.slice('/pet/'.length))
  } catch {
    // A malformed escape sequence is a malformed request, not a path.
    return undefined
  }
  if (decoded.includes('\0')) return undefined
  // Reject traversal outright rather than relying on the containment check:
  // `..` is never a legitimate part of a pet asset path.
  if (decoded.split(/[\\/]/u).includes('..')) return undefined
  const relative = decoded.length === 0 || decoded.endsWith('/') ? `${decoded}index.html` : decoded
  const target = resolve(join(PET_ROOT, normalize(relative)))
  const root = PET_ROOT.endsWith(sep) ? PET_ROOT : `${PET_ROOT}${sep}`
  if (target !== PET_ROOT && !target.startsWith(root)) return undefined
  return target
}

/** Parse JSON, returning undefined instead of throwing. */
function parseJson(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * The HTTP speech provider and the bridge endpoint that serves it.
 *
 * The real backends (Fish Audio, GPT-SoVITS, Bert-VITS2) need credentials this
 * repository does not have, so every shape the config supports is exercised
 * against a local stub server: raw audio, base64 in JSON, an audio URL in JSON,
 * provider failures, and the header/body templating that carries a key.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  TtsCache, TtsError, audioTypeFor, readPath, renderBody, renderUrl, synthesize,
} from '../src/tts.js'
import { PetBridge } from '../src/bridge.js'

/** Encode a tiny valid WAV so "audio bytes" are real for the caller. */
function wavBytes(length = 8) {
  return Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(length)])
}

/** One HTTP config block with the endpoint filled in. */
function httpConfig(url, extra = {}) {
  return {
    url,
    method: 'POST',
    headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
    body: '{"text":"{{text}}"}',
    audioPath: '',
    audioEncoding: 'base64',
    format: 'mp3',
    timeoutMs: 5000,
    cacheEntries: 8,
    ...extra,
  }
}

/** Start a stub provider and return its base URL plus the received requests. */
async function withStubServer(handler, body) {
  const seen = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const request = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      seen.push(request)
      handler(request, res)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    await body({ base, seen })
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

test('templating keeps quotes, newlines and CJK intact', () => {
  const text = '他说：“曼波"\n换行 \\ 反斜杠'
  assert.equal(renderUrl('http://x/tts?text={{text}}', '你好 世界'), 'http://x/tts?text=%E4%BD%A0%E5%A5%BD%20%E4%B8%96%E7%95%8C')
  const rendered = renderBody('{"text":"{{text}}"}', text)
  assert.deepEqual(JSON.parse(rendered), { text })
  assert.equal(renderBody('{"t":"{{text}}"}', 'a"b'), '{"t":"a\\"b"}')
})

test('dotted paths and formats resolve', () => {
  assert.equal(readPath({ data: { audio: 'x' } }, 'data.audio'), 'x')
  assert.equal(readPath({ data: null }, 'data.audio'), undefined)
  // An empty path means "the whole response", which callers avoid by checking.
  assert.deepEqual(readPath({ audio: 'x' }, ''), { audio: 'x' })
  assert.equal(audioTypeFor('wav'), 'audio/wav')
  assert.equal(audioTypeFor('.mp3'), 'audio/mpeg')
  assert.equal(audioTypeFor('nonsense'), 'audio/mpeg')
})

test('GET substitutes the text into the URL and returns raw audio', async () => {
  await withStubServer((request, res) => {
    res.writeHead(200, { 'content-type': 'audio/wav' })
    res.end(wavBytes())
  }, async ({ base, seen }) => {
    const config = httpConfig(`${base}/tts?text={{text}}`, { method: 'GET', format: 'wav' })
    const clip = await synthesize({ text: '你好 曼波', http: config })
    assert.equal(clip.contentType, 'audio/wav')
    assert.equal(clip.audio.subarray(0, 4).toString('ascii'), 'RIFF')
    assert.equal(seen[0].method, 'GET')
    assert.match(seen[0].url, /text=%E4%BD%A0%E5%A5%BD%20%E6%9B%BC%E6%B3%A2/)
    // No body is sent for GET, but the headers still carry the credential.
    assert.equal(seen[0].body, '')
    assert.equal(seen[0].headers.authorization, 'Bearer test-key')
  })
})

test('POST sends a JSON body the provider can parse back', async () => {
  await withStubServer((request, res) => {
    res.writeHead(200, { 'content-type': 'audio/mpeg' })
    res.end(Buffer.from([1, 2, 3, 4]))
  }, async ({ base, seen }) => {
    const config = httpConfig(`${base}/tts`)
    const clip = await synthesize({ text: '带"引号"的回复', http: config })
    assert.equal(clip.audio.length, 4)
    assert.deepEqual(JSON.parse(seen[0].body), { text: '带"引号"的回复' })
    assert.equal(seen[0].headers['content-type'], 'application/json')
  })
})

test('a base64 field in a JSON response is decoded', async () => {
  const audio = wavBytes(16)
  await withStubServer((request, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 0, data: { audio: audio.toString('base64') } }))
  }, async ({ base }) => {
    const config = httpConfig(`${base}/voice`, { audioPath: 'data.audio' })
    const clip = await synthesize({ text: '曼波', http: config })
    assert.deepEqual(clip.audio, audio)
  })
})

test('an audio URL in a JSON response is followed', async () => {
  const audio = wavBytes(24)
  await withStubServer((request, res) => {
    if (request.url === '/clip') {
      res.writeHead(200, { 'content-type': 'audio/mpeg' })
      res.end(audio)
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: { url: `http://${request.headers.host}/clip` } }))
  }, async ({ base }) => {
    const config = httpConfig(`${base}/voice`, { audioPath: 'data.url', audioEncoding: 'url' })
    const clip = await synthesize({ text: '曼波', http: config })
    assert.deepEqual(clip.audio, audio)
  })
})

test('provider failures surface with status and message', async () => {
  await withStubServer((request, res) => {
    res.writeHead(429, { 'content-type': 'text/plain' })
    res.end('rate limited\n请稍后重试')
  }, async ({ base }) => {
    await assert.rejects(
      () => synthesize({ text: '曼波', http: httpConfig(`${base}/tts`) }),
      (error) => {
        assert.ok(error instanceof TtsError)
        assert.equal(error.status, 429)
        assert.match(error.message, /HTTP 429/)
        assert.match(error.message, /rate limited 请稍后重试/)
        return true
      },
    )
  })
})

test('an empty payload and an unconfigured provider are distinct errors', async () => {
  await withStubServer((request, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: {} }))
  }, async ({ base }) => {
    await assert.rejects(
      () => synthesize({ text: 'x', http: httpConfig(`${base}/tts`, { audioPath: 'data.audio' }) }),
      /response has no string at data\.audio/,
    )
  })
  await assert.rejects(
    () => synthesize({ text: 'x', http: httpConfig('') }),
    /voice\.http\.url is empty/,
  )
})

test('an unreachable provider reports itself instead of hanging', async () => {
  // Port 1 is reserved and closed, so the request fails immediately.
  await assert.rejects(
    () => synthesize({ text: 'x', http: httpConfig('http://127.0.0.1:1/tts', { timeoutMs: 2000 }) }),
    /TTS_UNREACHABLE|failed/,
  )
})

test('the cache is bounded, recency-ordered, and switchable off', () => {
  const cache = new TtsCache(2)
  const clip = (value) => ({ audio: Buffer.from(value), contentType: 'audio/mpeg' })
  cache.set('a', clip('a'))
  cache.set('b', clip('b'))
  assert.equal(cache.size, 2)
  // Touching 'a' makes 'b' the eviction candidate.
  assert.equal(cache.get('a').audio.toString(), 'a')
  cache.set('c', clip('c'))
  assert.equal(cache.get('b'), undefined)
  assert.equal(cache.get('a').audio.toString(), 'a')

  const off = new TtsCache(0)
  off.set('a', clip('a'))
  assert.equal(off.size, 0)
  assert.equal(off.get('a'), undefined)
})

test('the bridge serves provider audio and reports provider failures', async () => {
  const audio = wavBytes(12)
  const calls = []
  const bridge = new PetBridge({
    host: '127.0.0.1',
    port: 0,
    token: 'tts-token',
    onTts: async ({ text }) => {
      calls.push(text)
      if (text === 'boom') throw new TtsError('provider said no', { code: 'TTS_FAILED', status: 500 })
      return { audio, contentType: 'audio/mpeg' }
    },
  })
  const port = await bridge.start()
  try {
    const base = `http://127.0.0.1:${port}`
    assert.equal((await fetch(`${base}/api/tts`, { method: 'POST', body: '{"text":"hi"}' })).status, 403)

    const ok = await fetch(`${base}/api/tts?token=tts-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '你好' }),
    })
    assert.equal(ok.status, 200)
    assert.equal(ok.headers.get('content-type'), 'audio/mpeg')
    assert.deepEqual(Buffer.from(await ok.arrayBuffer()), audio)
    assert.deepEqual(calls, ['你好'])

    const failed = await fetch(`${base}/api/tts?token=tts-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'boom' }),
    })
    assert.equal(failed.status, 502)
    assert.match((await failed.json()).error, /provider said no/)

    const empty = await fetch(`${base}/api/tts?token=tts-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '   ' }),
    })
    assert.equal(empty.status, 400)
  } finally {
    await bridge.stop()
  }
})

test('the bridge says so when no provider is wired at all', async () => {
  const bridge = new PetBridge({ host: '127.0.0.1', port: 0, token: 't', onMessage: async () => ({}) })
  const port = await bridge.start()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/tts?token=t`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x' }),
    })
    assert.equal(response.status, 200)
    assert.match((await response.json()).error, /not available/)
  } finally {
    await bridge.stop()
  }
})

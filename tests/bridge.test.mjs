/**
 * The loopback bridge: static pet assets, the per-boot token gate, the SSE push
 * channel, and the pet's inbound API.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PetBridge, resolveStaticPath, PET_ROOT } from '../src/bridge.js'

/** Start a bridge on an OS-assigned port and tear it down after the test. */
async function withBridge(run, options = {}) {
  const messages = []
  const clientEvents = []
  const bridge = new PetBridge({
    host: '127.0.0.1',
    port: 0,
    token: options.token ?? 'test-token',
    snapshot: () => ({ sessionId: 'session-1', voice: { enabled: true } }),
    onMessage: async (payload) => {
      messages.push(payload)
      return { sessionId: 'session-1', messageId: 'm1' }
    },
    onClientEvent: event => clientEvents.push(event),
    onAsr: options.onAsr,
    log: () => {},
  })
  const port = await bridge.start()
  try {
    await run({ bridge, port, messages, clientEvents, base: `http://127.0.0.1:${port}` })
  } finally {
    await bridge.stop()
  }
}

test('serves the pet document with the boot payload injected', async () => {
  await withBridge(async ({ base }) => {
    const response = await fetch(`${base}/pet/`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /text\/html/)
    const body = await response.text()
    assert.ok(!body.includes('<!--WHALE_PET_BOOT-->'), 'the marker is replaced')
    const match = body.match(/<script type="application\/json" id="whale-pet-boot">([\s\S]*?)<\/script>/)
    assert.ok(match !== null, 'the boot payload is present')
    const payload = JSON.parse(match[1])
    assert.equal(payload.token, 'test-token')
    assert.equal(payload.state.sessionId, 'session-1')
  })
})

test('the document is served without an inline executable script', async () => {
  await withBridge(async ({ base }) => {
    const body = await (await fetch(`${base}/pet/`)).text()
    // The page ships a strict CSP; an inline <script> would be blocked by it.
    assert.ok(!/<script>(?!<\/script>)/u.test(body.replace(/<script type="application\/json"[\s\S]*?<\/script>/gu, '')))
  })
})

test('serves static assets with the right content type', async () => {
  await withBridge(async ({ base }) => {
    const css = await fetch(`${base}/pet/pet.css`)
    assert.equal(css.status, 200)
    assert.match(css.headers.get('content-type'), /text\/css/)
    const js = await fetch(`${base}/pet/pet.js`)
    assert.match(js.headers.get('content-type'), /javascript/)
    const svg = await fetch(`${base}/pet/assets/whale/whale-girl.svg`)
    assert.equal(svg.status, 200)
    assert.match(svg.headers.get('content-type'), /image\/svg\+xml/)
  })
})

test('unknown assets and escapes are refused', async () => {
  await withBridge(async ({ base }) => {
    assert.equal((await fetch(`${base}/pet/nope.js`)).status, 404)
    assert.equal((await fetch(`${base}/pet/%2e%2e%2f%2e%2e%2fpackage.json`)).status, 403)
    assert.equal((await fetch(`${base}/etc/passwd`)).status, 403)
    assert.equal(resolveStaticPath('/pet/../index.js'), undefined)
    assert.equal(resolveStaticPath('/other/pet.js'), undefined)
    assert.equal(resolveStaticPath('/pet/assets/whale/whale-girl.svg'), `${PET_ROOT}\\assets\\whale\\whale-girl.svg`)
  })
})

test('the api rejects a missing or wrong token', async () => {
  await withBridge(async ({ base }) => {
    assert.equal((await fetch(`${base}/api/state`)).status, 403)
    assert.equal((await fetch(`${base}/api/state?token=wrong`)).status, 403)
    const ok = await fetch(`${base}/api/state?token=test-token`)
    assert.equal(ok.status, 200)
    const payload = await ok.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.value.sessionId, 'session-1')
  })
})

test('the token may ride a header instead of the query', async () => {
  await withBridge(async ({ base }) => {
    const response = await fetch(`${base}/api/state`, { headers: { 'x-whale-pet-token': 'test-token' } })
    assert.equal(response.status, 200)
  })
})

test('a posted message reaches the host sink', async () => {
  await withBridge(async ({ base, messages }) => {
    const response = await fetch(`${base}/api/message?token=test-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '  你好  ', source: 'voice' }),
    })
    const payload = await response.json()
    assert.equal(payload.ok, true)
    assert.deepEqual(messages, [{ text: '你好', source: 'voice' }])
  })
})

test('an empty message is refused, a host failure is reported as a value', async () => {
  const bridge = new PetBridge({
    host: '127.0.0.1',
    port: 0,
    token: 't',
    onMessage: async () => {
      throw new Error('no session')
    },
  })
  const port = await bridge.start()
  try {
    const empty = await fetch(`http://127.0.0.1:${port}/api/message?token=t`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '   ' }),
    })
    assert.equal(empty.status, 400)
    const failed = await fetch(`http://127.0.0.1:${port}/api/message?token=t`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    })
    const payload = await failed.json()
    assert.equal(failed.status, 200)
    assert.equal(payload.ok, false)
    assert.match(payload.error, /no session/)
  } finally {
    await bridge.stop()
  }
})

test('client lifecycle events reach the host sink', async () => {
  await withBridge(async ({ base, clientEvents }) => {
    await fetch(`${base}/api/client?token=test-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'ready' }),
    })
    assert.deepEqual(clientEvents, [{ type: 'ready' }])
  })
})

test('asr is optional and reports its absence as a value', async () => {
  await withBridge(async ({ base }) => {
    const response = await fetch(`${base}/api/asr?token=test-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audioBase64: 'AAAA' }),
    })
    const payload = await response.json()
    assert.equal(payload.ok, false)
    assert.match(payload.error, /ASR/)
  })
})

test('asr hands decoded bytes to the host recogniser', async () => {
  const seen = []
  await withBridge(async ({ base }) => {
    const response = await fetch(`${base}/api/asr?token=test-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audioBase64: Buffer.from('RIFF____').toString('base64'), lang: 'zh-CN' }),
    })
    const payload = await response.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.value.text, '你好')
  }, {
    onAsr: async ({ audio, lang }) => {
      seen.push({ length: audio.length, lang, head: audio.subarray(0, 4).toString('ascii') })
      return { text: '你好' }
    },
  })
  assert.deepEqual(seen, [{ length: 8, lang: 'zh-CN', head: 'RIFF' }])
})

test('publish reaches a connected event stream and replays to a late one', async () => {
  await withBridge(async ({ base, bridge }) => {
    const controller = new AbortController()
    const response = await fetch(`${base}/api/events?token=test-token`, { signal: controller.signal })
    assert.equal(response.status, 200)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    // The stream opens with a comment, then replayed history, then live frames.
    assert.equal(bridge.publish('reply', { text: 'first' }), true)
    let text = ''
    while (!text.includes('first')) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    assert.match(text, /"type":"reply"/)
    assert.match(text, /"text":"first"/)
    controller.abort()
    await new Promise(resolve => setTimeout(resolve, 20))
    // A window that connects later still learns the last thing that happened.
    const late = await fetch(`${base}/api/events?token=test-token`)
    const lateReader = late.body.getReader()
    const lateText = decoder.decode((await lateReader.read()).value ?? new Uint8Array(), { stream: true })
    assert.match(lateText, /"text":"first"/)
    await lateReader.cancel()
  })
})

test('publishing with no connected window reports false', async () => {
  await withBridge(async ({ bridge }) => {
    assert.equal(bridge.publish('mood', { mood: 'happy' }), false)
  })
})

test('a busy fixed port falls back to an OS-assigned one', async () => {
  const first = new PetBridge({ host: '127.0.0.1', port: 0, token: 'a', onMessage: async () => ({}) })
  const port = await first.start()
  const second = new PetBridge({ host: '127.0.0.1', port, token: 'b', onMessage: async () => ({}) })
  try {
    const fallback = await second.start()
    assert.notEqual(fallback, port)
    assert.equal((await fetch(`http://127.0.0.1:${fallback}/api/state?token=b`)).status, 200)
  } finally {
    await second.stop()
    await first.stop()
  }
})

test('the url carries the token so the launcher can hand it to a window', async () => {
  await withBridge(async ({ bridge }) => {
    assert.match(bridge.petUrl, /^http:\/\/127\.0\.0\.1:\d+\/pet\/\?token=test-token$/)
    assert.equal(bridge.clientCount, 0)
  })
})

/**
 * Configuration resolution: defaults, per-section merges, loud validation, and
 * the environment overrides a deployment can use.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConfigError, DEFAULT_CONFIG, resolveConfig } from '../src/config.js'

test('an empty config yields the frozen defaults', () => {
  const config = resolveConfig(undefined, {})
  assert.equal(config.port, DEFAULT_CONFIG.port)
  assert.equal(config.window.corner, 'bottom-right')
  assert.equal(config.voice.lang, 'zh-CN')
  assert.equal(config.tools.input, true)
  assert.ok(Object.isFrozen(config))
  assert.ok(Object.isFrozen(config.window))
  assert.ok(Object.isFrozen(config.launcherArgs))
})

test('scalar and nested values merge over the defaults', () => {
  const config = resolveConfig({ port: 5000, voice: { rate: 1.5 }, window: { corner: 'top-left' } }, {})
  assert.equal(config.port, 5000)
  assert.equal(config.voice.rate, 1.5)
  // Keys the caller omitted keep their defaults.
  assert.equal(config.voice.pitch, DEFAULT_CONFIG.voice.pitch)
  assert.equal(config.window.corner, 'top-left')
  assert.equal(config.window.width, DEFAULT_CONFIG.window.width)
})

test('unknown keys and mistyped values fail loudly', () => {
  assert.throws(() => resolveConfig({ nope: 1 }, {}), ConfigError)
  assert.throws(() => resolveConfig({ port: 'abc' }, {}), ConfigError)
  assert.throws(() => resolveConfig({ voice: { rate: 'fast' } }, {}), ConfigError)
  assert.throws(() => resolveConfig({ voice: { nope: true } }, {}), ConfigError)
  assert.throws(() => resolveConfig({ window: 3 }, {}), ConfigError)
  assert.throws(() => resolveConfig('port', {}), ConfigError)
})

test('out-of-range numbers are clamped rather than rejected', () => {
  const config = resolveConfig({
    window: { width: 10, height: 99999, opacity: 3 },
    voice: { rate: 99, pitch: -4, volume: 9, maxChars: 1 },
    helperTimeoutMs: 1,
  }, {})
  assert.equal(config.window.width, 160)
  assert.equal(config.window.height, 1200)
  assert.equal(config.window.opacity, 1)
  assert.equal(config.voice.rate, 2)
  assert.equal(config.voice.pitch, 0.5)
  assert.equal(config.voice.volume, 1)
  assert.equal(config.voice.maxChars, 40)
  assert.equal(config.helperTimeoutMs, 1000)
})

test('the bridge may only bind a loopback address', () => {
  assert.throws(() => resolveConfig({ host: '0.0.0.0' }, {}), ConfigError)
  assert.equal(resolveConfig({ host: 'localhost' }, {}).host, 'localhost')
})

test('a pinned session requires an id', () => {
  assert.throws(() => resolveConfig({ session: { mode: 'pinned' } }, {}), ConfigError)
  const config = resolveConfig({ session: { mode: 'pinned', id: 'session-1' } }, {})
  assert.equal(config.session.id, 'session-1')
})

test('environment overrides apply only when the row is silent', () => {
  assert.equal(resolveConfig(undefined, { DSH_WHALE_PET_PORT: '6000' }).port, 6000)
  assert.equal(resolveConfig({ port: 1234 }, { DSH_WHALE_PET_PORT: '6000' }).port, 1234)
  assert.throws(() => resolveConfig(undefined, { DSH_WHALE_PET_PORT: 'nope' }), ConfigError)
  assert.equal(resolveConfig(undefined, { DSH_WHALE_PET_DISABLE: '1' }).enabled, false)
  assert.equal(resolveConfig(undefined, { DSH_WHALE_PET_AUTOLAUNCH: '0' }).autoLaunch, false)
})

test('launcher arguments must be strings', () => {
  assert.throws(() => resolveConfig({ launcherArgs: [1] }, {}), ConfigError)
  assert.deepEqual(resolveConfig({ launcherArgs: ['--flag'] }, {}).launcherArgs, ['--flag'])
})

test('the speech engine defaults to the window and validates its provider', () => {
  const plain = resolveConfig(undefined, {})
  assert.equal(plain.voice.engine, 'browser')
  assert.equal(plain.voice.http.url, '')
  assert.equal(plain.voice.http.method, 'POST')

  assert.throws(() => resolveConfig({ voice: { engine: 'cloud' } }, {}), ConfigError)
  // An http engine without an endpoint can never speak, so it fails at load
  // rather than leaving the window silent.
  assert.throws(() => resolveConfig({ voice: { engine: 'http' } }, {}), /voice\.http\.url is required/)

  const http = resolveConfig({ voice: { engine: 'http', http: { url: 'http://127.0.0.1:9880/tts', format: 'wav' } } }, {})
  assert.equal(http.voice.engine, 'http')
  assert.equal(http.voice.http.format, 'wav')
  // Keys the caller omitted keep their defaults, including inside the section.
  assert.equal(http.voice.http.method, 'POST')
  assert.equal(http.voice.http.timeoutMs, 30000)
  assert.ok(Object.isFrozen(http.voice.http))
})

test('provider headers are a free-form map, not a fixed section', () => {
  // Regression: `headers` used to be treated as a nested section, so every header
  // the user actually needs — content-type, authorization — was rejected as an
  // unknown key. A legitimate provider config could not be written at all.
  const config = resolveConfig({
    voice: {
      engine: 'http',
      http: {
        url: 'https://api.example.com/tts',
        headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
      },
    },
  }, {})
  assert.deepEqual(config.voice.http.headers, {
    'content-type': 'application/json',
    authorization: 'Bearer secret',
  })
  assert.ok(Object.isFrozen(config.voice.http.headers))
  // Values are still checked, just where the map is interpreted.
  assert.throws(
    () => resolveConfig({ voice: { http: { headers: { authorization: 7 } } } }, {}),
    /headers\.authorization must be a string/,
  )
})

test('the provider section rejects bad shapes loudly', () => {
  const base = { voice: { engine: 'http', http: { url: 'http://x' } } }
  assert.throws(() => resolveConfig({ voice: { http: { method: 'PUT' } } }, {}), /method must be GET or POST/)
  assert.throws(() => resolveConfig({ voice: { http: { audioEncoding: 'hex' } } }, {}), /audioEncoding/)
  assert.throws(() => resolveConfig({ voice: { http: { headers: { authorization: 1 } } } }, {}), /headers\.authorization/)
  assert.throws(() => resolveConfig({ voice: { http: { nope: 1 } } }, {}), /unknown key voice\.http\.nope/)
  assert.throws(() => resolveConfig({ voice: { nope: 1 } }, {}), /unknown key voice\.nope/)
  assert.equal(resolveConfig(base, {}).voice.http.method, 'POST')
  // Values are clamped rather than rejected, and lower-case verbs are normalized.
  const normalized = resolveConfig({ voice: { engine: 'http', http: { url: 'http://x', method: 'get', timeoutMs: 10, cacheEntries: 9999 } } }, {})
  assert.equal(normalized.voice.http.method, 'GET')
  assert.equal(normalized.voice.http.timeoutMs, 1000)
  assert.equal(normalized.voice.http.cacheEntries, 512)
})
